import asyncio
import socket
import sys
from pathlib import Path
import pytest
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "sdk" / "python"))
from dsh_capsule.broker.providers import ProviderRegistry
from dsh_capsule.broker.server import BrokerServer
from dsh_capsule.capsule.instance import CapsuleInstance
from dsh_capsule.capsule.manifest import CapsuleManifest, CredentialRequest, ManifestMetadata, RuntimeSpec
from dsh_capsule.lease.models import CapabilityLease
from dsh_capsule_sdk.broker import BrokerClient
requires_af_unix = pytest.mark.skipif(not hasattr(socket, "AF_UNIX"), reason="requires AF_UNIX (Linux/WSL2)")
def _manifest() -> CapsuleManifest:
    # 作用：声明 github/issues.read 的合法 manifest
    return CapsuleManifest(
        apiVersion="dsh-capsule/v1", kind="Capsule",
        metadata=ManifestMetadata(id="github-reader", version="0.1.0"),
        runtime=RuntimeSpec(image="img:0.1", command=["python", "/app/app.py"]),
        credentials=[CredentialRequest(provider="github", credential_ref="GITHUB_TOKEN", allowed_actions=["issues.read"], default_ttl_seconds=600, max_ttl_seconds=1800)],
    )
def _lease() -> CapabilityLease:
    # 作用：已签发的 ACTIVE Lease 桩数据
    return CapabilityLease(id="L1", capsule_id="github-reader", capsule_instance_id="inst-1", session_id="S100", provider="github", resource="repo:foo/bar", actions={"issues.read"}, issued_at=1.0, expires_at=99999.0)
class StubGateway:
    def __init__(self, lease: CapabilityLease | None = None):
        # 作用：记录签发请求的 LeaseGateway 桩
        self.calls: list[dict] = []
        self._lease = lease
    async def request(self, **kwargs):
        # 作用：记录参数并返回桩 Lease
        self.calls.append(kwargs)
        return self._lease
class StubResolver:
    def __init__(self, value: str = "ghp_token"):
        # 作用：固定返回值的凭据桩
        self.refs: list[str] = []
        self._value = value
    async def resolve(self, ref: str) -> str:
        # 作用：记录 ref 并返回固定值
        self.refs.append(ref)
        return self._value
class StubProvider:
    def __init__(self, name: str = "github", result: dict | None = None):
        # 作用：记录 execute 参数的 Provider 桩
        self.name = name
        self.execs: list[dict] = []
        self._result = result or {"number": 10}
    async def execute(self, *, credential: str, action: str, resource: str, payload: dict) -> dict:
        # 作用：记录参数并返回结果
        self.execs.append({"credential": credential, "action": action, "resource": resource, "payload": payload})
        return self._result
async def _make_server(tmp_path) -> tuple[BrokerServer, StubGateway, StubProvider]:
    # 作用：在临时 IPC 目录启动真实 BrokerServer（监听 broker.sock）并返回桩组件
    instance = CapsuleInstance(capsule_id="github-reader", instance_id="inst-1")
    instance.ipc_dir = tmp_path
    gateway = StubGateway(lease=_lease())
    provider = StubProvider()
    providers = ProviderRegistry()
    providers.register(provider)
    server = BrokerServer(_manifest(), instance, gateway, StubResolver(), providers)
    await server.start()
    return server, gateway, provider
@requires_af_unix
def test_sdk_client_full_round_trip(tmp_path):
    # 作用：真实 UDS 回环（规格第 25/33 节）——SDK BrokerClient 经 broker.sock 调用 BrokerServer，
    # 全链路（manifest 校验→Lease→凭据→Provider）返回结果；session 上下文由宿主设置
    async def scenario() -> None:
        server, gateway, provider = await _make_server(tmp_path)
        try:
            server.begin_call("S100", "github_get_issue")
            result = await BrokerClient(str(tmp_path / "broker.sock")).call(provider="github", action="issues.read", resource="repo:foo/bar", payload={"repo": "foo/bar", "issue_number": 10})
            assert result == {"number": 10}
            assert gateway.calls[0]["session_id"] == "S100"
            assert provider.execs[0]["credential"] == "ghp_token"
        finally:
            server.end_call()
            await server.stop()
    asyncio.run(scenario())
@requires_af_unix
def test_sdk_client_receives_unified_error_code(tmp_path):
    # 作用：越权 action 经 UDS 回传统一错误码 CAPABILITY_DENIED（规格第 27/28 节）
    async def scenario() -> None:
        server, gateway, _ = await _make_server(tmp_path)
        try:
            server.begin_call("S100", "github_get_issue")
            client = BrokerClient(str(tmp_path / "broker.sock"))
            try:
                await client.call(provider="github", action="repo.delete", resource="repo:foo/bar", payload={})
                raise AssertionError("expected CAPABILITY_DENIED")
            except RuntimeError as exc:
                assert "CAPABILITY_DENIED" in str(exc)
            assert gateway.calls == []
        finally:
            server.end_call()
            await server.stop()
    asyncio.run(scenario())
@requires_af_unix
def test_sdk_client_denied_without_session(tmp_path):
    # 作用：宿主未设置 session 上下文（begin_call 未调用）即 LEASE_REQUIRED（Fail Closed）
    async def scenario() -> None:
        server, _, _ = await _make_server(tmp_path)
        try:
            client = BrokerClient(str(tmp_path / "broker.sock"))
            try:
                await client.call(provider="github", action="issues.read", resource="repo:foo/bar", payload={"repo": "foo/bar", "issue_number": 1})
                raise AssertionError("expected LEASE_REQUIRED")
            except RuntimeError as exc:
                assert "LEASE_REQUIRED" in str(exc)
        finally:
            await server.stop()
    asyncio.run(scenario())
