import pytest
from dsh_capsule.broker.errors import BrokerError
from dsh_capsule.broker.policy import BrokerPolicy
from dsh_capsule.broker.providers import ProviderRegistry
from dsh_capsule.capsule.manifest import CapsuleManifest, CredentialRequest, ManifestMetadata, RuntimeSpec, ToolSpec
def _manifest(credentials: list[CredentialRequest]) -> CapsuleManifest:
    # 作用：构造带 credentials 声明的最小合法 manifest
    return CapsuleManifest(
        apiVersion="dsh-capsule/v1", kind="Capsule",
        metadata=ManifestMetadata(id="github-reader", version="0.1.0"),
        runtime=RuntimeSpec(image="img:0.1", command=["python", "/app/app.py"]),
        credentials=credentials,
        tools=[ToolSpec(name="github_get_issue")],
    )
def test_declared_action_passes():
    # 作用：manifest 已声明的 (provider, action) 通过并返回对应 CredentialRequest（含 credential_ref 与 TTL）
    manifest = _manifest([CredentialRequest(provider="github", credential_ref="GITHUB_TOKEN", allowed_actions=["issues.read"], default_ttl_seconds=600, max_ttl_seconds=1800)])
    cred = BrokerPolicy.check(manifest, "github", "issues.read")
    assert cred.credential_ref == "GITHUB_TOKEN"
    assert cred.default_ttl_seconds == 600
def test_undeclared_action_denied():
    # 作用：provider 已声明但 action 未声明（越权 repo.delete）即 CAPABILITY_DENIED（规格第 27 节）
    manifest = _manifest([CredentialRequest(provider="github", credential_ref="GITHUB_TOKEN", allowed_actions=["issues.read"])])
    with pytest.raises(BrokerError, match="CAPABILITY_DENIED"):
        BrokerPolicy.check(manifest, "github", "repo.delete")
def test_undeclared_provider_denied():
    # 作用：manifest 未声明的 provider 即 CAPABILITY_DENIED
    manifest = _manifest([CredentialRequest(provider="github", credential_ref="GITHUB_TOKEN", allowed_actions=["issues.read"])])
    with pytest.raises(BrokerError, match="CAPABILITY_DENIED"):
        BrokerPolicy.check(manifest, "dropbox", "files.read")
def test_provider_registry_register_and_get():
    # 作用：注册表按名称查找；未注册返回 None（由调用方按 PROVIDER_NOT_FOUND 处理）
    registry = ProviderRegistry()
    class FakeProvider:
        name = "github"
    provider = FakeProvider()
    registry.register(provider)
    assert registry.get("github") is provider
    assert registry.get("dropbox") is None
def test_provider_registry_duplicate_denied():
    # 作用：同名重复注册即 BROKER_PROTOCOL_ERROR（Fail Closed）
    registry = ProviderRegistry()
    class FakeProvider:
        name = "github"
    registry.register(FakeProvider())
    with pytest.raises(BrokerError, match="BROKER_PROTOCOL_ERROR"):
        registry.register(FakeProvider())
