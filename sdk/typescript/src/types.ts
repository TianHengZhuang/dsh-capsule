// 作用：Managed Extension 视角的类型声明（SDK 第一版，规格第 13 节）——只包含扩展作者编写
// Guard 标准扩展所需的形状；与 Guard Core 接口保持结构兼容（鸭子类型），但不依赖 adapter 包，
// 第三方只装 SDK 即可开发。禁止在本文件复制 Lease 签发 / Broker 校验 / Credential 解析逻辑。
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
// 作用：DSH Tool Runtime 产生的运行上下文最小形状（规格第 10.3 节）——身份（callId/agent.id）来自
// 可信 Runtime 而非 Tool 自报；调用 ctx.capabilities.execute 时必须传入，agent 缺失会被 Guard 拒绝。
export interface ToolRunContext {
  callId: string;
  rootCallId: string;
  name: string;
  arguments: unknown;
  agent?: { id: string };
  signal?: AbortSignal;
}
// 作用：Broker Operation（规格第 10.2 节）——扩展执行受控高权限操作时自报的目标；Guard 会用
// run.arguments 重算 expected resource 做双重校验（规格 10.5），resource 与定义不一致会抛
// CAPABILITY_MISMATCH（Fail Closed），因此 resource 必须与注册时 resource(args) 同源计算。
export interface BrokerOperation {
  provider: string;
  resource: string;
  action: string;
  input: JsonValue;
}
// 作用：Managed 语义能力定义（规格第 10.2 节）——toolName + provider + action 固定，resource 是
// 从调用参数确定性计算资源标识的纯函数（如 repo:owner/repo）；ttlSeconds 缺省用 Guard 全局默认。
export interface ManagedCapabilityDefinition {
  toolName: string;
  provider: string;
  action: string;
  resource: (args: unknown) => string;
  ttlSeconds?: number;
}
// 作用：ctx.capabilities 的扩展侧最小接口（规格第 10.2 节）——只暴露 register 与 execute：
// register 注册语义能力定义（返回注销函数），execute 经 Guard 双重校验 + Lease 验证后由 Broker
// 执行 Provider Operation 并返回业务结果；治理接口（revoke/listLeases 等）属于宿主，不对扩展暴露。
export interface GuardCapabilities {
  register(definition: ManagedCapabilityDefinition): () => void;
  execute(run: ToolRunContext, operation: BrokerOperation): Promise<JsonValue>;
}
// 作用：DSH 宿主上下文的扩展侧最小形状——Extension 通过 inject "capabilities" 拿到本接口；
// GuardError 形状（code + message），用于扩展侧按规格第 18 节错误码做分支处理。
export interface GuardPluginContext {
  capabilities: GuardCapabilities;
}
// 作用：Guard 抛出的领域错误最小形状（规格第 18 节错误码：LEASE_REQUIRED / CAPABILITY_MISMATCH /
// CREDENTIAL_NOT_CONFIGURED 等）——SDK 只声明形状，不复制 Guard Core 的错误类实现。
export interface GuardErrorLike {
  code: string;
  message: string;
}
