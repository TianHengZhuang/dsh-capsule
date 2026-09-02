import asyncio
import inspect
import itertools
import json
import typing
class RpcError(Exception):
    # 异常类：统一 RPC 错误，携带错误码用于序列化为 JSON-RPC error 响应
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
class RpcConnection:
    def __init__(self, reader: typing.BinaryIO, writer: typing.BinaryIO):
        # 作用：建立双向 NDJSON JSON-RPC 连接，reader/stdin 接收对端消息，writer/stdout 发出本端消息
        self._reader = reader
        self._writer = writer
        self._methods: dict[str, typing.Callable] = {}
        self._pending: dict[str, asyncio.Future] = {}
        self._id_iter = itertools.count(1)
        self._write_lock = asyncio.Lock()
    def register(self, method: str, handler: typing.Callable) -> None:
        # 作用：注册本地方法，供对端主动调用（Python 侧即 capsule.* / system.*）
        self._methods[method] = handler
    async def call(self, method: str, params: dict | None = None, timeout: float = 30.0) -> typing.Any:
        # 作用：主动向对端发起 RPC 请求并等待响应（用于 Python→TS 反向调用，如 host.credential.resolve）
        msg_id = f"py-{next(self._id_iter)}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        try:
            await self._send({"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}})
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg_id, None)
    async def run(self) -> None:
        # 作用：主循环，阻塞逐行读取 NDJSON 消息直到 EOF；连接关闭时使所有未完成请求失败
        while True:
            line = await asyncio.to_thread(self._reader.readline)
            if not line:
                for fut in self._pending.values():
                    if not fut.done():
                        fut.set_exception(RpcError(-32000, "connection closed"))
                raise EOFError("stdin closed")
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as exc:
                await self._send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"parse error: {exc}"}})
                continue
            asyncio.create_task(self._handle(msg))
    async def _handle(self, msg: dict) -> None:
        # 作用：分发单条消息：请求交给已注册 handler，响应对回 pending future
        if "method" in msg:
            msg_id = msg.get("id")
            try:
                handler = self._methods.get(msg["method"])
                if handler is None:
                    raise RpcError(-32601, f"method not found: {msg['method']}")
                result = handler(msg.get("params") or {})
                if inspect.isawaitable(result):
                    result = await result
            except RpcError as exc:
                if msg_id is not None:
                    await self._send({"jsonrpc": "2.0", "id": msg_id, "error": {"code": exc.code, "message": str(exc)}})
            except Exception as exc:
                if msg_id is not None:
                    await self._send({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32603, "message": str(exc)}})
            else:
                if msg_id is not None:
                    await self._send({"jsonrpc": "2.0", "id": msg_id, "result": result})
        else:
            fut = self._pending.get(str(msg.get("id")))
            if fut is not None and not fut.done():
                if "error" in msg:
                    fut.set_exception(RpcError(msg["error"].get("code", -32000), msg["error"].get("message", "rpc error")))
                else:
                    fut.set_result(msg.get("result"))
    async def _send(self, msg: dict) -> None:
        # 作用：序列化为单行 NDJSON 写入 stdout；stdout 严格保留给 RPC 协议，普通日志一律走 stderr
        data = (json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8")
        async with self._write_lock:
            self._writer.write(data)
            await asyncio.to_thread(self._writer.flush)
