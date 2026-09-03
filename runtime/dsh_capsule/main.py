import asyncio
import os
import sys
from pathlib import Path
from dsh_capsule.capsule.manager import CapsuleManager
from dsh_capsule.rpc import RpcConnection
DEFAULT_CAPSULES_DIR = Path(__file__).resolve().parents[2] / "capsules"
def build_connection(manager: CapsuleManager) -> RpcConnection:
    # 作用：组装 RPC 连接并注册 system.* 与 capsule.* 方法
    conn = RpcConnection(sys.stdin.buffer, sys.stdout.buffer)
    conn.register("system.ping", lambda params: {"pong": True})
    conn.register("system.call_host", lambda params: conn.call(params["method"], params.get("params") or {}))
    conn.register("capsule.list_tools", lambda params: manager.list_tools())
    conn.register("capsule.invoke", lambda params: manager.invoke(params["tool"], params.get("args") or {}, params.get("timeout")))
    return conn
async def amain() -> None:
    # 作用：异步入口，持续处理 RPC 消息直到 stdin 关闭（EOF）；退出前回收全部 Capsule 实例
    manager = CapsuleManager(os.environ.get("DSH_CAPSULE_DIR") or DEFAULT_CAPSULES_DIR)
    conn = build_connection(manager)
    try:
        await conn.run()
    finally:
        await manager.shutdown()
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
