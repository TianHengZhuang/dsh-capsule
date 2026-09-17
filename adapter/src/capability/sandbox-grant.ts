import type { LeaseManager } from "./lease-manager.js";
import { isModeWiderThan, type SandboxMode } from "./escalation.js";
// 作用：会话沙箱模式的有界授权（P0-2）——把「批准的沙箱升级」变成 DSH 真正会执行的状态。
// 背景（见 docs/集成基线-真实DSH行为.md 第 5 节）：Lease 本身不影响 DSH 沙箱判定，
// 必须调用 dsh-sandbox-policy 的 setSandboxMode(session, mode) 提升会话模式才会真正生效；
// 而该模式写入的是【持久 session log】，原生没有任何过期机制——TTL 与回滚正是本模块补上的部分。
//
// 【红线 1】只允许写沙箱模式：绝不调用 permissionPresets.set / approval.setPolicy
//   （内置 danger-full-access preset 配的是 approval: never，调用即永久关闭审批）。因此本模块
//   只依赖一个只有「读模式 / 写模式」两个动作的窄接口，编译期就无法触及其他权限旋钮。
// 【红线 2】回滚必须做冲突检测：以「Guard 对该 session 最后一次写入的值」为唯一基准，
//   当前模式与之不符即认定用户已手动改动 → 跳过回滚并报告 SKIPPED_USER_OVERRIDE。
//   注意不能拿单条授权的 writtenMode 做比较：多条授权交替提升时，后一条授权会改写模式，
//   使前一条授权的 writtenMode 过期，从而把 Guard 自己的写入误判成用户改动。
// 【红线 3】正确性不依赖定时器：授权有效性一律在读写时实时比较 Date.now()（与 Lease 同一原则）。
/** 沙箱模式的宿主接口——最小权限面：只有读取当前模式与写入模式，不含任何其他权限旋钮。
 * 两个方法都接收【session 对象本身】而不是 id：真实实现需要它去读 session log
 * （`ctx.sessionProjections.stateOf(session,"sandboxMode")`）与写新事件（`session.append("sandbox/mode", …)`），
 * 而服务本身不提供按 id 反查 session 的能力时，由调用方先解析一次再传入。 */
