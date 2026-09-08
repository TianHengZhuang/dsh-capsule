import asyncio
import os
import sys
from pathlib import Path
from dsh_capsule.capsule.manager import CapsuleManager
from dsh_capsule.lease.approval import ApprovalClient
from dsh_capsule.lease.gateway import LeaseGateway, DEFAULT_TTL_SECONDS
from dsh_capsule.lease.service import LeaseService
from dsh_capsule.rpc import RpcConnection, RpcError
from dsh_capsule.storage.db import LeaseStore
DEFAULT_CAPSULES_DIR = Path(__file__).resolve().parents[2] / "capsules"
DEFAULT_LEASES_DB = "leases.db"
def register_methods(conn: RpcConnection, manager: CapsuleManager, gateway: LeaseGateway) -> None:
    # 作用：注册全部 TS→Python 方法（system.* / capsule.* / lease.*）；stdout 严格保留给 NDJSON RPC
    conn.register("system.ping", lambda params: {"pong": True})
    conn.register("system.call_host", lambda params: conn.call(params["method"], params.get("params") or {}))
    conn.register("capsule.list_tools", lambda params: manager.list_tools())
    conn.register("capsule.invoke", lambda params: manager.invoke(params["tool"], params.get("args") or {}, params.get("timeout")))
    conn.register("lease.request", lambda params: handle_lease_request(gateway, params))
async def handle_lease_request(gateway: LeaseGateway, params: dict) -> dict:
    # 作用：lease.request 入口（规格第 18 节签发链路）——参数显式校验（缺失/类型非法即 JSON-RPC invalid params）；
    # 返回值只含 Lease 公开字段，不含任何 Secret；LeaseError 由 RPC 层转为带 data.code 的错误响应
    for key in ("capsuleId", "capsuleInstanceId", "sessionId", "provider", "resource", "action"):
        if not isinstance(params.get(key), str) or not params[key]:
            raise RpcError(-32602, f"invalid param: {key}")
    ttl = params.get("ttlSeconds", DEFAULT_TTL_SECONDS)
    if not isinstance(ttl, int) or isinstance(ttl, bool):
        raise RpcError(-32602, "invalid param: ttlSeconds")
    tool_name = params.get("toolName")
    if tool_name is not None and not isinstance(tool_name, str):
        raise RpcError(-32602, "invalid param: toolName")
    lease = await gateway.request(
        capsule_id=params["capsuleId"], capsule_instance_id=params["capsuleInstanceId"], session_id=params["sessionId"],
        provider=params["provider"], resource=params["resource"], action=params["action"],
        ttl_seconds=ttl, tool_name=tool_name,
    )
    return {"leaseId": lease.id, "capsuleId": lease.capsule_id, "provider": lease.provider, "resource": lease.resource, "actions": sorted(lease.actions), "status": lease.status, "expiresAt": lease.expires_at}
async def amain() -> None:
    # 作用：异步入口——组装 CapsuleManager / LeaseStore / LeaseGateway（含反向 Approval 通道）并运行 RPC 主循环直到 stdin EOF；退出前回收容器与存储
    manager = CapsuleManager(os.environ.get("DSH_CAPSULE_DIR") or DEFAULT_CAPSULES_DIR)
    store = LeaseStore(os.environ.get("DSH_CAPSULE_LEASES_DB") or DEFAULT_LEASES_DB)
    await store.connect()
    conn = RpcConnection(sys.stdin.buffer, sys.stdout.buffer)
    gateway = LeaseGateway(LeaseService(store), ApprovalClient(conn))
    register_methods(conn, manager, gateway)
    try:
        await conn.run()
    finally:
        await manager.shutdown()
        await store.close()
def main() -> None:
    # 作用：同步入口；stdout 严格保留给 NDJSON RPC，运行日志一律写 stderr
    print("[dsh-capsule] runtime starting", file=sys.stderr)
    try:
        asyncio.run(amain())
    except EOFError:
        pass
    print("[dsh-capsule] runtime exited", file=sys.stderr)
if __name__ == "__main__":
    main()
