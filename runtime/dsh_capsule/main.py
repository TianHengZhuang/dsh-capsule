import asyncio
import sys
from dsh_capsule.rpc import RpcConnection
def build_connection() -> RpcConnection:
    # 作用：组装 RPC 连接并注册 Phase 0 所需的 system.* 方法
    conn = RpcConnection(sys.stdin.buffer, sys.stdout.buffer)
    conn.register("system.ping", lambda params: {"pong": True})
    conn.register("system.call_host", lambda params: conn.call(params["method"], params.get("params") or {}))
    return conn
async def amain() -> None:
    # 作用：异步入口，持续处理 RPC 消息直到 stdin 关闭（EOF）
    conn = build_connection()
    await conn.run()
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
