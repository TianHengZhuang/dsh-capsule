from dsh_capsule.broker.errors import BrokerError
from dsh_capsule.capsule.manifest import CapsuleManifest, CredentialRequest
class BrokerPolicy:
    @staticmethod
    def check(manifest: CapsuleManifest, provider: str, action: str) -> CredentialRequest:
        # 作用：manifest 声明校验（规格第 27 节）——请求的 (provider, action) 必须在 capsule.yaml credentials.allowed_actions 内；
        # 未声明的越权请求直接 CAPABILITY_DENIED，绝不进入授权/签发流程（Fail Closed）
        for cred in manifest.credentials:
            if cred.provider == provider:
                if action in cred.allowed_actions:
                    return cred
                raise BrokerError("CAPABILITY_DENIED", f"action {action} not declared by capsule manifest")
        raise BrokerError("CAPABILITY_DENIED", f"provider {provider} not declared by capsule manifest")
