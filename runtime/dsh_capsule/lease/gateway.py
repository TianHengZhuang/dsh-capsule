from dsh_capsule.lease.approval import ApprovalClient
from dsh_capsule.lease.models import CapabilityLease, LeaseError
from dsh_capsule.lease.service import LeaseService
DEFAULT_TTL_SECONDS = 600
MAX_TTL_SECONDS = 1800
class LeaseGateway:
    def __init__(self, service: LeaseService, approval: ApprovalClient):
        # 作用：Lease 签发编排层（规格第 18/19 节）——先查可复用 ACTIVE Lease，未命中才走宿主 one-shot Approval 授权后签发
        self._service = service
        self._approval = approval
    async def request(self, *, capsule_id: str, capsule_instance_id: str, session_id: str, provider: str, resource: str, action: str, ttl_seconds: int = DEFAULT_TTL_SECONDS, tool_name: str | None = None) -> CapabilityLease:
        # 作用：完整签发链路：同实例+会话+Provider+资源且已含该 action 的未过期 Lease 直接复用（不再弹 Approval）；
        # 未命中或不含该 action 时经宿主 Approval 授权后签发新 Lease；TTL 非法（<=0 或超上限）一律拒绝（Fail Closed）
        if ttl_seconds <= 0 or ttl_seconds > MAX_TTL_SECONDS:
            raise LeaseError("LEASE_REJECTED", f"invalid ttl_seconds: {ttl_seconds}")
        lease = await self._service.find_matching_lease(capsule_instance_id=capsule_instance_id, session_id=session_id, provider=provider, resource=resource)
        if lease is not None and action in lease.actions:
            return lease
        await self._approval.request_lease(capsule_id=capsule_id, provider=provider, resource=resource, action=action, ttl_seconds=ttl_seconds, tool_name=tool_name)
        return await self._service.issue(capsule_id=capsule_id, capsule_instance_id=capsule_instance_id, session_id=session_id, provider=provider, resource=resource, actions={action}, ttl_seconds=ttl_seconds)
