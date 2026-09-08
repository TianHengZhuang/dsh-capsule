import asyncio
import pytest
from dsh_capsule.lease.approval import ApprovalClient
from dsh_capsule.lease.models import LeaseError
from dsh_capsule.rpc import RpcError
class FakeConn:
    def __init__(self, result=None, error: str | None = None, timeout: bool = False):
        # 作用：模拟反向 RPC 通道，记录调用供断言；可注入错误/超时
        self.calls: list[tuple[str, dict, float]] = []
        self._result = result
        self._error = error
        self._timeout = timeout
    async def call(self, method: str, params: dict | None = None, timeout: float = 30.0):
        # 作用：记录一次反向调用并按注入行为返回或抛错
        self.calls.append((method, params or {}, timeout))
        if self._timeout:
            raise asyncio.TimeoutError()
        if self._error is not None:
            raise RpcError(-32000, self._error)
        return self._result
BASE = {"capsule_id": "github-reader", "provider": "github", "resource": "repo:foo/bar", "action": "issues.read", "ttl_seconds": 600}
def _request(client: ApprovalClient, **overrides) -> None:
    asyncio.run(client.request_lease(**{**BASE, **overrides}))
def test_allowed_once_passes_and_sends_params():
    # 作用：宿主返回 allowed-once 即放行；验证反向调用方法名与参数（camelCase，不含任何 Secret）
    conn = FakeConn(result={"decision": "allowed-once"})
    _request(ApprovalClient(conn))
    assert conn.calls[0][0] == "host.approval.request_lease"
    assert conn.calls[0][1] == {"capsuleId": "github-reader", "provider": "github", "resource": "repo:foo/bar", "action": "issues.read", "ttlSeconds": 600}
def test_tool_name_optional():
    # 作用：toolName 非必填；传入时透传给宿主
    conn = FakeConn(result={"decision": "allowed-once"})
    _request(ApprovalClient(conn), tool_name="github_get_issue")
    assert conn.calls[0][1]["toolName"] == "github_get_issue"
def test_rejected_decision_denied():
    # 作用：宿主返回 rejected 即抛 LEASE_REJECTED（Fail Closed）
    conn = FakeConn(result={"decision": "rejected"})
    with pytest.raises(LeaseError, match="LEASE_REJECTED"):
        _request(ApprovalClient(conn))
def test_missing_decision_denied():
    # 作用：宿主结果缺 decision 字段即抛 LEASE_REJECTED（Fail Closed，不"尽量执行"）
    conn = FakeConn(result={})
    with pytest.raises(LeaseError, match="LEASE_REJECTED"):
        _request(ApprovalClient(conn))
def test_non_dict_result_denied():
    # 作用：宿主返回非对象结果（如裸字符串）即抛 LEASE_REJECTED
    conn = FakeConn(result="allowed-once")
    with pytest.raises(LeaseError, match="LEASE_REJECTED"):
        _request(ApprovalClient(conn))
def test_rpc_error_denied():
    # 作用：反向 RPC 失败（如宿主抛错）即抛 LEASE_REJECTED（Fail Closed）
    conn = FakeConn(error="host boom")
    with pytest.raises(LeaseError, match="LEASE_REJECTED"):
        _request(ApprovalClient(conn))
def test_timeout_denied():
    # 作用：授权通道超时即抛 LEASE_REJECTED（Fail Closed）
    conn = FakeConn(timeout=True)
    with pytest.raises(LeaseError, match="LEASE_REJECTED"):
        _request(ApprovalClient(conn))
