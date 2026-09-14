import type { AuditDecision, ToolAuditEvent } from "../audit/types.js";
import type { CapabilityLease, LeaseKind, LeaseStatus, ManagedCapabilitySummary, ScopeKind } from "../capability/types.js";
// 作用：Governance Console 视图模型（重构规格第 24 节 Phase 4）——Plugins / Tools / Activity /
// Capabilities / Audit 五个维度的只读数据形状；所有视图均为白名单投影，类型层即不存在 Secret、
// 原始 Tool Arguments 与 resource 函数（规格第 9/29 节安全边界）。
export type ConsoleCapabilityView = ManagedCapabilitySummary;
export interface ConsoleProviderView {
  /** Provider 唯一标识 */
  id: string;
  /** DSH Credential 引用名（引用本身不是 Secret，是 ctx.credentials.resolve 用的 ref，规格 11.3） */
  credentialRef: string;
  /** 允许执行的 action 白名单 */
  allowedActions: readonly string[];
}
export interface ConsolePluginView {
  id: string;
  kind: "guard" | "provider";
  credentialRef?: string;
  allowedActions?: readonly string[];
}
export interface ConsoleToolStat {
  toolName: string;
  /** 去重调用数（按 callId：一条调用链 ASK→LEASE_ISSUED→TOOL_SUCCESS 产生多条事件只计 1 次） */
  invocations: number;
  ask: number;
  leaseIssued: number;
  leaseReused: number;
  approvalRejected: number;
  passthroughAllow: number;
  passthroughDeny: number;
  toolSuccess: number;
  toolError: number;
  lastActivityAt: number;
}
export interface ConsoleLeaseView {
  id: string;
  kind: LeaseKind;
  sessionId: string;
  toolName: string;
  scopeKind: ScopeKind;
  /** 脱敏后的 Scope 展示串（Lease 从不保存参数原文） */
  scopeDisplay: string;
  issuedAt: number;
  expiresAt: number;
  status: LeaseStatus;
  /** 视图层实时剩余毫秒 max(0, expiresAt - now)；安全校验仍以 LeaseManager.validate 为准 */
  remainingMs: number;
  revokedAt?: number;
  revokeReason?: string;
}
export interface GovernanceSummary {
  leasesTotal: number;
  leasesActive: number;
  leasesRevoked: number;
  leasesExpired: number;
  managedCapabilities: number;
  providers: number;
  auditedEvents: number;
}
export interface GovernanceSnapshot {
  generatedAt: number;
  guardName: string;
  summary: GovernanceSummary;
  plugins: ConsolePluginView[];
  tools: ConsoleToolStat[];
  /** 最近活动（最新在前，条数受 activityLimit 约束） */
  activity: ToolAuditEvent[];
  capabilities: ConsoleCapabilityView[];
  leases: ConsoleLeaseView[];
}
export interface ConsoleAuditQuery {
  sessionId?: string;
  toolName?: string;
  decision?: AuditDecision;
  limit?: number;
}
// 作用：Console 依赖的最小数据源接口（结构化抽象）——组装期注入 AuditService / LeaseManager /
// CapabilityService / ProviderRegistry 实例；Console 不反向依赖具体实现，便于独立单测。
export interface ConsoleAuditSource {
  list(limit?: number): ToolAuditEvent[];
}
export interface ConsoleLeaseSource {
  list(): Promise<readonly CapabilityLease[]>;
}
export interface ConsoleCapabilitySource {
  listCapabilities(): readonly ConsoleCapabilityView[];
}
export interface ConsoleProviderSource {
  list(): readonly ConsoleProviderView[];
}
export interface GovernanceConsoleDeps {
  audit: ConsoleAuditSource;
  leases: ConsoleLeaseSource;
  capabilities: ConsoleCapabilitySource;
  providers: ConsoleProviderSource;
  guardName?: string;
  /** 快照 Activity 区块保留的最近事件条数（默认 50，必须为正整数） */
  activityLimit?: number;
  /** 可注入时钟（默认 Date.now），供测试模拟时间推进 */
  now?: () => number;
}
export interface ConsoleHttpConfig {
  /** 是否启动本地只读 Console HTTP 查看器（默认 false：仅提供编程 API，不监听任何端口） */
  enabled?: boolean;
  /** 监听地址，默认 127.0.0.1（仅 loopback；如需远程查看请自行评估暴露面） */
  host?: string;
  /** 监听端口，默认 8787（传 0 时由操作系统分配随机可用端口） */
  port?: number;
}
