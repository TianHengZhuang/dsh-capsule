import { GuardError } from "./errors.js";
import type { ProviderAdapter } from "./provider.js";
// 作用：ProviderRegistry（重构规格第 11 节）——Provider id 到适配器的唯一映射；仅由 Guard Core
// 在组装期注册内置 Provider（如 GitHubProvider），不对 Managed Extension 暴露注册入口（规格 11.2）。
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();
  register(provider: ProviderAdapter): void {
    // 作用：注册一个 Provider——形状防御校验（Fail Closed）：id/credentialRef 必须非空字符串、
    // allowedActions 必须为非空字符串数组、execute 必须是函数；同名重复注册视为组装错误直接抛出
    if (typeof provider?.id !== "string" || provider.id.length === 0) {
      throw new GuardError("PROVIDER_ERROR", "provider id must be a non-empty string");
    }
    if (typeof provider?.credentialRef !== "string" || provider.credentialRef.length === 0) {
      throw new GuardError("PROVIDER_ERROR", `provider ${provider.id} credentialRef must be a non-empty string`);
    }
    if (!Array.isArray(provider?.allowedActions) || provider.allowedActions.length === 0 || provider.allowedActions.some((action) => typeof action !== "string" || action.length === 0)) {
      throw new GuardError("PROVIDER_ERROR", `provider ${provider.id} allowedActions must be a non-empty string array`);
    }
    if (typeof provider?.execute !== "function") {
      throw new GuardError("PROVIDER_ERROR", `provider ${provider.id} must implement execute()`);
    }
    if (this.providers.has(provider.id)) {
      throw new GuardError("PROVIDER_ERROR", `duplicate provider: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }
  get(id: string): ProviderAdapter | undefined {
    // 作用：按 id 查找 Provider——未注册返回 undefined，由 CredentialBroker 按 PROVIDER_NOT_FOUND 处理
    return this.providers.get(id);
  }
  list(): readonly ProviderAdapter[] {
    // 作用：列出全部已注册 Provider（治理/调试用）
    return [...this.providers.values()];
  }
}
