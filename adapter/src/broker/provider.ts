import type { JsonValue } from "../capability/types.js";
// 作用：Provider 适配器契约（重构规格第 11.1 节）——Provider 是 Trusted Code，由 Guard Core
// 内置/审核后注册进 ProviderRegistry；Provider 会真正接触 Credential，因此 Managed Extension
// 不允许自行注册 Provider（规格 11.2），防止"Secret 不进入 Extension"的承诺失效。
export interface ProviderExecuteInput {
  /** 已解析的真实 Credential；仅允许用于构造外部 API 请求头，禁止写入日志/审计/异常/返回值 */
  credential: string;
  /** 经 CapabilityService 双重校验后的语义 action */
  action: string;
  /** 经 Lease Scope 绑定并校验的语义资源标识（如 repo:owner/repo） */
  resource: string;
  /** Extension 提供的业务输入（不包含 Credential） */
  payload: JsonValue;
  /** Broker 统一注入的中止信号（已合并调用方 signal 与超时） */
  signal: AbortSignal;
}
export interface ProviderAdapter {
  /** Provider 唯一标识，与 BrokerOperation.provider 对应 */
  readonly id: string;
  /** DSH ctx.credentials.resolve 使用的 Credential 引用名（不是 Secret 本身） */
  readonly credentialRef: string;
  /** 本 Provider 允许执行的 action 白名单 */
  readonly allowedActions: readonly string[];
  execute(input: ProviderExecuteInput): Promise<JsonValue>;
}
