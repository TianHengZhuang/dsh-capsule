import asyncio
import json
import os
import pathlib
import shutil
import tempfile
import time
import uuid
import docker
from dsh_capsule.capsule.instance import CapsuleInstance
from dsh_capsule.capsule.manifest import CapsuleManifest
class DockerBackend:
    def __init__(self, run_dir: str | None = None, invoke_timeout: float = 30.0, start_timeout: float = 15.0):
        # 作用：Docker 隔离后端——只管容器与 UDS 调用，不懂 Lease；隔离参数与规格第 12 节一一对应
        self._run_dir = pathlib.Path(run_dir or os.environ.get("DSH_CAPSULE_RUN_DIR") or ("/run/dsh-capsule" if os.name == "posix" else os.path.join(tempfile.gettempdir(), "dsh-capsule")))
        self._invoke_timeout = invoke_timeout
        self._start_timeout = start_timeout
        self._client = None
    def _ensure_client(self):
        # 作用：惰性初始化 docker client（连接失败由调用方 Fail Closed）
        if self._client is None:
            self._client = docker.from_env()
        return self._client
    async def start(self, manifest: CapsuleManifest) -> CapsuleInstance:
        # 作用：创建独享 IPC 目录并以受限参数启动容器，等待 plugin.sock 就绪
        instance = self._new_instance(manifest)
        try:
            container = await asyncio.to_thread(self._create_container, manifest, instance)
        except Exception as exc:
            await self.stop(instance)
            raise RuntimeError(f"CAPSULE_START_FAILED: {exc}") from exc
        instance.container_id = container.id
        try:
            await self._wait_plugin_sock(instance)
        except Exception as exc:
            await self.stop(instance)
            raise RuntimeError(f"CAPSULE_START_FAILED: {exc}") from exc
        return instance
    def _new_instance(self, manifest: CapsuleManifest) -> CapsuleInstance:
        # 作用：构造实例并创建独享 IPC 目录（0o777 保证容器内非 root 用户可写）
        instance = CapsuleInstance(capsule_id=manifest.metadata.id, manifest=manifest)
        instance.ipc_dir = self._run_dir / instance.instance_id
        instance.ipc_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(instance.ipc_dir, 0o777)
        instance.plugin_sock = instance.ipc_dir / "plugin.sock"
        return instance
    def _create_container(self, manifest: CapsuleManifest, instance: CapsuleInstance):
        # 作用：按规格第 12 节隔离基线显式创建容器：read-only / network none / cap-drop ALL /
        # no-new-privileges / 资源限制 / tmpfs noexec / 非 root / 仅注入非敏感运行变量
        return self._ensure_client().containers.run(
            manifest.runtime.image,
            manifest.runtime.command,
            name=f"dsh-capsule-{instance.instance_id[:12]}",
            detach=True,
            read_only=True,
            network_disabled=True,
            cap_drop=["ALL"],
            security_opt=["no-new-privileges"],
            mem_limit=f"{manifest.resources.memory_mb}m",
            pids_limit=manifest.resources.pids,
            nano_cpus=int(manifest.resources.cpus * 1e9),
            tmpfs={"/tmp": "rw,noexec,nosuid,size=64m"},
            volumes={str(instance.ipc_dir): {"bind": "/run/capsule", "mode": "rw"}},
            user="65534:65534",
            environment={"DSH_CAPSULE_PLUGIN_SOCK": "/run/capsule/plugin.sock"},
            working_dir="/app",
        )
    async def _wait_plugin_sock(self, instance: CapsuleInstance) -> None:
        # 作用：轮询等待容器内 SDK 在挂载目录创建 plugin.sock，超时即启动失败
        deadline = time.monotonic() + self._start_timeout
        while time.monotonic() < deadline:
            if instance.plugin_sock.exists():
                return
            await asyncio.sleep(0.1)
        raise TimeoutError("plugin.sock not ready in time")
    async def invoke(self, instance: CapsuleInstance, request: dict, timeout: float | None = None) -> dict:
        # 作用：经 plugin.sock 向容器发送单条 NDJSON JSON-RPC 请求并等待响应
        timeout = timeout or self._invoke_timeout
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(str(instance.plugin_sock)), 5.0)
        except (NotImplementedError, OSError) as exc:
            raise RuntimeError(f"CAPSULE_UNAVAILABLE: {exc}") from exc
        try:
            writer.write((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
            await writer.drain()
            line = await asyncio.wait_for(reader.readline(), timeout)
        except asyncio.TimeoutError as exc:
            raise RuntimeError("CAPSULE_TIMEOUT: invocation timed out") from exc
        except (OSError, ConnectionError) as exc:
            raise RuntimeError(f"CAPSULE_PROTOCOL_ERROR: {exc}") from exc
        finally:
            writer.close()
        if not line:
            raise RuntimeError("CAPSULE_PROTOCOL_ERROR: empty response from capsule")
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"CAPSULE_PROTOCOL_ERROR: {exc}") from exc
        if "error" in msg:
            raise RuntimeError(f"CAPSULE_PROTOCOL_ERROR: {msg['error'].get('message', msg['error'])}")
        return msg.get("result")
    async def health(self, instance: CapsuleInstance) -> bool:
        # 作用：容器运行状态检查；任何异常一律视为不健康（Fail Closed）
        if instance.container_id is None:
            return False
        try:
            return await asyncio.to_thread(lambda: self._ensure_client().containers.get(instance.container_id).status == "running")
        except Exception:
            return False
    async def stop(self, instance: CapsuleInstance) -> None:
        # 作用：强制移除容器并清理独享 IPC 目录
        if instance.container_id is not None:
            await asyncio.to_thread(self._remove_container, instance.container_id)
        if instance.ipc_dir is not None:
            shutil.rmtree(instance.ipc_dir, ignore_errors=True)
    def _remove_container(self, container_id: str) -> None:
        # 作用：按 id 强制移除容器，已不存在的容器静默忽略
        try:
            self._ensure_client().containers.get(container_id).remove(force=True)
        except docker.errors.NotFound:
            pass
