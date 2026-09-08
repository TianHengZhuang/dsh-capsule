import asyncio
import json
import pytest
from dsh_capsule.broker.errors import BrokerError
from dsh_capsule.broker.providers import ProviderRegistry
from dsh_capsule.broker.server import BrokerServer
from dsh_capsule.capsule.instance import CapsuleInstance
from dsh_capsule.capsule.manifest import CapsuleManifest, CredentialRequest, ManifestMetadata, RuntimeSpec
from dsh_capsule.lease.models import CapabilityLease, LeaseError
TOKEN = "ghp_super_secret_value"
def _manifest() -> CapsuleManifest:
    # 作用：声明 github/issues.read 的合法 manifest（credential_ref=GITHUB_TOKEN，默认 TTL 600）
    return CapsuleManifest(
        apiVersion="dsh-capsule/v1", kind="Capsule",
        metadata=ManifestMetadata(id="github-reader", version="0.1.0"),
        runtime=RuntimeSpec(image="img:0.1", command=["python", "/app/app.py"]),
        credentials=[CredentialRequest(provider="github", credential_ref="GITHUB_TOKEN", allowed_actions=["issues.read"], default_ttl_seconds=600, max_ttl_seconds=1800)],
    )
def _lease() -> CapabilityLease:
    # 作用：构造一个已签发的 ACTIVE Lease 桩数据
    return CapabilityLease(id="L1", capsule_id="github-reader", capsule_instance_id="inst-1", session_id="S100", provider="github", resource="repo:foo/bar", actions={"issues.read"}, issued_at=1.0, expires_at=99999.0)
class StubGateway:
    def __init__(self, lease: CapabilityLease | None = None, error: Exception | None = None):
        # 作用：记录签发请求的 LeaseGateway 桩；可注入已签发 Lease 或异常（如 LeaseError）
        self.calls: list[dict] = []
        self._lease = lease
        self._error = error
    async def request(self, **kwargs):
        # 作用：记录一次完整签发参数并按注入行为返回或抛错
        self.calls.append(kwargs)
        if self._error is not None:
            raise self._error
        return self._lease
class StubResolver:
    def __init__(self, value: str = TOKEN, error: Exception | None = None):
        # 作用：记录 resolve 调用的凭据桩；可注入异常（如 CREDENTIAL_NOT_CONFIGURED）
        self.refs: list[str] = []
        self._value = value
        self._error = error
    async def resolve(self, ref: str) -> str:
        # 作用：记录 ref 并按注入行为返回或抛错
        self.refs.append(ref)
        if self._error is not None:
            raise self._error
        return self._value
class StubProvider:
    name = "github"
    def __init__(self, result: dict | None = None, error: Exception | None = None, delay: float = 0.0):
        # 作用：记录 execute 参数的 Provider 桩；可注入结果/异常/延迟（测超时）
        self.execs: list[dict] = []
        self._result = result
        self._error = error
        self._delay = delay
    async def execute(self, *, credential: str, action: str, resource: str, payload: dict) -> dict:
        # 作用：记录一次受控执行并按注入行为返回/抛错/延迟
        self.execs.append({"credential": credential, "action": action, "resource": resource, "payload": payload})
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._error is not None:
            raise self._error
        return self._result
def _server(gateway, resolver, provider=None, provider_timeout=15.0, instance_id="inst-1") -> BrokerServer:
    # 作用：组装被测 BrokerServer（真实 manifest + 桩网关/解析器/注册表）
    providers = ProviderRegistry()
    if provider is not None:
        providers.register(provider)
    return BrokerServer(_manifest(), CapsuleInstance(capsule_id="github-reader", instance_id=instance_id), gateway, resolver, providers, provider_timeout=provider_timeout)
CALL_PARAMS = {"provider": "github", "action": "issues.read", "resource": "repo:foo/bar", "payload": {"repo": "foo/bar", "issue_number": 10}}
def _call(server: BrokerServer, params: dict | None = None, session_id: str | None = "S100") -> dict:
    # 作用：设置调用上下文后执行一次 handle_call（session 身份来自宿主侧，容器不可提供）
    server.begin_call(session_id, "github_get_issue")
    try:
        return asyncio.run(server.handle_call(params or CALL_PARAMS))
    finally:
        server.end_call()
def test_happy_path_full_chain():
    # 作用：完整链路（规格第 23 节）——manifest 校验→Lease 签发（TTL 取 manifest 声明）→凭据 resolve→Provider 执行→结果返回
    gateway = StubGateway(lease=_lease())
    resolver = StubResolver()
    provider = StubProvider(result={"number": 10, "title": "T"})
    result = _call(_server(gateway, resolver, provider))
    assert result == {"number": 10, "title": "T"}
    assert gateway.calls[0]["session_id"] == "S100"
    assert gateway.calls[0]["capsule_instance_id"] == "inst-1"
    assert gateway.calls[0]["ttl_seconds"] == 600
    assert gateway.calls[0]["tool_name"] == "github_get_issue"
    assert resolver.refs == ["GITHUB_TOKEN"]
    assert provider.execs[0]["credential"] == TOKEN
def test_unauthorized_action_denied_before_approval():
    # 作用：manifest 未声明的越权 action（repo.delete）即 CAPABILITY_DENIED，且绝不进入授权流程（gateway 无调用，规格第 27 节）
    gateway = StubGateway(lease=_lease())
    server = _server(gateway, StubResolver(), StubProvider())
    with pytest.raises(BrokerError, match="CAPABILITY_DENIED"):
        _call(server, {**CALL_PARAMS, "action": "repo.delete"})
    assert gateway.calls == []
