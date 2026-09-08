import asyncio
import json
import os
BROKER_CALL_TIMEOUT_SECONDS = 360.0
class BrokerClient:
    def __init__(self, broker_sock: str | None = None):
        # 作用：容器内经独享 broker.sock 访问宿主 Broker 的受控客户端——Secret 永不出宿主，本客户端只见处理结果
        self._sock = broker_sock or os.environ.get("DSH_CAPSULE_BROKER_SOCK", "/run/capsule/broker.sock")
    async def call(self, provider: str, action: str, resource: str, payload: dict) -> dict:
        # 作用：向宿主 Broker 发起单次 broker.call 请求并等待响应；超时须覆盖宿主侧人工 Approval 时长；
        # 错误统一抛 RuntimeError 并优先携带宿主统一错误码（如 CAPABILITY_DENIED / LEASE_REJECTED）
        reader, writer = await asyncio.open_unix_connection(self._sock)
        try:
            request = {"jsonrpc": "2.0", "id": "sdk-1", "method": "broker.call", "params": {"provider": provider, "action": action, "resource": resource, "payload": payload or {}}}
            writer.write((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
            await writer.drain()
            line = await asyncio.wait_for(reader.readline(), BROKER_CALL_TIMEOUT_SECONDS)
        finally:
            writer.close()
            await writer.wait_closed()
        if not line:
            raise RuntimeError("BROKER_PROTOCOL_ERROR: empty response from broker")
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"BROKER_PROTOCOL_ERROR: {exc}") from None
        if "error" in msg:
            error = msg["error"]
            code = (error.get("data") or {}).get("code") or error.get("message", "BROKER_PROTOCOL_ERROR")
            raise RuntimeError(str(code))
        return msg.get("result")
