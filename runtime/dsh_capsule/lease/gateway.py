import time
from dsh_capsule.lease.approval import ApprovalClient
from dsh_capsule.lease.models import CapabilityLease, LeaseError
from dsh_capsule.lease.service import LeaseService
DEFAULT_TTL_SECONDS = 600
MAX_TTL_SECONDS = 1800
class LeaseGateway:
    def __init__(self, service: LeaseService, approval: ApprovalClient):
        # 作用：Lease 签发编排层（规格第 18/19/20 节）——先查可复用 ACTIVE Lease，未命中先做阻断校验，最后才走宿主 one-shot Approval 授权后签发
        self._service = service
        self._approval = approval
    async def request(self, *, capsule_id: str, capsule_instance_id: str, session_id: str, provider: str, resource: str, action: str, ttl_seconds: int = DEFAULT_TTL_SECONDS, tool_name: str | None = None) -> CapabilityLease:
        # 作用：完整签发链路：同实例+会话+Provider+资源且已含该 action 的未过期 Lease 直接复用（不再弹 Approval）；
        # 复用未命中时先做阻断校验——已撤销 Lease 立即 LEASE_REVOKED（规格第 20 节）、同资源的 ACTIVE Lease 被其他
        # 会话/实例绑定时 LEASE_SESSION_MISMATCH / LEASE_CAPSULE_MISMATCH（规格第 24 节与第 37 节 Demo 第 8 项），
        # 绝不静默重签绕过；仅当无阻断（首次/已过期/同调用者补新 action）才经宿主 Approval 授权后签发新 Lease；
        # TTL 非法（<=0 或超上限）一律拒绝（Fail Closed）
        if ttl_seconds <= 0 or ttl_seconds > MAX_TTL_SECONDS:
            raise LeaseError("LEASE_REJECTED", f"invalid ttl_seconds: {ttl_seconds}")
        lease = await self._service.find_matching_lease(capsule_instance_id=capsule_instance_id, session_id=session_id, provider=provider, resource=resource)
        if lease is not None and action in lease.actions:
            return lease
        latest = await self._service.find_latest_for_resource(provider=provider, resource=resource)
        if latest is not None and latest.status == "REVOKED" and latest.session_id == session_id:
            raise LeaseError("LEASE_REVOKED", f"lease {latest.id} has been revoked")
        if latest is not None and latest.status == "ACTIVE" and time.time() < latest.expires_at:
            if latest.session_id != session_id:
                raise LeaseError("LEASE_SESSION_MISMATCH", "lease is bound to another session and cannot be reused here")
            if latest.capsule_instance_id != capsule_instance_id:
                raise LeaseError("LEASE_CAPSULE_MISMATCH", "lease is bound to another capsule instance")
        await self._approval.request_lease(capsule_id=capsule_id, provider=provider, resource=resource, action=action, ttl_seconds=ttl_seconds, tool_name=tool_name)
        return await self._service.issue(capsule_id=capsule_id, capsule_instance_id=capsule_instance_id, session_id=session_id, provider=provider, resource=resource, actions={action}, ttl_seconds=ttl_seconds)
