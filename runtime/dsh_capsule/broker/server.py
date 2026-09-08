import asyncio
import json
from dsh_capsule.broker.credentials import CredentialResolver
from dsh_capsule.broker.errors import BrokerError
from dsh_capsule.broker.policy import BrokerPolicy
from dsh_capsule.broker.providers import ProviderRegistry
from dsh_capsule.capsule.docker_backend import enforce_response_limit
from dsh_capsule.capsule.instance import CapsuleInstance
from dsh_capsule.capsule.manifest import CapsuleManifest
from dsh_capsule.lease.gateway import LeaseGateway
from dsh_capsule.lease.models import LeaseError
PROVIDER_TIMEOUT_SECONDS = 15.0
class BrokerServer:
    def __init__(self, manifest: CapsuleManifest, instance: CapsuleInstance, gateway: LeaseGateway, resolver: CredentialResolver, providers: ProviderRegistry, provider_timeout: float = PROVIDER_TIMEOUT_SECONDS):
        # 作用：实例独享 Broker（规格第 22/23/34 节）——监听 broker.sock 接收容器内受控能力请求，
        # 策略校验后走 Lease 签发→凭据解析→Provider 执行链路；策略不写死在 Socket Handler 内
        self._manifest = manifest
        self._instance = instance
        self._gateway = gateway
        self._resolver = resolver
        self._providers = providers
        self._provider_timeout = provider_timeout
        self._server: asyncio.AbstractServer | None = None
        self._session_id: str | None = None
        self._tool_name: str | None = None
    @property
    def broker_sock_path(self) -> str:
        # 作用：本实例 broker.sock 路径（位于独享 IPC 目录，仅当前实例容器可见）
        return str(self._instance.ipc_dir / "broker.sock")
    def begin_call(self, session_id: str | None, tool_name: str | None) -> None:
        # 作用：由可信 Runtime 在 tool.invoke 期间设置调用上下文——容器不可信，session 身份只能来自宿主侧（规格第 24 节）
        self._session_id = session_id
        self._tool_name = tool_name
    def end_call(self) -> None:
        # 作用：清除调用上下文，防止跨调用残留（配合 Manager 的同实例串行锁）
        self._session_id = None
        self._tool_name = None
    async def start(self) -> None:
        # 作用：在独享 IPC 目录监听 broker.sock，等待容器内 SDK 连入
        self._server = await asyncio.start_unix_server(self._handle_conn, path=self.broker_sock_path)
    async def stop(self) -> None:
        # 作用：关闭监听并断开全部连接；IPC 目录由 DockerBackend 统一回收
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
    async def _handle_conn(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        # 作用：处理容器连接——逐行读取 NDJSON broker.call 请求并回写响应；全程不打印任何请求内容（Secret 安全）
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError as exc:
                    await self._write(writer, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"parse error: {exc}"}})
                    continue
                await self._write(writer, await self._dispatch(msg))
        finally:
            writer.close()
    async def _dispatch(self, msg: dict) -> dict:
        # 作用：分发单条请求：仅支持 broker.call；BrokerError/LeaseError 统一携带 data.code（规格第 28 节错误码）
        msg_id = msg.get("id")
        try:
            if msg.get("method") != "broker.call":
                raise BrokerError("BROKER_PROTOCOL_ERROR", f"unsupported method: {msg.get('method')}")
            result = await self.handle_call(msg.get("params") or {})
            return {"jsonrpc": "2.0", "id": msg_id, "result": result}
        except (BrokerError, LeaseError) as exc:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32000, "message": str(exc), "data": {"code": exc.code}}}
        except Exception as exc:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32000, "message": str(exc), "data": {"code": "BROKER_PROTOCOL_ERROR"}}}
    async def handle_call(self, params: dict) -> dict:
        # 作用：单次 Broker 请求核心链路（规格第 23 节）——参数校验→manifest 声明校验→session 校验→
        # Lease 签发（复用/授权）→Provider 定位→凭据 per-operation resolve→Provider 执行（15s 超时）→响应 2MB 上限；
        # Secret 不进日志/持久化/结果/异常（Fail Closed）
        provider = params.get("provider")
        action = params.get("action")
        resource = params.get("resource")
        payload = params.get("payload") or {}
        if not isinstance(provider, str) or not isinstance(action, str) or not isinstance(resource, str) or not resource:
            raise BrokerError("BROKER_PROTOCOL_ERROR", "invalid broker.call params")
        if not isinstance(payload, dict):
            raise BrokerError("BROKER_PROTOCOL_ERROR", "payload must be an object")
        cred = BrokerPolicy.check(self._manifest, provider, action)
        if not self._session_id:
            raise BrokerError("LEASE_REQUIRED", "session identity required")
        lease = await self._gateway.request(
            capsule_id=self._manifest.metadata.id, capsule_instance_id=self._instance.instance_id,
            session_id=self._session_id, provider=provider, resource=resource, action=action,
            ttl_seconds=cred.default_ttl_seconds, tool_name=self._tool_name,
        )
        adapter = self._providers.get(provider)
        if adapter is None:
            raise BrokerError("PROVIDER_NOT_FOUND", f"provider not registered: {provider}")
        credential = await self._resolver.resolve(cred.credential_ref)
        try:
            result = await asyncio.wait_for(adapter.execute(credential=credential, action=action, resource=resource, payload=payload), self._provider_timeout)
        except asyncio.TimeoutError as exc:
            raise BrokerError("PROVIDER_TIMEOUT", f"provider timed out after {self._provider_timeout}s") from exc
        except BrokerError:
            raise
        except Exception as exc:
            raise BrokerError("PROVIDER_ERROR", "provider request failed") from exc
        enforce_response_limit(json.dumps(result, ensure_ascii=False).encode("utf-8"))
        return result
    async def _write(self, writer: asyncio.StreamWriter, msg: dict) -> None:
        # 作用：序列化单行 NDJSON 响应并刷写
        writer.write((json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8"))
        await writer.drain()
