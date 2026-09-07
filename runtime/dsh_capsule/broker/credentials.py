import asyncio
from dsh_capsule.rpc import RpcConnection, RpcError
class CredentialResolver:
    def __init__(self, conn: RpcConnection):
        # 作用：封装 Python→TS 反向凭据解析通道 host.credential.resolve（规格第 23/33 节）——真实 Secret 仅短暂存在于可信侧内存
        self._conn = conn
    async def resolve(self, ref: str) -> str:
        # 作用：单次 operation 解析凭据——每次调用都重新发起反向 RPC（per-operation resolve，不跨 operation 缓存、不写 SQLite/日志）；
        # 任何失败统一抛 CREDENTIAL_NOT_CONFIGURED 且异常信息绝不携带 Secret 值（Fail Closed）
        try:
            result = await self._conn.call("host.credential.resolve", {"ref": ref})
        except (RpcError, asyncio.TimeoutError) as exc:
            raise RuntimeError(f"CREDENTIAL_NOT_CONFIGURED: resolve failed for {ref}") from exc
        value = result.get("value") if isinstance(result, dict) else None
        if not isinstance(value, str) or not value:
            raise RuntimeError(f"CREDENTIAL_NOT_CONFIGURED: empty value for {ref}")
        return value
