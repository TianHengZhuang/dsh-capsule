import typing
from dsh_capsule.broker.errors import BrokerError
class ProviderAdapter(typing.Protocol):
    # 作用：Provider 适配器协议（规格第 22 节）——只允许 Provider+Action Allowlist 式受控执行，禁止通用 HTTP 代理
    name: str
    def execute(self, *, credential: str, action: str, resource: str, payload: dict) -> typing.Awaitable[dict]: ...
class ProviderRegistry:
    def __init__(self):
        # 作用：Provider 注册表——名称到适配器的唯一映射
        self._providers: dict[str, ProviderAdapter] = {}
    def register(self, provider: ProviderAdapter) -> None:
        # 作用：注册 Provider；同名重复注册视为配置错误直接抛错（Fail Closed）
        if provider.name in self._providers:
            raise BrokerError("BROKER_PROTOCOL_ERROR", f"duplicate provider: {provider.name}")
        self._providers[provider.name] = provider
    def get(self, name: str) -> ProviderAdapter | None:
        # 作用：按名称查找 Provider；未注册返回 None（由调用方按 PROVIDER_NOT_FOUND 处理）
        return self._providers.get(name)
