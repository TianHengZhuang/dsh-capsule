import asyncio
import httpx
import pytest
from dsh_capsule.broker.errors import BrokerError
from dsh_capsule.broker.github import GitHubProvider
GITHUB_ISSUE = {"number": 10, "title": "T", "state": "open", "user": {"login": "alice"}, "body": "B", "html_url": "https://example.com/10"}
def _provider(handler) -> GitHubProvider:
    # 作用：构造注入 MockTransport 的 GitHubProvider（不发真实网络请求）
    return GitHubProvider(transport=httpx.MockTransport(handler))
def test_issues_read_maps_whitelist_fields():
    # 作用：issues.read 正常路径——URL 与 Authorization 头正确，响应只提取白名单字段（规格第 26 节）
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/foo/bar/issues/10"
        assert request.headers["Authorization"] == "Bearer ghp_test"
        assert request.headers["Accept"] == "application/vnd.github+json"
        return httpx.Response(200, json=GITHUB_ISSUE)
    provider = _provider(handler)
    result = asyncio.run(provider.execute(credential="ghp_test", action="issues.read", resource="repo:foo/bar", payload={"repo": "foo/bar", "issue_number": 10}))
    assert result == {"number": 10, "title": "T", "state": "open", "author": "alice", "body": "B", "html_url": "https://example.com/10"}
def test_unsupported_action_denied():
    # 作用：非 issues.read 的 action（如 repo.delete）即 CAPABILITY_DENIED——只读 Provider，无网络请求发出
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not reach network")
    provider = _provider(handler)
    with pytest.raises(BrokerError, match="CAPABILITY_DENIED"):
        asyncio.run(provider.execute(credential="ghp_test", action="repo.delete", resource="repo:foo/bar", payload={"repo": "foo/bar", "issue_number": 1}))
def test_invalid_repo_payload_denied():
    # 作用：payload 的 repo 缺 owner/repo 结构即 BROKER_PROTOCOL_ERROR（不信任容器提交的数据）
    provider = _provider(lambda request: httpx.Response(200, json={}))
    for bad_repo in ("foobar", "", "/bar", "foo/"):
        with pytest.raises(BrokerError, match="BROKER_PROTOCOL_ERROR"):
            asyncio.run(provider.execute(credential="ghp_test", action="issues.read", resource="repo:foo/bar", payload={"repo": bad_repo, "issue_number": 1}))
def test_invalid_issue_number_denied():
    # 作用：issue_number 非正整数即 BROKER_PROTOCOL_ERROR
    provider = _provider(lambda request: httpx.Response(200, json={}))
    for bad in (0, -1, "10", 1.5, None, True):
        with pytest.raises(BrokerError, match="BROKER_PROTOCOL_ERROR"):
            asyncio.run(provider.execute(credential="ghp_test", action="issues.read", resource="repo:foo/bar", payload={"repo": "foo/bar", "issue_number": bad}))
def test_not_found_maps_provider_error():
    # 作用：GitHub 404 映射 PROVIDER_ERROR（issue not found），不透传原始响应体
    provider = _provider(lambda request: httpx.Response(404, json={"message": "Not Found"}))
    with pytest.raises(BrokerError, match="PROVIDER_ERROR"):
        asyncio.run(provider.execute(credential="ghp_test", action="issues.read", resource="repo:foo/bar", payload={"repo": "foo/bar", "issue_number": 999}))
def test_non_200_maps_provider_error():
    # 作用：非 200/404 状态码（如 403）映射 PROVIDER_ERROR + 状态码，消息不含 Token
    provider = _provider(lambda request: httpx.Response(403, json={"message": "rate limited"}))
    with pytest.raises(BrokerError, match="PROVIDER_ERROR: github status 403"):
        asyncio.run(provider.execute(credential="ghp_test", action="issues.read", resource="repo:foo/bar", payload={"repo": "foo/bar", "issue_number": 1}))
def test_timeout_maps_provider_timeout():
    # 作用：httpx 超时异常映射 PROVIDER_TIMEOUT，异常链不含 Secret
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out")
    provider = _provider(handler)
    with pytest.raises(BrokerError, match="PROVIDER_TIMEOUT"):
        asyncio.run(provider.execute(credential="ghp_test", action="issues.read", resource="repo:foo/bar", payload={"repo": "foo/bar", "issue_number": 1}))
def test_network_error_maps_provider_error():
    # 作用：httpx 网络异常映射 PROVIDER_ERROR
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failure")
    provider = _provider(handler)
    with pytest.raises(BrokerError, match="PROVIDER_ERROR"):
        asyncio.run(provider.execute(credential="ghp_test", action="issues.read", resource="repo:foo/bar", payload={"repo": "foo/bar", "issue_number": 1}))
def test_invalid_json_body_maps_provider_error():
    # 作用：响应体非 JSON 映射 PROVIDER_ERROR
    provider = _provider(lambda request: httpx.Response(200, content=b"not-json", headers={"Content-Type": "application/json"}))
    with pytest.raises(BrokerError, match="PROVIDER_ERROR"):
        asyncio.run(provider.execute(credential="ghp_test", action="issues.read", resource="repo:foo/bar", payload={"repo": "foo/bar", "issue_number": 1}))
