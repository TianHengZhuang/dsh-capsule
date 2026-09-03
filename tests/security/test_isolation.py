import asyncio
import socket
import uuid
from pathlib import Path
import pytest
from dsh_capsule.capsule.manager import CapsuleManager
REPO_ROOT = Path(__file__).resolve().parents[2]
IMAGES = {"dsh-capsule/hello:0.1.0": "capsules/hello/Dockerfile", "dsh-capsule/malicious-demo:0.1.0": "capsules/malicious-demo/Dockerfile"}
def _docker_available() -> bool:
    # 作用：探测 Docker Engine 是否可用；不可用则跳过安全用例
    try:
        import docker
        docker.from_env().ping()
        return True
    except Exception:
        return False
requires_env = pytest.mark.skipif(not (_docker_available() and hasattr(socket, "AF_UNIX")), reason="requires Docker Engine + AF_UNIX (Linux/WSL2)")
def _ensure_images() -> None:
    # 作用：确保测试所需镜像存在，缺失则以仓库根为上下文构建
    import docker
    client = docker.from_env()
    for tag, dockerfile in IMAGES.items():
        try:
            client.images.get(tag)
        except docker.errors.ImageNotFound:
            client.images.build(path=str(REPO_ROOT), tag=tag, dockerfile=dockerfile)
@pytest.fixture(scope="module")
def manager():
    # 作用：模块级 Manager（含 malicious-demo）；用例结束后回收全部容器
    _ensure_images()
    m = CapsuleManager(REPO_ROOT / "capsules")
    yield m
    asyncio.run(m.shutdown())
@requires_env
def test_host_file_unreachable(manager, tmp_path):
    # 作用：负向安全测试——容器读不到宿主文件（宿主路径未挂载）
    secret = f"HOST-SECRET-{uuid.uuid4().hex}"
    marker = tmp_path / "host-secret.txt"
    marker.write_text(secret, encoding="utf-8")
    result = asyncio.run(manager.invoke("probe_host_file", {"path": str(marker)}))
    assert result["ok"] is False
    assert secret not in str(result)
@requires_env
def test_host_env_not_leaked(manager, monkeypatch):
    # 作用：负向安全测试——宿主进程环境变量不进入容器（仅注入非敏感运行变量）
    monkeypatch.setenv("DSH_TEST_SECRET", "leak-me-if-you-can")
    result = asyncio.run(manager.invoke("probe_env", {}))
    assert "DSH_TEST_SECRET" not in result["env"]
    assert "leak-me-if-you-can" not in str(result)
@requires_env
def test_direct_network_blocked(manager):
    # 作用：负向安全测试——容器无法直接对外联网（network none）
    result = asyncio.run(manager.invoke("probe_network", {"host": "1.1.1.1", "port": 443}))
    assert result["ok"] is False
@requires_env
def test_docker_sock_unreachable(manager):
    # 作用：负向安全测试——容器无法访问 Docker Socket（未挂载，防逃逸）
    result = asyncio.run(manager.invoke("probe_docker_sock", {}))
    assert result["ok"] is False
@requires_env
def test_readonly_rootfs(manager):
    # 作用：负向安全测试——容器根文件系统只读，写入失败
    result = asyncio.run(manager.invoke("probe_write_file", {}))
    assert result["ok"] is False
@requires_env
def test_oversized_output_rejected(manager):
    # 作用：负向安全测试——超过 2MB 的响应被上限拦截（Fail Closed）
    with pytest.raises(RuntimeError, match="CAPSULE_OUTPUT_TOO_LARGE"):
        asyncio.run(manager.invoke("attack_huge_output", {}))
@requires_env
def test_dead_loop_times_out(manager):
    # 作用：负向安全测试——死循环被调用超时矩阵终止
    with pytest.raises(RuntimeError, match="CAPSULE_TIMEOUT"):
        asyncio.run(manager.invoke("attack_dead_loop", {}, timeout=3.0))
@requires_env
def test_crash_isolated_and_recovered(manager):
    # 作用：负向安全测试——容器崩溃不影响 Runtime，实例自动重建后恢复可用
    with pytest.raises(RuntimeError):
        asyncio.run(manager.invoke("attack_crash", {}))
    result = asyncio.run(manager.invoke("probe_env", {}))
    assert "env" in result
