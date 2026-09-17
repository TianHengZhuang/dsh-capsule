import { Service, type Context } from "@deepseek-ai/cordis";
import { sha256Scope } from "../capability/canonical.js";
import { GuardError } from "../capability/errors.js";
import type { LeaseManager } from "../capability/lease-manager.js";
import type {
  BrokerOperation,
  CapabilityLease,
  CapabilityScope,
  JsonValue,
  ManagedCapabilityDefinition,
  ManagedCapabilitySource,
  ManagedCapabilitySummary,
  ResolvedManagedCapability,
  ToolRunContext,
} from "../capability/types.js";
// 作用：Provider 实际调用在 Phase 3 由 Broker 注入 executor，未注入时校验通过即 Fail Closed 抛
// PROVIDER_NOT_FOUND（见下方类注释）。
export interface BrokerOperationExecutor {
  // 作用：Phase 3 Broker 将实现的 Provider 执行接口——真正解析 Credential 并调用 External API；
  // Phase 2 仅作为注入点，未注入时 execute 拒绝（Fail Closed）
  execute(operation: BrokerOperation, signal?: AbortSignal): Promise<JsonValue>;
}
export interface CapabilityServiceDeps {
  leases: LeaseManager;
  /** 全局默认 TTL（definition 未指定时使用，与 Universal Policy 的 defaultTtlSeconds 一致） */
  defaultTtlSeconds: number;
  /** TTL 上限（与 Universal Policy 的 maxTtlSeconds 一致，超出拒绝注册） */
  maxTtlSeconds: number;
  /** Phase 3 Broker 注入的 Provider 执行器；Phase 2 不注入 */
  executor?: BrokerOperationExecutor;
}
const RESOURCE_DISPLAY_MAX_LENGTH = 160;
/** Managed Extension 通过 `inject: ["capabilities"]` 依赖的服务名——与 `super(ctx, "capabilities")` 必须一致。 */
export const CAPABILITIES_SERVICE_NAME = "capabilities";
// 作用：CapabilityService（重构规格第 10 节，Phase 2 + 2026-09-14 基线修正）——对 Managed Extension 暴露
// ctx.capabilities：register() 注册语义能力定义、execute() 执行 Broker 双重校验 + Lease 验证、
// revoke/revokeSession/listLeases 代理 LeaseManager。
// 【基线修正】继承 cordis `Service` 并以 `super(ctx, "capabilities")` 注册（而非往 ctx 上硬挂属性）：
// 服务随所属 fiber 卸载自动注销，且 `inject: ["capabilities"]` 的插件能按 DSH 正常依赖注入拿到它；
// 硬挂属性既不参与 service 生命周期，也无法被 `ctx.get("capabilities")` 正确解析。
// 身份一律取 run.agent.id（可信 Tool Runtime 产生，规格 10.3 禁止 Extension 自报 Session）。
export interface BrokerOperationExecutor {
  // 作用：Phase 3 Broker 将实现的 Provider 执行接口——真正解析 Credential 并调用 External API；
  // Phase 2 仅作为注入点，未注入时 execute 拒绝（Fail Closed）
  execute(operation: BrokerOperation, signal?: AbortSignal): Promise<JsonValue>;
}
export interface CapabilityServiceDeps {
  leases: LeaseManager;
  /** 全局默认 TTL（definition 未指定时使用，与 Universal Policy 的 defaultTtlSeconds 一致） */
  defaultTtlSeconds: number;
  /** TTL 上限（与 Universal Policy 的 maxTtlSeconds 一致，超出拒绝注册） */
  maxTtlSeconds: number;
  /** Phase 3 Broker 注入的 Provider 执行器；Phase 2 不注入 */
  executor?: BrokerOperationExecutor;
}
export class CapabilityService extends Service implements ManagedCapabilitySource {
  private readonly definitions = new Map<string, ManagedCapabilityDefinition>();
  constructor(ctx: Context, private readonly deps: CapabilityServiceDeps) {
    // 作用：构造即注册服务——cordis 会把本实例挂到 `ctx.capabilities`，随 ctx 的 fiber 卸载自动注销
    super(ctx, CAPABILITIES_SERVICE_NAME);
  }
  register(definition: ManagedCapabilityDefinition): () => void {
    // 作用：注册一条 Managed 语义能力定义（规格 10.4）——防御校验（Fail Closed）：toolName/provider/
    // action 必须非空字符串，resource 必须函数，ttlSeconds 若提供必须 (0, maxTtlSeconds] 的整数；
    // 同 toolName 重复注册视为热更新覆盖，返回 disposer（注销时仅移除仍是自己那条，防误删后注册的新定义）
    if (typeof definition?.toolName !== "string" || definition.toolName.length === 0) {
      throw new GuardError("CAPABILITY_NOT_REGISTERED", "toolName must be a non-empty string");
    }
    if (typeof definition?.provider !== "string" || definition.provider.length === 0) {
      throw new GuardError("CAPABILITY_NOT_REGISTERED", "provider must be a non-empty string");
    }
    if (typeof definition?.action !== "string" || definition.action.length === 0) {
      throw new GuardError("CAPABILITY_NOT_REGISTERED", "action must be a non-empty string");
    }
    if (typeof definition?.resource !== "function") {
      throw new GuardError("CAPABILITY_NOT_REGISTERED", "resource must be a function of args");
    }
    if (definition.ttlSeconds !== undefined && (!Number.isInteger(definition.ttlSeconds) || definition.ttlSeconds <= 0 || definition.ttlSeconds > this.deps.maxTtlSeconds)) {
      throw new GuardError("LEASE_TTL_INVALID", `definition ${definition.toolName} ttlSeconds must be in (0, maxTtlSeconds]`);
    }
    this.definitions.set(definition.toolName, definition);
    return () => {
      if (this.definitions.get(definition.toolName) === definition) {
        this.definitions.delete(definition.toolName);
      }
    };
  }
  resolve(toolName: string, args: unknown): ResolvedManagedCapability | undefined {
    // 作用：ManagedCapabilitySource 实现（规格 10.4）——Universal Gate 在 tools/pre-execute 优先调用：
    // 命中定义时用 provider/resource/action 生成 managed 语义 Scope；未注册返回 undefined（回落
    // exact-arguments）；resource 计算抛错直接向上传播（Gate 捕获后 Fail Closed 保持原 ask）
    const definition = this.definitions.get(toolName);
    if (!definition) return undefined;
    const resource = this.computeResource(definition, args);
    return {
      scope: this.buildScope(definition, resource),
      ttlSeconds: definition.ttlSeconds ?? this.deps.defaultTtlSeconds,
    };
  }
  async execute(run: ToolRunContext, operation: BrokerOperation): Promise<JsonValue> {
    // 作用：执行 Broker Operation（规格 10.5 双重校验）——身份取可信 ToolRunContext 的 run.agent.id；
    // 用 run.name 查定义、用 run.arguments 重算 expected resource，与 Extension 自报的 provider/
    // action/resource 三重比对，任意不一致抛 CAPABILITY_MISMATCH（Fail Closed）；随后按 managed 语义
    // Scope 校验 Lease（无 Lease 抛 LEASE_REQUIRED，过期/撤销由 LeaseManager 抛出）；全部通过才把
    // operation 交给 executor（Phase 3 Broker；未注入抛 PROVIDER_NOT_FOUND，绝不静默放行）
    if (typeof run?.callId !== "string" || run.callId.length === 0 || typeof run?.name !== "string" || run.name.length === 0 || typeof run?.agent?.id !== "string" || run.agent.id.length === 0) {
      throw new GuardError("CAPABILITY_DENIED", "run context must provide callId/name/agent.id from trusted Tool Runtime");
    }
    const definition = this.definitions.get(run.name);
    if (!definition) {
      throw new GuardError("CAPABILITY_NOT_REGISTERED", `tool ${run.name} has no managed capability definition`);
    }
    const expectedResource = this.computeResource(definition, run.arguments);
    if (typeof operation?.provider !== "string" || typeof operation?.action !== "string" || typeof operation?.resource !== "string") {
      throw new GuardError("CAPABILITY_MISMATCH", "operation provider/action/resource must be strings");
    }
    if (operation.provider !== definition.provider) {
      throw new GuardError("CAPABILITY_MISMATCH", `operation.provider mismatch for tool ${run.name}`);
    }
    if (operation.action !== definition.action) {
      throw new GuardError("CAPABILITY_MISMATCH", `operation.action mismatch for tool ${run.name}`);
    }
    if (operation.resource !== expectedResource) {
      throw new GuardError("CAPABILITY_MISMATCH", `operation.resource does not match expected resource for tool ${run.name}`);
    }
    const scope = this.buildScope(definition, expectedResource);
    const lease = await this.deps.leases.findLatest(run.agent.id, run.name, scope.key);
    if (!lease) {
      throw new GuardError("LEASE_REQUIRED", `no active lease for ${scope.display}`);
    }
    this.deps.leases.validate(lease);
    const executor = this.deps.executor;
    if (!executor || typeof executor.execute !== "function") {
      throw new GuardError("PROVIDER_NOT_FOUND", `tool ${run.name} passed guard validation but no broker executor is installed (Phase 3)`);
    }
    return await executor.execute(operation, run.signal);
  }
  async revoke(leaseId: string, reason?: string): Promise<boolean> {
    // 作用：撤销单个 Lease——代理 LeaseManager（规格 10.2）
    return await this.deps.leases.revoke(leaseId, reason);
  }
  async revokeSession(sessionId: string, reason?: string): Promise<number> {
    // 作用：撤销某 Session 全部 Lease——代理 LeaseManager（规格 10.2）
    return await this.deps.leases.revokeSession(sessionId, reason);
  }
  async listLeases(): Promise<readonly CapabilityLease[]> {
    // 作用：列出全部 Lease——代理 LeaseManager（规格 10.2）
    return await this.deps.leases.list();
  }
  listCapabilities(): readonly ManagedCapabilitySummary[] {
    // 作用：列出全部已注册 Managed 能力定义的安全投影（规格第 10.2/24 节治理查询）——只含
    // toolName/provider/action 与生效 TTL（未指定时回落 defaultTtlSeconds），不暴露 resource 函数
    // 与任何 Secret，供 GovernanceConsole 聚合展示
    return [...this.definitions.values()].map((definition) => ({ toolName: definition.toolName, provider: definition.provider, action: definition.action, ttlSeconds: definition.ttlSeconds ?? this.deps.defaultTtlSeconds }));
  }
  private computeResource(definition: ManagedCapabilityDefinition, args: unknown): string {
    // 作用：调用定义的 resource 函数计算资源标识——任何抛错或返回非字符串一律包装为
    // CAPABILITY_MISMATCH（Fail Closed：无法确定语义 Scope，既不签发也不执行）
    let resource: unknown;
    try {
      resource = definition.resource(args);
    } catch (err) {
      throw new GuardError("CAPABILITY_MISMATCH", `resource resolver failed for tool ${definition.toolName}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof resource !== "string" || resource.length === 0) {
      throw new GuardError("CAPABILITY_MISMATCH", `resource resolver for tool ${definition.toolName} must return a non-empty string`);
    }
    return resource;
  }
  private buildScope(definition: ManagedCapabilityDefinition, resource: string): CapabilityScope {
    // 作用：生成 managed 语义 Scope（规格 5.4.4）——key 只保存 provider/resource/action 的 SHA-256
    // 哈希（Lease 不保存参数原文）；display 给用户展示且超长截断，供 Approval reason 与审计使用
    const displayResource = resource.length > RESOURCE_DISPLAY_MAX_LENGTH ? `${resource.slice(0, RESOURCE_DISPLAY_MAX_LENGTH)}…` : resource;
    return {
      kind: "managed",
      key: sha256Scope({ provider: definition.provider, resource, action: definition.action }),
      display: `provider=${definition.provider} resource=${displayResource} action=${definition.action}`,
      provider: definition.provider,
      resource,
      actions: [definition.action],
    };
  }
}