export interface SandboxContext {
  /** 读取该 session 当前生效的沙箱模式（真实实现读 ctx.sandboxPolicy.overrideOf(session)）。 */
  sessionSandboxMode(session: unknown): SandboxMode;
  /** 写入该 session 的沙箱模式（真实实现调 setSandboxMode(session, mode)）。 */
  setSessionSandboxMode(session: unknown, mode: SandboxMode): void;
}
/** 模式提升/回滚的结果——供上层写审计与决定是否签发 Lease。 */
export type SandboxModeOutcome = "RAISED" | "UNCHANGED" | "RESTORED" | "SKIPPED_USER_OVERRIDE";
export interface SandboxModeResult {
  outcome: SandboxModeOutcome;
  mode: SandboxMode;
  /** 仅 outcome === "RAISED" 时存在：提升前的模式，供审计留痕 */
  baselineMode?: SandboxMode;
}
interface Grant {
  leaseId: string;
  sessionId: string;
  /** 提升时解析到的 session 对象——回滚时复用它，避免再次反查（也保证读写的必须是同一个 session） */
  session: unknown;
  toolName: string;
  requestedMode: SandboxMode;
  /** Guard 提升该授权时写入的值——仅用于治理视图展示，不用于冲突检测（见红线 2） */
  writtenMode: SandboxMode;
  /** 该授权是否真的触发过模式写入——未写入的授权释放时无需回滚，也不该报「用户改动」 */
  raised: boolean;
}
interface SessionState {
  /** 该 session 在 Guard 介入之前的模式——回滚的最终落点 */
  baseline: SandboxMode;
  /** Guard 对该 session 最后一次写入的值；undefined 表示 Guard 从未写过 */
  lastWritten?: SandboxMode;
}
export class SandboxGrantManager {
  private readonly grants = new Map<string, Grant>();
  private readonly sessions = new Map<string, SessionState>();
  constructor(
    private readonly sandbox: SandboxContext,
    private readonly leases: Pick<LeaseManager, "isLive">,
  ) {}
  async applyGrant(input: { leaseId: string; sessionId: string; session: unknown; toolName: string; requestedMode: SandboxMode }): Promise<SandboxModeResult> {
    // 作用：在一次沙箱升级被批准并签发 Lease 之后调用——按「所有活跃授权里最宽的模式」决定是否提升，
    // 并记录该 session 的 baseline（Guard 介入前的模式）供日后回滚。
    // 【顺序要求】必须先 settle() 清理失效授权，再做后续判断；若放在判断之后，会把本次刚记录的授权
    // 一起当成失效项回收（同一 session 连续授权时模式永远升不上去）。
    await this.settle();
    const existing = this.grants.get(input.leaseId);
    if (existing) {
      // 同一 Lease 重复提升（例如重放同一 callId）——幂等，不重复写 session log
      return { outcome: "UNCHANGED", mode: existing.writtenMode };
    }
    const current = this.sandbox.sessionSandboxMode(input.session);
    const state = this.sessions.get(input.sessionId) ?? { baseline: current };
    this.sessions.set(input.sessionId, state);
    if (state.lastWritten !== undefined && current !== state.lastWritten) {
      // 用户在该 session 内手动改过模式：不覆盖用户选择，本次不提升（Fail Closed 方向：不动权限）
      return { outcome: "SKIPPED_USER_OVERRIDE", mode: current };
    }
    const target = this.highestActiveMode(input.sessionId, input.requestedMode);
    if (!isModeWiderThan(target, current)) {
      // 当前模式已足够宽（或已由更宽的授权覆盖）——不写 session log，避免无意义的模式抖动
      this.grants.set(input.leaseId, { leaseId: input.leaseId, sessionId: input.sessionId, session: input.session, toolName: input.toolName, requestedMode: input.requestedMode, writtenMode: current, raised: false });
      return { outcome: "UNCHANGED", mode: current };
    }
    this.sandbox.setSessionSandboxMode(input.session, target);
    state.lastWritten = target;
    this.grants.set(input.leaseId, { leaseId: input.leaseId, sessionId: input.sessionId, session: input.session, toolName: input.toolName, requestedMode: input.requestedMode, writtenMode: target, raised: true });
    return { outcome: "RAISED", mode: target, baselineMode: state.baseline };
  }
  async releaseGrant(leaseId: string): Promise<SandboxModeResult | undefined> {
    // 作用：Lease 被撤销或到期时调用——回滚该 session 的模式。算法：
    //   1. 冲突检测：当前模式 ≠ Guard 最后写入值 → 用户手动改过 → 跳过回滚（SKIPPED_USER_OVERRIDE）；
    //   2. 仍有其他活跃授权需要更宽模式 → 写回「剩余需求中最宽的那个」，而不是 baseline；
    //   3. 否则写回 baseline（若与当前相同则不写，避免多余事件）。
    // 无该 Lease 的授权记录（例如从未真正提升过）返回 undefined，表示无需回滚。
    const grant = this.grants.get(leaseId);
    if (!grant) return undefined;
    this.grants.delete(leaseId);
    const current = this.sandbox.sessionSandboxMode(grant.session);
    const state = this.sessions.get(grant.sessionId);
    if (!grant.raised || !state || state.lastWritten === undefined) {
      // 该授权从未真正写入过模式（当时已足够宽）——没有需要回滚的内容
      return { outcome: "UNCHANGED", mode: current };
    }
    if (current !== state.lastWritten) {
      // Guard 写入之后模式又被改过（用户手动切换 / 更宽授权改写）——不覆盖，交还给用户
      return { outcome: "SKIPPED_USER_OVERRIDE", mode: current };
    }
    const target = this.remainingActiveMode(grant.sessionId) ?? state.baseline;
    if (target === current) {
      return { outcome: "UNCHANGED", mode: current };
    }
    this.sandbox.setSessionSandboxMode(grant.session, target);
    state.lastWritten = target;
    return { outcome: "RESTORED", mode: target };
  }
  async settle(): Promise<SandboxModeResult[]> {
    // 作用：低频结算——遍历授权表，对「Lease 已撤销 / 已过期 / 已不存在」的授权执行回滚。
    // 调用点：tools/execute 每次进入时（与 PendingRegistry.gc 同一时机）以及 Lease revoke。
    // 安全正确性不依赖本方法：即使从未调用，失效 Lease 也不会再授权任何新调用——settle 只负责把
    // 【已经不该生效的会话宽模式】收回，属收缩权限方向，因此晚执行不会造成越权。
    // 【禁止接收时间参数】有效性一律由 LeaseManager.isLive 用其自身时钟判定，避免出现「调用方挂钟 vs
    // Lease 时钟」两套时间基准导致把有效授权误判为失效（该缺陷已由测试捕获）。
    const results: SandboxModeResult[] = [];
    for (const grant of [...this.grants.values()]) {
      if (this.leases.isLive(grant.leaseId)) continue;
      const result = await this.releaseGrant(grant.leaseId);
      if (result) results.push(result);
    }
    return results;
  }
  async releaseSession(sessionId: string): Promise<SandboxModeResult[]> {
    // 作用：某 session 全部授权一次性回收（session 结束 / 用户主动收回）——逐条释放以复用
    // 「最宽剩余需求」计算；同时清理该 session 的状态记录与授权条目，避免长期驻留内存。
    const results: SandboxModeResult[] = [];
    for (const grant of [...this.grants.values()]) {
      if (grant.sessionId !== sessionId) continue;
      const result = await this.releaseGrant(grant.leaseId);
      if (result) results.push(result);
    }
    for (const [leaseId, grant] of [...this.grants.entries()]) {
      if (grant.sessionId === sessionId) this.grants.delete(leaseId);
    }
    this.sessions.delete(sessionId);
    return results;
  }
  activeGrants(): readonly { leaseId: string; sessionId: string; toolName: string; requestedMode: SandboxMode; writtenMode: SandboxMode }[] {
    // 作用：治理视图用的只读投影（只含当前活跃授权，不含 baseline 等历史信息）
    return [...this.grants.values()].map(({ leaseId, sessionId, toolName, requestedMode, writtenMode }) => ({ leaseId, sessionId, toolName, requestedMode, writtenMode }));
  }
  private highestActiveMode(sessionId: string, fallback: SandboxMode): SandboxMode {
    // 作用：计算该 session 仍活跃授权中最宽的目标模式——保证新授权不会把已放宽的模式降级
    let highest: SandboxMode | undefined;
    for (const grant of this.grants.values()) {
      if (grant.sessionId !== sessionId) continue;
      if (!highest || isModeWiderThan(grant.requestedMode, highest)) highest = grant.requestedMode;
    }
    if (!highest) return fallback;
    return isModeWiderThan(fallback, highest) ? fallback : highest;
  }
  private remainingActiveMode(sessionId: string): SandboxMode | undefined {
    // 作用：回滚时计算「除当前正在释放的授权之外」其余活跃授权要求的最宽模式；无则 undefined（回落 baseline）
    let highest: SandboxMode | undefined;
    for (const grant of this.grants.values()) {
      if (grant.sessionId !== sessionId) continue;
      if (!highest || isModeWiderThan(grant.requestedMode, highest)) highest = grant.requestedMode;
    }
    return highest;
  }
  private isGrantLive(grant: Grant): boolean {
    // 作用：授权是否仍然有效——委托 LeaseManager 判定（单一时钟来源），不在此处做时间比较
    return this.leases.isLive(grant.leaseId);
  }
}
