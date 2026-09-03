import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from dsh_capsule.capsule.manifest import CapsuleManifest
@dataclass
class CapsuleInstance:
    # 作用：一次 Capsule 运行实例——独享 IPC 目录与 plugin.sock，绑定唯一容器
    capsule_id: str
    instance_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    manifest: CapsuleManifest | None = None
    ipc_dir: Path | None = None
    plugin_sock: Path | None = None
    container_id: str | None = None
    started_at: float = field(default_factory=time.time)
