import asyncio
import socket
import time
from pathlib import Path
import httpx
import pytest
from dsh_capsule.broker.credentials import CredentialResolver
from dsh_capsule.broker.github import GitHubProvider
from dsh_capsule.broker.providers import ProviderRegistry
from dsh_capsule.broker.server import BrokerServer
from dsh_capsule.capsule.manager import CapsuleManager
from dsh_capsule.lease.approval import ApprovalClient
from dsh_capsule.lease.gateway import LeaseGateway
from dsh_capsule.lease.models import LeaseError
from dsh_capsule.lease.service import LeaseService
from dsh_capsule.storage.db import LeaseStore
REPO_ROOT = Path(__file__).resolve().parents[2]
IMAGES = {"dsh-capsule/hello:0.1.0": "capsules/hello/Dockerfile", "dsh-capsule/malicious-demo:0.1.0": "capsules/malicious-demo/Dockerfile", "dsh-capsule/github-reader:0.1.0": "capsules/github-reader/Dockerfile"}
DEMO_TOKEN = "ghp_demo_secret_token"
GITHUB_ISSUE = {"number": 10, "title": "Demo Issue", "state": "open", "user": {"login": "alice"}, "body": "hello from broker", "html_url": "https://github.com/foo/bar/issues/10"}
def _docker_available() -> bool:
    # 作用：探测 Docker Engine 是否可用；不可用则跳过安全 Demo
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
class FakeHostConnection:
    def __init__(self, decision: str = "allowed-once"):
        # 作用：替代 TS 宿主的反向 RPC 通道——自动批准授权请求并返回 Demo Token，全程记录调用供断言
        self.approvals: list[dict] = []
        self.credential_calls: list[str] = []
        self._decision = decision
    async def call(self, method: str, params: dict | None = None, timeout: float = 30.0):
        # 作用：处理宿主反向调用——approval 返回注入的决定；credential resolve 只按 ref 返回 Demo Token（不缓存）
        if method == "host.approval.request_lease":
            self.approvals.append(params or {})
            return {"decision": self._decision}
        if method == "host.credential.resolve":
            self.credential_calls.append((params or {}).get("ref"))
            return {"value": DEMO_TOKEN}
        raise RuntimeError(f"unexpected host call: {method}")
def _github_transport() -> httpx.MockTransport:
    # 作用：GitHub API Mock——断言请求携带 Demo Token 且只打到预期 Issue 端点（无真实网络）
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == f"Bearer {DEMO_TOKEN}"
        assert request.url.path == "/repos/foo/bar/issues/10"
        return httpx.Response(200, json=GITHUB_ISSUE)
    return httpx.MockTransport(handler)
@pytest.fixture(scope="module")
def demo():
    # 作用：模块级端到端环境——真实 Manager + BrokerServer + LeaseService(SQLite) + 假宿主通道 + Mock GitHub；
    # 用例结束后回收容器与存储
    class DemoEnv:
        pass
    _ensure_images()
    env = DemoEnv()
    env.host = FakeHostConnection()
    env.store = LeaseStore(":memory:")
    asyncio.run(env.store.connect())
    env.gateway = LeaseGateway(LeaseService(env.store), ApprovalClient(env.host))
    env.resolver = CredentialResolver(env.host)
    env.providers = ProviderRegistry()
    env.providers.register(GitHubProvider(transport=_github_transport()))
    env.manager = CapsuleManager(
        REPO_ROOT / "capsules",
        broker_factory=lambda manifest, instance: BrokerServer(manifest, instance, env.gateway, env.resolver, env.providers),
    )
    yield env
    asyncio.run(env.manager.shutdown())
    asyncio.run(env.store.close())
@requires_env
def test_demo_5_issues_read_succeeds_via_broker(demo):
    # 作用：Demo 第 5 项——首次 issues.read 触发宿主 Approval 授权，随后经 Lease→凭据→Provider 全链路成功返回 Issue；
    # 二次调用复用 Lease 不再弹授权；Token 绝不出现在结果中（规格第 18/19/23 节）
    result = asyncio.run(demo.manager.invoke("github_get_issue", {"repo": "foo/bar", "issue_number": 10}, session_id="S100"))
    assert result["number"] == 10
    assert result["title"] == "Demo Issue"
    assert result["author"] == "alice"
    assert DEMO_TOKEN not in str(result)
    assert len(demo.host.approvals) == 1
    assert demo.host.credential_calls.count("GITHUB_TOKEN") >= 1
    result2 = asyncio.run(demo.manager.invoke("github_get_issue", {"repo": "foo/bar", "issue_number": 10}, session_id="S100"))
    assert result2["number"] == 10
    assert len(demo.host.approvals) == 1
@requires_env
def test_demo_6_unauthorized_action_denied(demo):
    # 作用：Demo 第 6 项——manifest 未声明的 repo.delete 即 CAPABILITY_DENIED，且不触发任何 Approval（规格第 27/37 节）
    approvals_before = len(demo.host.approvals)
    with pytest.raises(RuntimeError, match="CAPABILITY_DENIED"):
        asyncio.run(demo.manager.invoke("try_unauthorized_broker_action", {}, session_id="S100"))
    assert len(demo.host.approvals) == approvals_before
@requires_env
def test_demo_7_revoked_lease_denied(demo):
    # 作用：Demo 第 7 项——撤销 Lease 后同会话的 issues.read 立即 LEASE_REVOKED，不静默重签（规格第 20 节）
    asyncio.run(demo.manager.invoke("github_get_issue", {"repo": "foo/bar", "issue_number": 10}, session_id="S300"))
    leases = [l for l in asyncio.run(demo.store.list_all()) if l.session_id == "S300"]
    assert len(leases) == 1
    asyncio.run(LeaseService(demo.store).revoke(leases[0].id, "demo revoke"))
    with pytest.raises(RuntimeError, match="LEASE_REVOKED"):
        asyncio.run(demo.manager.invoke("github_get_issue", {"repo": "foo/bar", "issue_number": 10}, session_id="S300"))
@requires_env
def test_demo_8_cross_session_reuse_denied(demo):
    # 作用：Demo 第 8 项——Session B 尝试复用 Session A 的 Lease 即 LEASE_SESSION_MISMATCH，且不为 B 静默重签（规格第 24/37 节）
    asyncio.run(demo.manager.invoke("github_get_issue", {"repo": "foo/bar", "issue_number": 10}, session_id="S400"))
    approvals_before = len(demo.host.approvals)
    with pytest.raises(RuntimeError, match="LEASE_SESSION_MISMATCH"):
        asyncio.run(demo.manager.invoke("github_get_issue", {"repo": "foo/bar", "issue_number": 10}, session_id="S500"))
    assert len(demo.host.approvals) == approvals_before
@requires_env
def test_demo_9_capsule_crash_runtime_survives(demo):
    # 作用：Demo 第 9 项——malicious-demo 容器自杀后 Runtime 主进程仍正常，实例自动重建恢复可用（规格第 37 节）
    with pytest.raises(RuntimeError):
        asyncio.run(demo.manager.invoke("attack_crash", {}, session_id="S100"))
    result = asyncio.run(demo.manager.invoke("probe_env", {}, session_id="S100"))
    assert "env" in result