def test_missing_session_identity_denied():
    # 作用：宿主侧无 session 身份（无法确定 Session）即 LEASE_REQUIRED（Fail Closed，规格第 29 节）
    gateway = StubGateway(lease=_lease())
    server = _server(gateway, StubResolver(), StubProvider())
    with pytest.raises(BrokerError, match="LEASE_REQUIRED"):
        _call(server, session_id=None)
    assert gateway.calls == []
def test_approval_rejection_propagates():
    # 作用：宿主授权被拒（LEASE_REJECTED）原样透传给容器，不再 resolve 凭据、不执行 Provider
    gateway = StubGateway(error=LeaseError("LEASE_REJECTED", "user denied"))
    resolver = StubResolver()
    provider = StubProvider()
    with pytest.raises(LeaseError, match="LEASE_REJECTED"):
        _call(_server(gateway, resolver, provider))
    assert resolver.refs == []
    assert provider.execs == []
def test_provider_not_registered():
    # 作用：Provider 未注册即 PROVIDER_NOT_FOUND（发生在 Lease 签发之后，规格第 23 节流程顺序）
    gateway = StubGateway(lease=_lease())
    with pytest.raises(BrokerError, match="PROVIDER_NOT_FOUND"):
        _call(_server(gateway, StubResolver(), provider=None))
    assert len(gateway.calls) == 1
def test_credential_failure_denied():
    # 作用：凭据 resolve 失败即 CREDENTIAL_NOT_CONFIGURED 透传，不执行 Provider
    gateway = StubGateway(lease=_lease())
    resolver = StubResolver(error=RuntimeError("CREDENTIAL_NOT_CONFIGURED: empty value for GITHUB_TOKEN"))
    provider = StubProvider()
    with pytest.raises(RuntimeError, match="CREDENTIAL_NOT_CONFIGURED"):
        _call(_server(gateway, resolver, provider))
    assert provider.execs == []
def test_provider_broker_error_propagates():
    # 作用：Provider 抛 BrokerError（如 PROVIDER_ERROR）时错误码原样透传
    gateway = StubGateway(lease=_lease())
    provider = StubProvider(error=BrokerError("PROVIDER_ERROR", "github status 403"))
    with pytest.raises(BrokerError, match="PROVIDER_ERROR"):
        _call(_server(gateway, StubResolver(), provider))
def test_provider_crash_maps_provider_error():
    # 作用：Provider 崩溃（普通异常）统一映射 PROVIDER_ERROR，不泄露内部细节
    gateway = StubGateway(lease=_lease())
    provider = StubProvider(error=ValueError("boom with internal detail"))
    with pytest.raises(BrokerError, match="PROVIDER_ERROR"):
        _call(_server(gateway, StubResolver(), provider))
def test_provider_timeout_denied():
    # 作用：Provider 执行超过 15s（测试注入 0.05s）即 PROVIDER_TIMEOUT（Fail Closed）
    gateway = StubGateway(lease=_lease())
    provider = StubProvider(result={}, delay=0.5)
    with pytest.raises(BrokerError, match="PROVIDER_TIMEOUT"):
        _call(_server(gateway, StubResolver(), provider, provider_timeout=0.05))
def test_oversized_provider_result_denied():
    # 作用：Provider 结果序列化超 2MB 上限即 CAPSULE_OUTPUT_TOO_LARGE（规格第 6 节响应上限）
    gateway = StubGateway(lease=_lease())
    provider = StubProvider(result={"payload": "x" * (3 * 1024 * 1024)})
    with pytest.raises(RuntimeError, match="CAPSULE_OUTPUT_TOO_LARGE"):
        _call(_server(gateway, StubResolver(), provider))
def test_invalid_params_denied():
    # 作用：broker.call 参数缺失/类型非法即 BROKER_PROTOCOL_ERROR，不触发任何后续链路
    gateway = StubGateway(lease=_lease())
    server = _server(gateway, StubResolver(), StubProvider())
    for bad in ({"provider": "github"}, {"provider": "github", "action": "issues.read", "resource": ""}, {**CALL_PARAMS, "payload": "not-object"}):
        with pytest.raises(BrokerError, match="BROKER_PROTOCOL_ERROR"):
            _call(server, bad)
    assert gateway.calls == []
def test_dispatch_maps_error_codes():
    # 作用：_dispatch 把 BrokerError/LeaseError 转为携带 data.code 的 JSON-RPC error；非法 method 即 BROKER_PROTOCOL_ERROR
    gateway = StubGateway(lease=_lease())
    server = _server(gateway, StubResolver(), StubProvider())
    resp = asyncio.run(server._dispatch({"jsonrpc": "2.0", "id": "b-1", "method": "broker.call", "params": {**CALL_PARAMS, "action": "repo.delete"}}))
    assert resp["id"] == "b-1"
    assert resp["error"]["data"]["code"] == "CAPABILITY_DENIED"
    resp2 = asyncio.run(server._dispatch({"jsonrpc": "2.0", "id": "b-2", "method": "other.method", "params": {}}))
    assert resp2["error"]["data"]["code"] == "BROKER_PROTOCOL_ERROR"
def test_dispatch_happy_path_returns_result():
    # 作用：_dispatch 正常路径返回 result 字段
    gateway = StubGateway(lease=_lease())
    provider = StubProvider(result={"number": 10})
    resp = asyncio.run(server_dispatch(gateway, provider))
    assert resp["result"] == {"number": 10}
async def server_dispatch(gateway, provider) -> dict:
    # 作用：异步执行一次 _dispatch 便于同步断言
    server = _server(gateway, StubResolver(), provider)
    server.begin_call("S100", "github_get_issue")
    return await server._dispatch({"jsonrpc": "2.0", "id": "b-1", "method": "broker.call", "params": CALL_PARAMS})
