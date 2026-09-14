import { GuardError } from "../capability/errors.js";
import type { BrokerOperation, JsonValue } from "../capability/types.js";
import type { BrokerOperationExecutor } from "../service/capability-service.js";
import type { ProviderAdapter } from "./provider.js";
import type { ProviderRegistry } from "./registry.js";
export const DEFAULT_BROKER_TIMEOUT_MS = 15_000;
export interface CredentialServiceLike {
  // TODO(规则 4)：DSH ctx.credentials 的确切形状以当前安装版本官方 TypeScript 类型定义为准，
  // 本接口仅按规格第 3.2/11.3 节声明 resolve(ref)；接入真实 DSH 时需逐字段核对返回值结构。
  resolve(ref: string): Promise<unknown>;
}
export function findCredentialService(ctx: Record<string, unknown>): CredentialServiceLike | undefined {
  // 作用：从 DSH ctx 上定位 credentials 服务——形状不符（无 resolve 函数）即视为不可用（Fail Closed）
  const credentials = ctx["credentials"];
  if (typeof credentials === "object" && credentials !== null && typeof (credentials as { resolve?: unknown }).resolve === "function") {
    return credentials as CredentialServiceLike;
  }
  return undefined;
}
export interface BrokerDeps {
  /** Guard Core 内置的 Provider 注册表（Managed Extension 不可注册，规格 11.2） */
  registry: ProviderRegistry;
  /** 每个 operation 现场定位 DSH credentials 服务；不可用即 CREDENTIAL_NOT_CONFIGURED */
  getCredentials: () => CredentialServiceLike | undefined;
  /** Provider 执行超时毫秒数（缺省 15000） */
  timeoutMs?: number;
}
// 作用：Credential Broker（重构规格第 11 节 / Phase 3）——实现 CapabilityService 注入的
// BrokerOperationExecutor：Lease 双重校验已由 CapabilityService 完成（规格 10.5），Broker 负责
// Provider 查找、action 白名单、每个 operation 重新 resolve Credential（规格 11.3 禁止跨 operation
// 缓存）、超时控制与错误包装；Credential 值只在本次调用栈内流转，绝不写入日志/审计/Lease/
// Tool Result/异常信息（规格第 18 节）。
export class CredentialBroker implements BrokerOperationExecutor {
  constructor(private readonly deps: BrokerDeps) {}
  async execute(operation: BrokerOperation, signal?: AbortSignal): Promise<JsonValue> {
    // 作用：执行一次 Broker Operation——顺序：operation 字段校验 → Provider 查找（PROVIDER_NOT_FOUND）
    // → action 白名单（ACTION_NOT_ALLOWED）→ per-operation 重新 resolve Credential
    //（CREDENTIAL_NOT_CONFIGURED）→ 合并外部 signal 与超时的 AbortController 交给 Provider
    //（超时 PROVIDER_TIMEOUT；其余错误包装并对消息做 Secret 脱敏，规格 18）
    if (typeof operation?.provider !== "string" || operation.provider.length === 0) {
      throw new GuardError("PROVIDER_NOT_FOUND", "operation.provider must be a non-empty string");
    }
    if (typeof operation?.action !== "string" || operation.action.length === 0) {
      throw new GuardError("ACTION_NOT_ALLOWED", "operation.action must be a non-empty string");
    }
    if (typeof operation?.resource !== "string" || operation.resource.length === 0) {
      throw new GuardError("CAPABILITY_MISMATCH", "operation.resource must be a non-empty string");
    }
    const provider = this.deps.registry.get(operation.provider);
    if (!provider) {
      throw new GuardError("PROVIDER_NOT_FOUND", `provider ${operation.provider} is not registered`);
    }
    if (!provider.allowedActions.includes(operation.action)) {
      throw new GuardError("ACTION_NOT_ALLOWED", `action ${operation.action} is not allowed for provider ${provider.id}`);
    }
    const credential = await this.resolveCredential(provider);
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_BROKER_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      return await provider.execute({ credential, action: operation.action, resource: operation.resource, payload: operation.input, signal: controller.signal });
    } catch (err) {
      if (timedOut) {
        throw new GuardError("PROVIDER_TIMEOUT", `provider ${provider.id} ${operation.action} timed out after ${timeoutMs}ms`);
      }
      if (signal?.aborted) {
        throw new GuardError("PROVIDER_ERROR", `provider ${provider.id} operation aborted by caller`);
      }
      throw wrapProviderError(err, credential);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }
  private async resolveCredential(provider: ProviderAdapter): Promise<string> {
    // 作用：per-operation 重新解析 Credential（规格 11.3：禁止跨 operation 缓存）——先现场定位
    // credentials 服务再 resolve(provider.credentialRef)；服务缺失、resolve 抛错、结果非非空字符串
    //（兼容 string 或 { value: string } 形状）一律 CREDENTIAL_NOT_CONFIGURED，错误信息只含 ref 名
    const service = this.deps.getCredentials();
    if (!service) {
      throw new GuardError("CREDENTIAL_NOT_CONFIGURED", "ctx.credentials unavailable");
    }
    let resolved: unknown;
    try {
      resolved = await service.resolve(provider.credentialRef);
    } catch {
      throw new GuardError("CREDENTIAL_NOT_CONFIGURED", `cannot resolve ${provider.credentialRef}`);
    }
    const value = typeof resolved === "string" ? resolved : typeof resolved === "object" && resolved !== null ? (resolved as { value?: unknown }).value : undefined;
    if (typeof value !== "string" || value.length === 0) {
      throw new GuardError("CREDENTIAL_NOT_CONFIGURED", `cannot resolve ${provider.credentialRef}`);
    }
    return value;
  }
}
function wrapProviderError(err: unknown, credential: string): GuardError {
  // 作用：包装 Provider 抛出的错误——GuardError 保留原错误码、仅对 detail 做 Secret 脱敏后重建；
  // 其余错误统一 PROVIDER_ERROR；消息中出现的 Credential 原文一律替换为 ***（规格 18 防御性兜底）
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof GuardError) {
    const detail = message.startsWith(`${err.code}: `) ? message.slice(err.code.length + 2) : message;
    return new GuardError(err.code, redact(detail, credential));
  }
  return new GuardError("PROVIDER_ERROR", redact(message, credential));
}
function redact(text: string, secret: string): string {
  // 作用：把消息中出现的 Secret 原文替换为 ***——即使 Provider 误泄漏也能在 Broker 出口脱敏
  if (secret.length === 0) return text;
  return text.split(secret).join("***");
}
