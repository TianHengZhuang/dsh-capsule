import asyncio
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Callable
from dsh_capsule.capsule.docker_backend import DockerBackend
from dsh_capsule.capsule.instance import CapsuleInstance
from dsh_capsule.capsule.manifest import CapsuleManifest, load_manifest
if TYPE_CHECKING:
    from dsh_capsule.broker.server import BrokerServer
class CapsuleManager:
    def __init__(self, capsules_dir: Path | str, backend: DockerBackend | None = None, broker_factory: Callable[[CapsuleManifest, CapsuleInstance], "BrokerServer"] | None = None):
        # 作用：Capsule 生命周期管理——manifest 发现/校验、实例启动/复用、工具调用分发与 per-instance Broker 挂载
        self._backend = backend or DockerBackend()
        self._broker_factory = broker_factory
        self._manifests: dict[str, CapsuleManifest] = {}
        self._tool_owners: dict[str, CapsuleManifest] = {}
        self._instances: dict[str, CapsuleInstance] = {}
        self._broker_servers: dict[str, "BrokerServer"] = {}
        self._invoke_locks: dict[str, asyncio.Lock] = {}
        self._invoke_seq = 0
        self._discover(Path(capsules_dir))
    def _discover(self, capsules_dir: Path) -> None:
        # 作用：扫描 capsules/<id>/capsule.yaml；任一 manifest 非法直接抛异常（Fail Closed）
        if not capsules_dir.is_dir():
            raise RuntimeError(f"CAPSULE_NOT_FOUND: capsules dir missing: {capsules_dir}")
        for manifest_path in sorted(capsules_dir.glob("*/capsule.yaml")):
            manifest = load_manifest(manifest_path)
            if manifest.metadata.id in self._manifests:
                raise RuntimeError(f"CAPSULE_NOT_FOUND: duplicate capsule id: {manifest.metadata.id}")
            self._manifests[manifest.metadata.id] = manifest
            for tool in manifest.tools:
                self._tool_owners[tool.name] = manifest
    def list_tools(self) -> list[dict]:
        # 作用：聚合全部 Capsule 的工具 Schema（内部字段如 lease/credential 不对外暴露）
        return [
            {"name": tool.name, "description": tool.description, "parameters": tool.parameters, "capsule_id": manifest.metadata.id}
            for manifest in self._manifests.values()
            for tool in manifest.tools
        ]
    async def invoke(self, tool_name: str, args: dict, timeout: float | None = None, session_id: str | None = None) -> dict:
        # 作用：执行一次工具调用——定位所属 Capsule、确保实例健康、设置 Broker 调用上下文（session/tool）后经 UDS 下发 tool.invoke；
        # 同实例调用串行化保证 Broker 上下文可信；超时/协议错误/容器崩溃一律销毁实例（下次调用强制重建），防止病态实例继续服务（Fail Closed）
        manifest = self._tool_owners.get(tool_name)
        if manifest is None:
            raise RuntimeError(f"CAPSULE_NOT_FOUND: unknown tool: {tool_name}")
        capsule_id = manifest.metadata.id
        instance = await self._ensure_instance(manifest)
        server = self._broker_servers.get(capsule_id)
        lock = self._invoke_locks.setdefault(capsule_id, asyncio.Lock())
        self._invoke_seq += 1
        request = {"jsonrpc": "2.0", "id": f"capsule-{self._invoke_seq}", "method": "tool.invoke", "params": {"name": tool_name, "args": args or {}}}
        async with lock:
            if server is not None:
                server.begin_call(session_id, tool_name)
            try:
                return await self._backend.invoke(instance, request, timeout)
            except RuntimeError:
                await self._teardown_instance(capsule_id)
                raise
            finally:
                if server is not None:
                    server.end_call()
    async def _ensure_instance(self, manifest: CapsuleManifest) -> CapsuleInstance:
        # 作用：获取或启动指定 Capsule 的实例并挂载其专属 BrokerServer；已存在但不健康则重建
        capsule_id = manifest.metadata.id
        instance = self._instances.get(capsule_id)
        if instance is not None and await self._backend.health(instance):
            return instance
        if instance is not None:
            await self._teardown_instance(capsule_id)
        instance = await self._backend.start(manifest)
        self._instances[capsule_id] = instance
        if self._broker_factory is not None:
            server = self._broker_factory(manifest, instance)
            await server.start()
            self._broker_servers[capsule_id] = server
        return instance
    async def _teardown_instance(self, capsule_id: str) -> None:
        # 作用：回收实例的 BrokerServer 与容器及独享 IPC 目录
        server = self._broker_servers.pop(capsule_id, None)
        if server is not None:
            await server.stop()
        instance = self._instances.pop(capsule_id, None)
        if instance is not None:
            await self._backend.stop(instance)
    async def shutdown(self) -> None:
        # 作用：Runtime 退出时回收全部 BrokerServer 与容器及 IPC 目录
        for capsule_id in list(self._instances):
            await self._teardown_instance(capsule_id)
        self._invoke_locks.clear()
