import type { AuditService } from "../audit/audit-service.js";
import type { AuditDecision } from "../audit/types.js";
import type { ResolvedToolPolicy, PolicyResolver } from "./policy.js";
import type { LeaseManager } from "./lease-manager.js";
import type { PendingRegistry } from "./pending.js";
import type { ScopeResolver } from "./scope-resolver.js";
import type { ApprovalOutcome, ApprovalRequestLike, CapabilityScope, LeaseKind, ManagedCapabilitySource, PreToolDecision, ResolvedManagedCapability, ToolExecutionLike } from "./types.js";
// 作用：Universal Gate（重构规格第 6 节）——Guard 横切 DSH 原生 Tool Pipeline 的三个 hook：
// tools/pre-execute（prepend 外层中间件，只接管下游返回 ask 的调用）、approval/request（捕获
// allowed-once 后签发 Lease）、tools/result（清理 pending + 记录最终结果）。
// 纯逻辑与 DSH 事件总线安装分离（install），保证核心算法可独立单测。
export interface UniversalGateDeps {
  policy: PolicyResolver;
  scopes: ScopeResolver;
  leases: LeaseManager;
  pending: PendingRegistry;
  audit: AuditService;
  /** Phase 2：Managed 语义能力查询（CapabilityService 实现）——已注册 Tool 优先用 provider/resource/action 语义 Scope */
  managed?: ManagedCapabilitySource;
  /** 可注入时钟（默认 Date.now），保证 TTL/GC 语义可模拟时间测试 */
  now?: () => number;
}
export interface GuardEventBus {
  // TODO(规则 4)：事件名/handler 签名/prepend 选项以当前安装 DSH 版本官方 TypeScript 类型为准
  //（规格第 34 节校验基线 2026-09-14），接入真实 DSH 时逐项核对，禁止凭猜测硬编码。
  on(event: string, handler: (...args: any[]) => any, options?: { prepend?: boolean }): unknown;
}
export class UniversalGate {
  private readonly now: () => number;
  constructor(private readonly deps: UniversalGateDeps) {
    this.now = deps.now ?? Date.now;
  }
  async handlePreExecute(exec: ToolExecutionLike, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    // 作用：tools/pre-execute 处理器（规格 6.2 算法）——先调 next() 获得下游原生 DSH Policy 的最终
    // PreToolDecision：deny 永远透传（Lease 不得覆盖 DENY）；allow 不制造新 Approval；只有 ask 才进入
    // Guard：命中有效 Lease → allow（复用），否则保持 ask 并在 reason 中明确告知批准将签发 Lease。
    this.deps.pending.gc(this.now());
    if (typeof exec?.callId !== "string" || exec.callId.length === 0 || typeof exec?.name !== "string" || exec.name.length === 0) {
      return await next();
    }
    const downstream = await next();
    if (downstream?.kind === "deny") {
      this.recordAudit(exec, "PASSTHROUGH_DENY");
      return downstream;
    }
    if (downstream?.kind === "allow") {
      this.recordAudit(exec, "PASSTHROUGH_ALLOW");
      return downstream;
    }
    if (downstream?.kind !== "ask") {
      return downstream;
    }
    const sessionId = exec.agent?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      // 无 agent/session：禁止创建 Session Lease（不得发明 global/anonymous lease），保持原始 ask 语义
      return downstream;
    }
    let policy: ResolvedToolPolicy;
    try {
      policy = this.deps.policy.resolve(exec.name);
    } catch {
      // 策略解析失败（如 TTL 非法）：Fail Closed，不接管，保持原 ask
      return downstream;
    }
    if (!policy.enabled) {
      return downstream;
    }
    let scope: CapabilityScope;
    let ttlSeconds: number;
    let leaseKind: LeaseKind = "universal";
    const managed = this.resolveManaged(exec.name, exec.arguments);
    if (managed) {
      // 已注册 managed Tool：优先用 provider/resource/action 语义 Scope（规格 10.4），TTL 来自 definition
      scope = managed.scope;
      ttlSeconds = managed.ttlSeconds;
      leaseKind = "managed";
    } else {
      try {
        scope = this.deps.scopes.resolve({ toolName: exec.name, arguments: exec.arguments }, policy);
      } catch {
        // Scope 解析失败：Fail Closed，不签发 Lease，保持原 ask
        return downstream;
      }
      ttlSeconds = policy.ttlSeconds;
    }
    const lease = await this.deps.leases.findMatching(sessionId, exec.name, scope.key);
    if (lease) {
      this.deps.pending.set(
        {
          callId: exec.callId,
          rootCallId: exec.rootCallId,
          sessionId,
          toolName: exec.name,
          scope,
          ttlSeconds: policy.ttlSeconds,
          startedAt: this.now(),
          leaseId: lease.id,
          decision: "LEASE_REUSED",
        },
        exec.signal,
      );
      this.recordAudit(exec, "LEASE_REUSED", { scopeKey: scope.key, scopeDisplay: scope.display, leaseId: lease.id });
      return { kind: "allow" };
    }
    this.deps.pending.set(
      {
        callId: exec.callId,
        rootCallId: exec.rootCallId,
        sessionId,
        toolName: exec.name,
        scope,
        ttlSeconds,
        startedAt: this.now(),
        decision: "ASKED",
        leaseKind,
      },
      exec.signal,
    );
    this.recordAudit(exec, "ASK", { scopeKey: scope.key, scopeDisplay: scope.display });
    return { kind: "ask", reason: appendGuardReason(downstream.reason, scope, ttlSeconds) };
  }
  async handleApprovalRequest(req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    // 作用：approval/request 处理器（规格 6.3 算法）——先交给真正的 DSH human/machine answerer（next），
    // 仅当该 callId 是 Guard 管理的 ASK 且结果为 allowed-once 时签发 Lease；rejected/cancelled/unavailable
    // 一律不签发并清理 pending；不修改 outcome，不绕过 approval policy=never（answerer 内部处理）
    if (typeof req?.callId !== "string" || req.callId.length === 0) {
      return await next();
    }
    const pendingExec = this.deps.pending.get(req.callId);
    if (!pendingExec) {
      return await next();
    }
    const outcome = await next();
    if (normalizeOutcome(outcome) === "allowed-once") {
      try {
        const lease = await this.deps.leases.issue({
          sessionId: pendingExec.sessionId,
          toolName: pendingExec.toolName,
          scope: pendingExec.scope,
          ttlSeconds: pendingExec.ttlSeconds,
          kind: pendingExec.leaseKind ?? "universal",
          sourceCallId: req.callId,
        });
        pendingExec.leaseId = lease.id;
        pendingExec.decision = "APPROVED";
        this.deps.audit.record({
          sessionId: pendingExec.sessionId,
          callId: pendingExec.callId,
          rootCallId: pendingExec.rootCallId,
          toolName: pendingExec.toolName,
          scopeKey: pendingExec.scope.key,
          scopeDisplay: pendingExec.scope.display,
          leaseId: lease.id,
          decision: "LEASE_ISSUED",
        });
      } catch (err) {
        // 签发失败（防御路径）：Fail Closed 不签发，仅写 stderr 诊断日志（不含任何 Secret）
        process.stderr.write(`[dsh-guard] lease issue failed for call ${req.callId}: ${String(err)}\n`);
      }
    } else {
      pendingExec.decision = "REJECTED";
      this.deps.audit.record({
        sessionId: pendingExec.sessionId,
        callId: pendingExec.callId,
        rootCallId: pendingExec.rootCallId,
        toolName: pendingExec.toolName,
        scopeKey: pendingExec.scope.key,
        scopeDisplay: pendingExec.scope.display,
        decision: "APPROVAL_REJECTED",
      });
      // 非 allowed-once：调用不会执行，不会再有 tools/result 兜底，立即清理 pending（规格 22.13）
      this.deps.pending.delete(req.callId);
    }
    return outcome;
  }
  handleToolResult(exec: ToolExecutionLike, result: { isError?: boolean }): void {
    // 作用：tools/result 观察者（规格 6.4）——记录最终结果与 Lease 使用情况，清理 pending；不得修改结果
    const current = typeof exec?.callId === "string" ? this.deps.pending.get(exec.callId) : undefined;
    this.recordAudit(exec, result?.isError ? "TOOL_ERROR" : "TOOL_SUCCESS", current ? { scopeKey: current.scope.key, scopeDisplay: current.scope.display, leaseId: current.leaseId } : undefined);
    if (typeof exec?.callId === "string") {
      this.deps.pending.delete(exec.callId);
    }
  }
  install(bus: GuardEventBus): () => void {
    // 作用：把三个 handler 挂到 DSH 事件总线——pre-execute 与 approval/request 均 prepend（成为
    // 外层中间件，先 next() 拿到下游最终决策）；返回 dispose 函数（调用各 disposer 并清空 pending）
    if (typeof bus?.on !== "function") {
      throw new Error("GUARD_INSTALL_FAILED: bus.on unavailable");
    }
    const disposers: unknown[] = [];
    disposers.push(bus.on("tools/pre-execute", (exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) => this.handlePreExecute(exec, next), { prepend: true }));
    disposers.push(bus.on("approval/request", (req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => this.handleApprovalRequest(req, next), { prepend: true }));
    disposers.push(bus.on("tools/result", (exec: ToolExecutionLike, result: { isError?: boolean }) => this.handleToolResult(exec, result ?? {})));
    return () => {
      for (const disposer of disposers) {
        if (typeof disposer === "function") (disposer as () => void)();
      }
      this.deps.pending.clear();
    };
  }
  private resolveManaged(toolName: string, args: unknown): ResolvedManagedCapability | undefined {
    // 作用：查询 managed 语义能力定义（规格 10.4）——未注入 managed 源或 Tool 未注册返回 undefined
    // （回落 exact-arguments 默认策略）；定义解析抛错 Fail Closed 视为无定义，保持原 ask 不签发
    if (!this.deps.managed) return undefined;
    try {
      return this.deps.managed.resolve(toolName, args);
    } catch {
      return undefined;
    }
  }
  private recordAudit(exec: ToolExecutionLike, decision: AuditDecision, extra?: { scopeKey?: string; scopeDisplay?: string; leaseId?: string }): void {
    // 作用：组装审计事件——只含 Session/callId/Tool 名/Scope 哈希与脱敏 display/Lease id，绝不含参数原文
    this.deps.audit.record({
      sessionId: typeof exec?.agent?.id === "string" ? exec.agent.id : undefined,
      callId: typeof exec?.callId === "string" ? exec.callId : "",
      rootCallId: typeof exec?.rootCallId === "string" ? exec.rootCallId : "",
      toolName: typeof exec?.name === "string" ? exec.name : "",
      decision,
      ...extra,
    });
  }
}
function normalizeOutcome(outcome: ApprovalOutcome | { decision?: string } | unknown): string | undefined {
  // 作用：归一化 Approval 结果——支持字符串与 {decision} 对象两种形状（以实际 DSH 返回形状为准）
  if (typeof outcome === "string") return outcome;
  if (typeof outcome === "object" && outcome !== null) {
    const decision = (outcome as { decision?: unknown }).decision;
    if (typeof decision === "string") return decision;
  }
  return undefined;
}
function appendGuardReason(original: string | undefined, scope: CapabilityScope, ttlSeconds: number): string {
  // 作用：在原始 ask reason 后追加 Guard 说明（规格 4.2）——用户必须明确看到"批准将签发什么 Scope、
  // 多长 TTL 的 Lease"，只有看到该信息并返回 allowed-once 后才允许创建 Lease（禁止静默扩展）
  const guardNote = `DSH Guard：批准本次请求将为当前 Session 签发一个 Scope=${scope.display}、TTL=${ttlSeconds}s 的短期 Lease；Lease 在到期前同 Scope 可复用，且可主动撤销。`;
  return original ? `${original}；${guardNote}` : guardNote;
}
