class BrokerClient:
    def __init__(self, broker_sock: str | None = None):
        # 作用：占位的 Broker 客户端，Phase 3 实现 UDS broker.sock 受控访问入口
        self._sock = broker_sock or "/run/capsule/broker.sock"
    async def call(self, provider: str, action: str, resource: str, payload: dict) -> dict:
        # 作用：预留的受控能力访问入口（Phase 3 实现，当前 Fail Closed）
        raise RuntimeError("broker not available until Phase 3")
