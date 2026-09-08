import asyncio
from dsh_capsule.lease.models import LeaseError
from dsh_capsule.rpc import RpcConnection, RpcError
APPROVAL_TIMEOUT_SECONDS = 300.0
ALLOWED_DECISION = "allowed-once"
class ApprovalClient:
    def __init__(self, conn: RpcConnection):
        # 作用：封装 Python→TS 反向授权通道 host.approval.request_lease（规格第 33 节）——DSH one-shot Approval 批准的是"签发一张明确 Scope、明确 TTL 的 Lease"，而非逐请求批准
        self._conn = conn
    async def request_lease(self, *, capsule_id: str, provider: str, resource: str, action: str, ttl_seconds: int, tool_name: str | None = None) -> None:
        # 作用：向宿主请求 Lease 签发授权；仅 decision == allowed-once 放行，其余结果或通道异常一律抛 LEASE_REJECTED（Fail Closed）；授权参数不含任何 Secret
        params: dict = {"capsuleId": capsule_id, "provider": provider, "resource": resource, "action": action, "ttlSeconds": ttl_seconds}
        if tool_name is not None:
            params["toolName"] = tool_name
        try:
            result = await self._conn.call("host.approval.request_lease", params, timeout=APPROVAL_TIMEOUT_SECONDS)
        except (RpcError, asyncio.TimeoutError) as exc:
            raise LeaseError("LEASE_REJECTED", f"approval channel failed: {exc}") from exc
        decision = result.get("decision") if isinstance(result, dict) else None
        if decision != ALLOWED_DECISION:
            raise LeaseError("LEASE_REJECTED", f"approval decision: {decision!r}")
