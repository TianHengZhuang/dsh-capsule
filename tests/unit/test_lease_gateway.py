import asyncio
import pytest
from dsh_capsule.lease.approval import ApprovalClient
from dsh_capsule.lease.gateway import LeaseGateway
from dsh_capsule.lease.models import LeaseError
from dsh_capsule.lease.service import LeaseService
from dsh_capsule.storage.db import LeaseStore
class FakeConn:
    def __init__(self, result=None, error: str | None = None):
        # 作用：模拟反向 RPC 授权通道，记录调用次数供"是否再次弹 Approval"断言
        self.calls: list[tuple[str, dict]] = []
        self._result = result
        self._error = error
    async def call(self, method: str, params: dict | None = None, timeout: float = 30.0):
        # 作用：记录一次授权请求并按注入行为返回或抛错
        self.calls.append((method, params or {}))
        if self._error is not None:
            raise LeaseError("LEASE_REJECTED", self._error)
        return self._result
@pytest.fixture
def gateway_parts(tmp_path):
    # 作用：每个用例独立的真实 LeaseService（临时 SQLite）+ FakeConn 授权通道，返回可组合三元组
    store = LeaseStore(str(tmp_path / "leases.db"))
    asyncio.run(store.connect())
    yield store
    asyncio.run(store.close())
def _make_gateway(store: LeaseStore, approval_result=None, approval_error=None) -> tuple[LeaseGateway, FakeConn]:
    # 作用：组装"真实 LeaseService + 可控 Fake 授权通道"的 LeaseGateway
    conn = FakeConn(result=approval_result, error=approval_error)
    return LeaseGateway(LeaseService(store), ApprovalClient(conn)), conn
BASE = {"capsule_id": "github-reader", "capsule_instance_id": "inst-1", "session_id": "S100", "provider": "github", "resource": "repo:foo/bar", "action": "issues.read"}
def test_first_request_issues_lease_after_approval(gateway_parts):
    # 作用：首次请求无 Lease——先走宿主 one-shot 授权（allowed-once），再签发 ACTIVE Lease（规格第 18 节）
    gateway, conn = _make_gateway(gateway_parts, approval_result={"decision": "allowed-once"})
    lease = asyncio.run(gateway.request(**BASE))
    assert lease.status == "ACTIVE"
    assert lease.actions == {"issues.read"}
    assert len(conn.calls) == 1
    assert conn.calls[0][0] == "host.approval.request_lease"
def test_reuse_skips_approval(gateway_parts):
    # 作用：同实例+会话+Provider+资源+action 的第二次请求直接复用 Lease，不再弹 Approval（规格第 19 节）
    gateway, conn = _make_gateway(gateway_parts, approval_result={"decision": "allowed-once"})
    first = asyncio.run(gateway.request(**BASE))
    second = asyncio.run(gateway.request(**BASE))
    assert len(conn.calls) == 1
    assert second.id == first.id
def test_rejected_approval_issues_nothing(gateway_parts):
    # 作用：宿主拒绝（rejected）即抛 LEASE_REJECTED 且绝不签发 Lease（Fail Closed）
    gateway, conn = _make_gateway(gateway_parts, approval_result={"decision": "rejected"})
    with pytest.raises(LeaseError, match="LEASE_REJECTED"):
        asyncio.run(gateway.request(**BASE))
    assert asyncio.run(gateway_parts.list_all()) == []
def test_new_action_requires_new_approval(gateway_parts):
    # 作用：已有 Lease 不含请求的 action 时必须重新授权签发新 Lease（复用条件包含 action，规格第 19 节）
    gateway, conn = _make_gateway(gateway_parts, approval_result={"decision": "allowed-once"})
    first = asyncio.run(gateway.request(**BASE))
    second = asyncio.run(gateway.request(**{**BASE, "action": "issues.write"}))
    assert len(conn.calls) == 2
    assert second.id != first.id
    assert "issues.write" in second.actions
def test_cross_session_no_reuse(gateway_parts):
    # 作用：Session B 请求同资源不走 Session A 的复用路径，必须重新授权（不能跨 Session 复用）
    gateway, conn = _make_gateway(gateway_parts, approval_result={"decision": "allowed-once"})
    asyncio.run(gateway.request(**BASE))
    lease_b = asyncio.run(gateway.request(**{**BASE, "session_id": "S200"}))
    assert len(conn.calls) == 2
    assert lease_b.session_id == "S200"
def test_invalid_ttl_rejected_without_approval(gateway_parts):
    # 作用：TTL 非法（<=0 或超上限 1800）在发起授权前即抛 LEASE_REJECTED（Fail Closed）
    gateway, conn = _make_gateway(gateway_parts, approval_result={"decision": "allowed-once"})
    with pytest.raises(LeaseError, match="LEASE_REJECTED"):
        asyncio.run(gateway.request(**{**BASE, "ttl_seconds": 0}))
    with pytest.raises(LeaseError, match="LEASE_REJECTED"):
        asyncio.run(gateway.request(**{**BASE, "ttl_seconds": 9999}))
    assert conn.calls == []
