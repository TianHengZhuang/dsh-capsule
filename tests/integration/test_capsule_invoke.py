import asyncio
import socket
from pathlib import Path
import pytest
from dsh_capsule.capsule.manager import CapsuleManager
REPO_ROOT = Path(__file__).resolve().parents[2]
def _docker_available() -> bool:
    # 作用：探测 Docker Engine 是否可用；不可用则跳过集成用例
    try:
        import docker
        docker.from_env().ping()
        return True
    except Exception:
        return False
requires_env = pytest.mark.skipif(not (_docker_available() and hasattr(socket, "AF_UNIX")), reason="requires Docker Engine + AF_UNIX (Linux/WSL2)")
@pytest.fixture(scope="module")
def manager():
    # 作用：模块级 Manager；用例结束后回收容器
    _ensure_hello_image()
    m = CapsuleManager(REPO_ROOT / "capsules")
    yield m
    asyncio.run(m.shutdown())
def _ensure_hello_image() -> None:
    # 作用：确保 dsh-capsule/hello:0.1.0 镜像存在，缺失则以仓库根为上下文构建
    import docker
    client = docker.from_env()
    tag = "dsh-capsule/hello:0.1.0"
    try:
        client.images.get(tag)
    except docker.errors.ImageNotFound:
        client.images.build(path=str(REPO_ROOT), tag=tag, dockerfile="capsules/hello/Dockerfile")
@requires_env
def test_invoke_hello_capsule_in_docker(manager):
    # 作用：Phase 1 核心验收——调用链 Manager→UDS→容器内 SDK→工具函数
    result = asyncio.run(manager.invoke("hello_capsule", {"name": "phase1"}))
    assert result == {"message": "hello, phase1!"}
@requires_env
def test_instance_reuse_within_ttl(manager):
    # 作用：同一 Capsule 的连续调用复用同一实例（不重建容器）
    first = asyncio.run(manager.invoke("hello_capsule", {}))
    second = asyncio.run(manager.invoke("hello_capsule", {}))
    assert first["message"] == "hello, capsule!"
    assert second["message"] == "hello, capsule!"
