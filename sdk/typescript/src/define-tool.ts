import type { GuardErrorLike, ManagedCapabilityDefinition } from "./types.js";
// 作用：开发期 helper（SDK 第一版，规格第 13 节）——defineCapability 做输入形状防御校验后原样返回，
// 把非法定义拦在扩展启动早期；isGuardError 做 GuardError 形状判别供扩展按错误码分支处理。
// 注意：这里只做形状校验与类型收窄，不复制 Guard Core 的 Lease / Broker / Credential 逻辑。
export const SDK_INVALID_CAPABILITY = "SDK_INVALID_CAPABILITY";
export function defineCapability(definition: ManagedCapabilityDefinition): ManagedCapabilityDefinition {
  // 作用：校验 managed 能力定义的形状（toolName/provider/action 非空字符串、resource 为函数、
  // ttlSeconds 为正整数）——与 Guard Core 注册期校验同一标准，非法即抛 code=SDK_INVALID_CAPABILITY
  if (typeof definition?.toolName !== "string" || definition.toolName.length === 0) {
    throw invalid("toolName must be a non-empty string");
  }
  if (typeof definition?.provider !== "string" || definition.provider.length === 0) {
    throw invalid("provider must be a non-empty string");
  }
  if (typeof definition?.action !== "string" || definition.action.length === 0) {
    throw invalid("action must be a non-empty string");
  }
  if (typeof definition?.resource !== "function") {
    throw invalid("resource must be a function of args");
  }
  if (definition.ttlSeconds !== undefined && (!Number.isInteger(definition.ttlSeconds) || definition.ttlSeconds <= 0)) {
    throw invalid("ttlSeconds must be a positive integer when provided");
  }
  return definition;
}
export function isGuardError(err: unknown): err is GuardErrorLike {
  // 作用：判别 Guard 领域错误——非 null 对象且 code/message 为非空字符串即视为 GuardErrorLike，
  // 供扩展按规格第 18 节错误码（LEASE_REQUIRED / CAPABILITY_MISMATCH 等）分支处理
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" && (err as { code: string }).code.length > 0 && typeof (err as { message?: unknown }).message === "string";
}
function invalid(message: string): Error & { code: string } {
  // 作用：构造带 code 字段的 SDK 校验错误——不引入 Guard Core 的 GuardError 类（逻辑只属于 Guard Core）
  return Object.assign(new Error(`@dsh-capsule/extension-sdk: ${message}`), { code: SDK_INVALID_CAPABILITY });
}
