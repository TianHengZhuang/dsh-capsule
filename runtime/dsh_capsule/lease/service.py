import time
from dsh_capsule.lease.models import CapabilityLease, LeaseError
from dsh_capsule.storage.db import LeaseStore, new_lease_id
class LeaseService:
    def __init__(self, store: LeaseStore):
        # 作用：Lease 生命周期服务——签发/校验/撤销；安全正确性全部在 validate 时点判断，不依赖后台任务
        self._store = store
    async def issue(self, *, capsule_id: str, capsule_instance_id: str, session_id: str, provider: str, resource: str, actions: set[str], ttl_seconds: int) -> CapabilityLease:
        # 作用：签发新 Lease（调用前提：宿主 Approval 已通过）；TTL 上限内任意时长
        now = time.time()
        lease = CapabilityLease(
            id=new_lease_id(), capsule_id=capsule_id, capsule_instance_id=capsule_instance_id,
            session_id=session_id, provider=provider, resource=resource, actions=set(actions),
            issued_at=now, expires_at=now + ttl_seconds, status="ACTIVE",
        )
        await self._store.insert(lease)
        return lease
    async def find_matching_lease(self, *, capsule_instance_id: str, session_id: str, provider: str, resource: str) -> CapabilityLease | None:
        # 作用：复用路径——查找同实例+会话+Provider+资源的未过期 ACTIVE Lease；不存在返回 None（由调用方发起 Approval）
        lease = await self._store.find_matching(capsule_instance_id, session_id, provider, resource)
        if lease is None or lease.status != "ACTIVE":
            return None
        if time.time() >= lease.expires_at:
            await self._store.update_status(lease.id, "EXPIRED", "expired on lookup")
            return None
        return lease
    async def find_latest_for_resource(self, *, provider: str, resource: str) -> CapabilityLease | None:
        # 作用：阻断校验路径——查找该 Provider+资源的最新一条 Lease（不限实例与会话），供调用方检查撤销/跨会话等异常状态
        return await self._store.find_for_resource(provider, resource)
    async def validate(self, *, capsule_instance_id: str, session_id: str, provider: str, resource: str, action: str) -> CapabilityLease:
        # 作用：规格第 17 节安全规则逐条校验，任意条件失败即抛对应错误码（Fail Closed，绝不"尽量执行"）
        lease = await self._store.find_for_resource(provider, resource)
        if lease is None:
            raise LeaseError("LEASE_REQUIRED", f"no active lease for {provider} {resource}")
        if lease.status == "REVOKED":
            raise LeaseError("LEASE_REVOKED", f"lease {lease.id} revoked")
        if time.time() >= lease.expires_at:
            await self._store.update_status(lease.id, "EXPIRED", "expired on validate")
            raise LeaseError("LEASE_EXPIRED", f"lease {lease.id} expired")
        if lease.capsule_instance_id != capsule_instance_id:
            raise LeaseError("LEASE_CAPSULE_MISMATCH", "lease bound to another capsule instance")
        if lease.session_id != session_id:
            raise LeaseError("LEASE_SESSION_MISMATCH", "lease bound to another session")
        if action not in lease.actions:
            raise LeaseError("CAPABILITY_DENIED", f"action {action} not granted by lease {lease.id}")
        return lease
    async def revoke(self, lease_id: str) -> None:
        # 作用：撤销单个 Lease；不存在抛 LEASE_NOT_FOUND
        lease = await self._store.get(lease_id)
        if lease is None:
            raise LeaseError("LEASE_NOT_FOUND", f"lease {lease_id} not found")
        await self._store.update_status(lease_id, "REVOKED", "manual revoke")
    async def revoke_session(self, session_id: str) -> int:
        # 作用：撤销整个 Session 的 Lease，返回撤销数量
        return await self._store.revoke_by_session(session_id)
    async def revoke_capsule(self, capsule_id: str) -> int:
        # 作用：撤销整个 Capsule 的 Lease，返回撤销数量
        return await self._store.revoke_by_capsule(capsule_id)
    async def list_leases(self) -> list[CapabilityLease]:
        # 作用：列出全部 Lease（capsulectl 使用）
        return await self._store.list_all()
