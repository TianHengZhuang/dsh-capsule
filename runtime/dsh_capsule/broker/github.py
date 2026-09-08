import httpx
from dsh_capsule.broker.errors import BrokerError
GITHUB_API_BASE = "https://api.github.com"
GITHUB_API_VERSION = "2022-11-28"
ISSUES_READ = "issues.read"
class GitHubProvider:
    # 作用：GitHub Provider（规格第 22 节）——MVP 仅支持只读的 issues.read，映射 GET /repos/{owner}/{repo}/issues/{issue_number}
    def __init__(self, api_base: str = GITHUB_API_BASE, timeout: float = 15.0, transport: httpx.AsyncBaseTransport | None = None):
        # 作用：api_base/timeout 可配置；transport 仅供测试注入 MockTransport，生产留空走默认网络栈
        self.name = "github"
        self._api_base = api_base.rstrip("/")
        self._timeout = timeout
        self._transport = transport
    async def execute(self, *, credential: str, action: str, resource: str, payload: dict) -> dict:
        # 作用：执行受控 GitHub 请求——Token 仅用于构造请求头且绝不进入日志/异常；响应只提取白名单字段（规格第 26 节）
        if action != ISSUES_READ:
            raise BrokerError("CAPABILITY_DENIED", f"unsupported action: {action}")
        repo = payload.get("repo")
        issue_number = payload.get("issue_number")
        if not isinstance(repo, str) or len(repo.split("/", 1)) != 2 or not all(repo.split("/", 1)):
            raise BrokerError("BROKER_PROTOCOL_ERROR", "invalid repo (expect owner/repo)")
        if not isinstance(issue_number, int) or isinstance(issue_number, bool) or issue_number < 1:
            raise BrokerError("BROKER_PROTOCOL_ERROR", "invalid issue_number")
        url = f"{self._api_base}/repos/{repo}/issues/{issue_number}"
        headers = {"Authorization": f"Bearer {credential}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": GITHUB_API_VERSION}
        try:
            async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
                resp = await client.get(url, headers=headers)
        except httpx.TimeoutException as exc:
            raise BrokerError("PROVIDER_TIMEOUT", "github request timed out") from exc
        except httpx.HTTPError as exc:
            raise BrokerError("PROVIDER_ERROR", "github request failed") from exc
        if resp.status_code == 404:
            raise BrokerError("PROVIDER_ERROR", "github issue not found")
        if resp.status_code != 200:
            raise BrokerError("PROVIDER_ERROR", f"github status {resp.status_code}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise BrokerError("PROVIDER_ERROR", "invalid github response body") from exc
        return {
            "number": data.get("number"), "title": data.get("title"), "state": data.get("state"),
            "author": (data.get("user") or {}).get("login"), "body": data.get("body"), "html_url": data.get("html_url"),
        }
