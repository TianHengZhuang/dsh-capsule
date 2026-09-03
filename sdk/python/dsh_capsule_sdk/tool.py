import asyncio
import inspect
import json
import os
import sys
from dsh_capsule_sdk.broker import BrokerClient
class CapsuleContext:
    def __init__(self, broker: BrokerClient):
        # 作用：工具执行上下文，Phase 1 仅暴露 broker 占位；后续 Phase 增加资源信息
        self.broker = broker
class CapsuleApp:
    def __init__(self, plugin_sock: str | None = None):
        # 作用：Capsule 插件应用骨架——注册工具并在独享 UDS 上提供 NDJSON JSON-RPC 服务
        self._sock = plugin_sock or os.environ.get("DSH_CAPSULE_PLUGIN_SOCK", "/run/capsule/plugin.sock")
        self._tools: dict[str, callable] = {}
    def tool(self, name: str):
        # 作用：装饰器，注册名为 name 的工具函数（签名 async fn(args: dict, ctx: CapsuleContext) -> dict）
        def decorator(fn):
            self._tools[name] = fn
            return fn
        return decorator
    def run(self) -> None:
        # 作用：阻塞运行 UDS 服务；stdout 不使用，日志一律写 stderr
        try:
            asyncio.run(self._serve())
        except KeyboardInterrupt:
            pass
    async def _serve(self) -> None:
        # 作用：监听 plugin.sock 并循环接受连接（socket 文件由 Runtime 预先创建的目录承载）
        if os.path.exists(self._sock):
            os.unlink(self._sock)
        server = await asyncio.start_unix_server(self._handle_conn, path=self._sock)
        print(f"[capsule] serving on {self._sock}", file=sys.stderr)
        async with server:
            await server.serve_forever()
    async def _handle_conn(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        # 作用：处理单个连接，逐行读取 NDJSON 请求并回写响应
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError as exc:
                    await self._write(writer, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"parse error: {exc}"}})
                    continue
                response = await self._dispatch(msg)
                await self._write(writer, response)
        finally:
            writer.close()
            await writer.wait_closed()
    async def _dispatch(self, msg: dict) -> dict:
        # 作用：分发 tool.invoke 请求到已注册工具；任何失败返回结构化错误（Fail Closed）
        msg_id = msg.get("id")
        try:
            if msg.get("method") != "tool.invoke":
                raise RuntimeError("CAPSULE_PROTOCOL_ERROR: only tool.invoke is supported")
            name = msg.get("params", {}).get("name")
            fn = self._tools.get(name)
            if fn is None:
                raise RuntimeError(f"CAPSULE_PROTOCOL_ERROR: unknown tool: {name}")
            result = fn(msg.get("params", {}).get("args") or {}, CapsuleContext(BrokerClient()))
            if inspect.isawaitable(result):
                result = await result
            return {"jsonrpc": "2.0", "id": msg_id, "result": result}
        except Exception as exc:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32000, "message": str(exc)}}
    async def _write(self, writer: asyncio.StreamWriter, msg: dict) -> None:
        # 作用：序列化单行 NDJSON 响应并刷写
        writer.write((json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8"))
        await writer.drain()
