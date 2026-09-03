from typing import Literal
from pydantic import BaseModel, ConfigDict, field_validator
class LeaseError(Exception):
    # 作用：统一携带规格第 28 节错误码的 Lease 异常；Fail Closed 下任意校验失败即抛出
    def __init__(self, code: str, message: str = ""):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code
        self.message = message
class CapabilityLease(BaseModel):
    # 作用：Capability Lease 数据模型（规格第 16 节）——绑定实例+会话+Provider+资源+动作与 TTL
    model_config = ConfigDict(extra="forbid")
    id: str
    capsule_id: str
    capsule_instance_id: str
    session_id: str
    provider: str
    resource: str
    actions: set[str]
    issued_at: float
    expires_at: float
    status: Literal["ACTIVE", "REVOKED", "EXPIRED"] = "ACTIVE"
    revoked_at: float | None = None
    revoke_reason: str | None = None
    @field_validator("resource")
    @classmethod
    def _validate_resource(cls, v: str) -> str:
        # 作用：资源标识必须形如 kind:value（如 repo:foo/bar），未知格式 Fail Closed
        if ":" not in v:
            raise ValueError(f"invalid resource format: {v}")
        return v
