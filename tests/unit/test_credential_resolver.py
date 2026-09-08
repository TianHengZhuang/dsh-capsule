import asyncio
import pytest
from dsh_capsule.broker.credentials import CredentialResolver
from dsh_capsule.rpc import RpcError
SECRET = "ghp_super_secret_value"
class FakeConn:
    def __init__(self, result=None, error: str | None = None, error_with_secret: str | None = None):
        # 作用：模拟反向 RPC 通道，记录调用供断言；可注入错误或"错误消息疑似含 Secret"的极端场景
        self.calls: list[tuple[str, dict]] = []
        self._result = result
        self._error = error
        self._error_with_secret = error_with_secret
    async def call(self, method: str, params: dict | None = None, timeout: float = 30.0):
        # 作用：记录一次反向调用并按注入行为返回或抛错
        self.calls.append((method, params or {}))
        if self._error_with_secret is not None:
            raise RpcError(-32000, self._error_with_secret)
        if self._error is not None:
            raise RpcError(-32000, self._error)
        return self._result
def test_resolve_returns_value():
    # 作用：宿主返回 {"value": ...} 即取出并返回；验证反向调用方法名与 ref 参数
    conn = FakeConn(result={"value": SECRET})
    value = asyncio.run(CredentialResolver(conn).resolve("GITHUB_TOKEN"))
    assert value == SECRET
    assert conn.calls[0][0] == "host.credential.resolve"
    assert conn.calls[0][1] == {"ref": "GITHUB_TOKEN"}
def test_resolve_not_cached_across_operations():
    # 作用：per-operation resolve——连续两次调用必发起两次反向 RPC，绝不跨 operation 缓存（规格第 23 节）
    conn = FakeConn(result={"value": SECRET})
    resolver = CredentialResolver(conn)
    assert asyncio.run(resolver.resolve("GITHUB_TOKEN")) == SECRET
    assert asyncio.run(resolver.resolve("GITHUB_TOKEN")) == SECRET
    assert len(conn.calls) == 2
def test_missing_value_denied():
    # 作用：宿主结果缺 value 字段即抛 CREDENTIAL_NOT_CONFIGURED（Fail Closed）
    conn = FakeConn(result={})
    with pytest.raises(RuntimeError, match="CREDENTIAL_NOT_CONFIGURED"):
        asyncio.run(CredentialResolver(conn).resolve("GITHUB_TOKEN"))
def test_empty_value_denied():
    # 作用：空字符串凭据视为未配置（Fail Closed）
    conn = FakeConn(result={"value": ""})
    with pytest.raises(RuntimeError, match="CREDENTIAL_NOT_CONFIGURED"):
        asyncio.run(CredentialResolver(conn).resolve("GITHUB_TOKEN"))
def test_non_dict_result_denied():
    # 作用：宿主返回非对象结果（如裸字符串 Secret）不透传解析，直接抛 CREDENTIAL_NOT_CONFIGURED
    conn = FakeConn(result=SECRET)
    with pytest.raises(RuntimeError, match="CREDENTIAL_NOT_CONFIGURED"):
        asyncio.run(CredentialResolver(conn).resolve("GITHUB_TOKEN"))
def test_rpc_error_denied_without_leaking_secret():
    # 作用：反向 RPC 失败统一抛 CREDENTIAL_NOT_CONFIGURED；即使宿主错误消息疑似含 Secret，异常信息也绝不携带（规格第 23 节）
    conn = FakeConn(error_with_secret=f"resolve failed for {SECRET}")
    with pytest.raises(RuntimeError, match="CREDENTIAL_NOT_CONFIGURED") as exc_info:
        asyncio.run(CredentialResolver(conn).resolve("GITHUB_TOKEN"))
    assert SECRET not in str(exc_info.value)
