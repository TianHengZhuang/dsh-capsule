from pathlib import Path
from typing import Literal
import yaml
from pydantic import BaseModel, ConfigDict
class ManifestMetadata(BaseModel):
    # 作用：Capsule 标识信息，id 即 capsule_id
    model_config = ConfigDict(extra="forbid")
    id: str
    version: str
    description: str = ""
class RuntimeSpec(BaseModel):
    # 作用：容器镜像与启动命令
    model_config = ConfigDict(extra="forbid")
    image: str
    command: list[str]
class ResourceSpec(BaseModel):
    # 作用：容器资源限制，与规格第 12/32 节默认值一致
    model_config = ConfigDict(extra="forbid")
    memory_mb: int = 256
    cpus: float = 0.5
    pids: int = 64
class CredentialRequest(BaseModel):
    # 作用：声明所需 Capability Lease 的范围；仅允许 credential_ref，禁止出现真实凭据
    model_config = ConfigDict(extra="forbid")
    provider: str
    credential_ref: str
    allowed_actions: list[str]
    default_ttl_seconds: int = 600
    max_ttl_seconds: int = 1800
class ToolSpec(BaseModel):
    # 作用：对外注册的工具 Schema（JSON Schema 形状）
    model_config = ConfigDict(extra="forbid")
    name: str
    description: str = ""
    parameters: dict = {}
class CapsuleManifest(BaseModel):
    # 作用：capsule.yaml 的严格模型；apiVersion/kind 错误或未知字段一律校验失败（Fail Closed）
    model_config = ConfigDict(extra="forbid")
    apiVersion: Literal["dsh-capsule/v1"]
    kind: Literal["Capsule"]
    metadata: ManifestMetadata
    runtime: RuntimeSpec
    resources: ResourceSpec = ResourceSpec()
    credentials: list[CredentialRequest] = []
    tools: list[ToolSpec] = []
def load_manifest(path: Path | str) -> CapsuleManifest:
    # 作用：读取并校验单个 capsule.yaml，任何解析/校验失败直接抛异常（Fail Closed）
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"invalid manifest (not a mapping): {path}")
    return CapsuleManifest.model_validate(raw)
