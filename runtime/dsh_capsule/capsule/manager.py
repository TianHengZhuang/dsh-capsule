import asyncio
import uuid
from pathlib import Path
from dsh_capsule.capsule.docker_backend import DockerBackend
from dsh_capsule.capsule.instance import CapsuleInstance
from dsh_capsule.capsule.manifest import CapsuleManifest, load_manifest
class CapsuleManager:
    def __init__(self, capsules_dir: Path | str, backend: DockerBackend | None = None):
        # 作用：Capsule 生命周期管理——manifest 发现/校验、实例启动/复用、工具调用分发
        self._backend = backend or DockerBackend()
        self._manifests: dict[str, CapsuleManifest] = {}
        self._tool_owners: dict[str, CapsuleManifest] = {}
        self._instances: dict[str, CapsuleInstance] = {}
        self._invoke_seq = 0
        self._discover(Path(capsules_dir))
    def _discover(self, capsules_dir: Path) -> None:
        # 作用：扫描 capsules/<id>/capsule.yaml；任一 manifest 非法直接抛异常（Fail Closed）
        if not capsules_dir.is_dir():
            raise RuntimeError(f"CAPSULE_NOT_FOUND: capsules dir missing: {capsules_dir}")
        for manifest_path in sorted(capsules_dir.glob("*/capsule.yaml")):
            manifest = load_manifest(manifest_path)
            if manifest.metadata.id in self._manifests:
                raise RuntimeError(f"CAPSULE_NOT_FOUND: duplicate capsule id: {manifest.metadata.id}")
            self._manifests[manifest.metadata.id] = manifest
            for tool in manifest.tools:
                self._tool_owners[tool.name] = manifest
    def list_tools(self) -> list[dict]:
        # 作用：聚合全部 Capsule 的工具 Schema（内部字段如 lease/credential 不对外暴露）
        return [
            {"name": tool.name, "description": tool.description, "parameters": tool.parameters, "capsule_id": manifest.metadata.id}
            for manifest in self._manifests.values()
            for tool in manifest.tools
        ]
    async def invoke(self, tool_name: str, args: dict, timeout: float | None = None) -> dict:
        # 作用：执行一次工具调用——定位所属 Capsule、确保实例健康、经 UDS 下发 tool.invoke
        manifest = self._tool_owners.get(tool_name)
        if manifest is None:
            raise RuntimeError(f"CAPSULE_NOT_FOUND: unknown tool: {tool_name}")
        instance = await self._ensure_instance(manifest)
        self._invoke_seq += 1
        request = {"jsonrpc": "2.0", "id": f"capsule-{self._invoke_seq}", "method": "tool.invoke", "params": {"name": tool_name, "args": args or {}}}
        return await self._backend.invoke(instance, request, timeout)
    async def _ensure_instance(self, manifest: CapsuleManifest) -> CapsuleInstance:
        # 作用：获取或启动指定 Capsule 的实例；已存在但不健康则重建
        instance = self._instances.get(manifest.metadata.id)
        if instance is not None and await self._backend.health(instance):
            return instance
        if instance is not None:
            await self._backend.stop(instance)
        instance = await self._backend.start(manifest)
        self._instances[manifest.metadata.id] = instance
        return instance
    async def shutdown(self) -> None:
        # 作用：Runtime 退出时回收全部容器与 IPC 目录
        for instance in self._instances.values():
            await self._backend.stop(instance)
        self._instances.clear()
