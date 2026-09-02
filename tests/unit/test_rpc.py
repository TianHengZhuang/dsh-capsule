import asyncio
import os
import pytest
from dsh_capsule.rpc import RpcConnection, RpcError
def _make_pair() -> tuple[RpcConnection, RpcConnection]:
    # 作用：用两个 os.pipe 交叉连接出一条全双工链路，模拟 TS↔Python 的双向通信
    r1, w1 = os.pipe()
    r2, w2 = os.pipe()
    a = RpcConnection(os.fdopen(r1, "rb"), os.fdopen(w2, "wb"))
    b = RpcConnection(os.fdopen(r2, "rb"), os.fdopen(w1, "wb"))
    return a, b
async def _serve(conn: RpcConnection) -> None:
    # 作用：作为后台任务持续读取对端消息，EOF 时正常退出
    try:
        await conn.run()
    except EOFError:
        pass
def test_request_response_and_reverse_call():
    # 作用：验证正向请求响应、Python→TS 反向调用与未知方法错误传播
    async def scenario():
        a, b = _make_pair()
        b.register("echo", lambda p: p)
        a.register("upper", lambda p: {"value": str(p["value"]).upper()})
        task_a = asyncio.create_task(_serve(a))
        task_b = asyncio.create_task(_serve(b))
        assert await a.call("echo", {"x": 1}) == {"x": 1}
        assert await b.call("upper", {"value": "ok"}) == {"value": "OK"}
        with pytest.raises(RpcError):
            await a.call("nope", {})
        a._writer.close()
        b._writer.close()
        await asyncio.gather(task_a, task_b)
    asyncio.run(scenario())
def test_connection_closed_fails_pending():
    # 作用：验证连接关闭后未完成请求立即失败（Fail Closed，不允许悬挂）
    async def scenario():
        a, b = _make_pair()
        task_b = asyncio.create_task(_serve(b))
        task_a = asyncio.create_task(_serve(a))
        b._writer.close()
        with pytest.raises(RpcError):
            await a.call("echo", {"x": 1}, timeout=5)
        a._writer.close()
        await asyncio.gather(task_a, task_b)
    asyncio.run(scenario())
