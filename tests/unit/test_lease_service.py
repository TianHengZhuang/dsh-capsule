import asyncio
import time
import pytest
from dsh_capsule.lease.models import CapabilityLease, LeaseError
from dsh_capsule.lease.service import LeaseService
from dsh_capsule.storage.db import LeaseStore
BASE = {"capsule_id": "github-reader", "capsule_instance_id": "inst-1", "session_id": "S100", "provider": "github", "resource": "repo:foo/bar", "actions": {"issues.read"}}
@pytest.fixture
def service(tmp_path):
    # 作用：每个用例独立的临时 SQLite LeaseService
    store = LeaseStore(str(tmp_path / "leases.db"))
    asyncio.run(store.connect())
    yield LeaseService(store)
    asyncio.run(store.close())
def _issue(service: LeaseService, **overrides) -> str:
    # 作用：按基准参数签发 Lease，返回 lease_id
    params = {**BASE, **overrides}
    actions = params.pop("actions")
    ttl = params.pop("ttl_seconds", 600)
    lease = asyncio.run(service.issue(ttl_seconds=ttl, actions=actions, **params))
    return lease.id
def test_issue_and_validate_happy_path(service):
    # 作用：签发后同实例+会话+动作校验通过并返回 Lease
    _issue(service)
    lease = asyncio.run(service.validate(capsule_instance_id="inst-1", session_id="S100", provider="github", resource="repo:foo/bar", action="issues.read"))
    assert lease.status == "ACTIVE"
    assert lease.actions == {"issues.read"}
def test_no_lease_raises_required(service):
    # 作用：无 Lease 时抛 LEASE_REQUIRED（Fail Closed）
    with pytest.raises(LeaseError, match="LEASE_REQUIRED"):
        asyncio.run(service.validate(capsule_instance_id="inst-1", session_id="S100", provider="github", resource="repo:foo/bar", action="issues.read"))
def test_expired_lease_denied_even_without_cleanup(service):
    # 作用：TTL 过期在 validate 时点即拒绝（不依赖后台 cleanup 线程）
    _issue(service, ttl_seconds=-1)
    with pytest.raises(LeaseError, match="LEASE_EXPIRED"):
        asyncio.run(service.validate(capsule_instance_id="inst-1", session_id="S100", provider="github", resource="repo:foo/bar", action="issues.read"))
def test_revoked_lease_denied_immediately(service):
    # 作用：撤销后立即返回 LEASE_REVOKED（不等待 DSH 重启）
    lease_id = _issue(service)
    asyncio.run(service.revoke(lease_id))
    with pytest.raises(LeaseError, match="LEASE_REVOKED"):
        asyncio.run(service.validate(capsule_instance_id="inst-1", session_id="S100", provider="github", resource="repo:foo/bar", action="issues.read"))
def test_revoke_unknown_lease_raises(service):
    # 作用：撤销不存在的 Lease 抛 LEASE_NOT_FOUND
    with pytest.raises(LeaseError, match="LEASE_NOT_FOUND"):
        asyncio.run(service.revoke("L999"))
def test_cross_session_reuse_denied(service):
    # 作用：Session B 复用 Session A 的 Lease 抛 LEASE_SESSION_MISMATCH（规格第 19 节）
    _issue(service)
    with pytest.raises(LeaseError, match="LEASE_SESSION_MISMATCH"):
        asyncio.run(service.validate(capsule_instance_id="inst-1", session_id="S200", provider="github", resource="repo:foo/bar", action="issues.read"))
def test_cross_instance_denied(service):
    # 作用：其他 Capsule 实例复用 Lease 抛 LEASE_CAPSULE_MISMATCH
    _issue(service)
    with pytest.raises(LeaseError, match="LEASE_CAPSULE_MISMATCH"):
        asyncio.run(service.validate(capsule_instance_id="inst-2", session_id="S100", provider="github", resource="repo:foo/bar", action="issues.read"))
