import asyncio
import shutil
from pathlib import Path
import pytest
from dsh_capsule.capsule.manager import CapsuleManager
REPO_ROOT = Path(__file__).resolve().parents[2]
@pytest.fixture
def capsules_dir(tmp_path: Path) -> Path:
    # 作用：复制仓库 hello capsule 到临时目录，隔离测试环境
    dst = tmp_path / "capsules" / "hello"
    dst.mkdir(parents=True)
    for name in ("capsule.yaml",):
        shutil.copy(REPO_ROOT / "capsules" / "hello" / name, dst / name)
    return tmp_path / "capsules"
def test_list_tools(capsules_dir: Path):
    # 作用：验证 manifest 发现与工具 Schema 聚合（不依赖 Docker）
    manager = CapsuleManager(capsules_dir, backend=_FakeBackend())
    tools = manager.list_tools()
    assert [(t["name"], t["capsule_id"]) for t in tools] == [("hello_capsule", "hello")]
    assert tools[0]["parameters"]["properties"]["name"]["type"] == "string"
def test_invoke_unknown_tool_fails_closed(capsules_dir: Path):
    # 作用：验证未知工具 Fail Closed（CAPSULE_NOT_FOUND）
    manager = CapsuleManager(capsules_dir, backend=_FakeBackend())
    with pytest.raises(RuntimeError, match="CAPSULE_NOT_FOUND"):
        asyncio.run(manager.invoke("nope", {}))
def test_invalid_manifest_dir_fails_closed(tmp_path: Path):
    # 作用：验证 capsules 目录缺失时 Fail Closed
    with pytest.raises(RuntimeError, match="CAPSULE_NOT_FOUND"):
        CapsuleManager(tmp_path / "missing", backend=_FakeBackend())
class _FakeBackend:
    # 作用：单测用假后端——仅校验 Manager 层逻辑，不触碰 Docker
    async def start(self, manifest):
        raise AssertionError("should not start container in unit test")
    async def invoke(self, instance, request, timeout=None):
        raise AssertionError("should not invoke in unit test")
    async def health(self, instance):
        return True
    async def stop(self, instance):
        pass