def test_unauthorized_action_denied(service):
    # 作用：Lease 只授 issues.read，请求 repo.delete 抛 CAPABILITY_DENIED（规格第 27 节越权场景）
    _issue(service)
    with pytest.raises(LeaseError, match="CAPABILITY_DENIED"):
        asyncio.run(service.validate(capsule_instance_id="inst-1", session_id="S100", provider="github", resource="repo:foo/bar", action="repo.delete"))
def test_revoke_session_bulk(service):
    # 作用：revoke_session 批量撤销该会话全部 Lease
    _issue(service)
    _issue(service, resource="repo:other/repo")
    n = asyncio.run(service.revoke_session("S100"))
    assert n == 2
    with pytest.raises(LeaseError, match="LEASE_REVOKED"):
        asyncio.run(service.validate(capsule_instance_id="inst-1", session_id="S100", provider="github", resource="repo:foo/bar", action="issues.read"))
def test_revoke_capsule_bulk(service):
    # 作用：revoke_capsule 批量撤销该 Capsule 全部 Lease
    _issue(service)
    _issue(service, session_id="S200")
    n = asyncio.run(service.revoke_capsule("github-reader"))
    assert n == 2
def test_find_matching_lease_reuse(service):
    # 作用：同键未过期时 find_matching_lease 命中（免 Approval 复用）
    _issue(service)
    lease = asyncio.run(service.find_matching_lease(capsule_instance_id="inst-1", session_id="S100", provider="github", resource="repo:foo/bar"))
    assert lease is not None and lease.status == "ACTIVE"
def test_find_matching_lease_none_for_other_session(service):
    # 作用：跨会话查找返回 None（需要重新走 Approval）
    _issue(service)
    assert asyncio.run(service.find_matching_lease(capsule_instance_id="inst-1", session_id="S200", provider="github", resource="repo:foo/bar")) is None
def test_find_matching_lease_expired(service):
    # 作用：过期 Lease 查找返回 None 且状态被标记为 EXPIRED
    _issue(service, ttl_seconds=-1)
    assert asyncio.run(service.find_matching_lease(capsule_instance_id="inst-1", session_id="S100", provider="github", resource="repo:foo/bar")) is None
def test_invalid_resource_format_rejected(service):
    # 作用：资源标识缺少 kind: 前缀时模型校验失败（未知资源格式 Fail Closed）
    with pytest.raises(Exception, match="invalid resource format"):
        asyncio.run(service.issue(ttl_seconds=600, actions={"issues.read"}, capsule_id="github-reader", capsule_instance_id="inst-1", session_id="S100", provider="github", resource="foo/bar"))
def test_lease_persisted_across_restart(tmp_path):
    # 作用：Lease 持久化在 SQLite，重启 Runtime 后状态可查
    db = str(tmp_path / "leases.db")
    store = LeaseStore(db)
    asyncio.run(store.connect())
    service = LeaseService(store)
    lease_id = _issue(service)
    asyncio.run(store.close())
    store2 = LeaseStore(db)
    asyncio.run(store2.connect())
    service2 = LeaseService(store2)
    leases = asyncio.run(service2.list_leases())
    assert [l.id for l in leases] == [lease_id]
    asyncio.run(store2.close())
def test_expiry_survives_clock_advance(service):
    # 作用：issued_at/expires_at 均为绝对时间戳，随真实时间推进自然过期
    _issue(service, ttl_seconds=1)
    time.sleep(1.2)
    with pytest.raises(LeaseError, match="LEASE_EXPIRED"):
        asyncio.run(service.validate(capsule_instance_id="inst-1", session_id="S100", provider="github", resource="repo:foo/bar", action="issues.read"))
def test_capability_lease_model_roundtrip():
    # 作用：模型字段与状态枚举完整性（规格第 16 节数据模型）
    now = time.time()
    lease = CapabilityLease(id="L1", capsule_id="c", capsule_instance_id="i", session_id="s", provider="github", resource="repo:a/b", actions={"issues.read"}, issued_at=now, expires_at=now + 60)
    assert lease.status == "ACTIVE"
    assert lease.revoked_at is None
