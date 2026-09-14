import { randomUUID } from "node:crypto";
import { GuardError } from "./errors.js";
import type { LeaseStore } from "./lease-store.js";
import type { CapabilityLease, CapabilityScope, LeaseKind } from "./types.js";
// 作用：LeaseManager（重构规格第 5.7 节）——只负责 issue / validate / findMatching / revoke /
// revokeSession / list；禁止混入 Approval UI、Tool Hook、Credential、Provider 逻辑。
export interface IssueLeaseInput {
  sessionId: string;
  toolName: string;
  scope: CapabilityScope;
  ttlSeconds: number;
  kind?: LeaseKind;
  sourceCallId?: string;
}
export class LeaseManager {
  constructor(private readonly store: LeaseStore, private readonly now: () => number = Date.now) {}
  async issue(input: IssueLeaseInput): Promise<CapabilityLease> {
    // 作用：签发 Lease——参数防御校验（Fail Closed）：sessionId/toolName/scope.key 必须非空字符串，
    // TTL 必须正整数；签发结果立即写入 store，expiresAt = now + ttlSeconds * 1000
    if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
      throw new GuardError("LEASE_INVALID_INPUT", "sessionId must be a non-empty string");
    }
    if (typeof input.toolName !== "string" || input.toolName.length === 0) {
      throw new GuardError("LEASE_INVALID_INPUT", "toolName must be a non-empty string");
    }
    if (typeof input.scope?.key !== "string" || input.scope.key.length === 0) {
      throw new GuardError("LEASE_INVALID_INPUT", "scope.key must be a non-empty string");
    }
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
      throw new GuardError("LEASE_TTL_INVALID", "ttlSeconds must be a positive integer");
    }
    const issuedAt = this.now();
    const lease: CapabilityLease = {
      id: randomUUID(),
      kind: input.kind ?? "universal",
      sessionId: input.sessionId,
      toolName: input.toolName,
      scope: input.scope,
      issuedAt,
      expiresAt: issuedAt + input.ttlSeconds * 1000,
      status: "ACTIVE",
      sourceCallId: input.sourceCallId,
    };
    await Promise.resolve(this.store.insert(lease));
    return lease;
  }
  async findMatching(sessionId: string, toolName: string, scopeKey: string): Promise<CapabilityLease | undefined> {
    // 作用：查找并校验可复用 Lease——store 命中后 validate（实时 TTL 比较 + 惰性标记 EXPIRED）；
    // 任何无效（撤销/过期/不存在）统一返回 undefined，由上层保持 ask 重新走授权
    const lease = await Promise.resolve(this.store.findMatching({ sessionId, toolName, scopeKey }));
    if (!lease) return undefined;
    try {
      return this.validate(lease);
    } catch {
      return undefined;
    }
  }
  validate(lease: CapabilityLease): CapabilityLease {
    // 作用：校验 Lease 有效性（Fail Closed）——REVOKED 抛 LEASE_REVOKED；now >= expiresAt 惰性标记
    // EXPIRED 并抛 LEASE_EXPIRED；状态异常一律拒绝。安全正确性完全依赖本方法的实时时间比较，
    // 不依赖任何后台定时器（规格第 5.8 节）
    if (lease.status === "REVOKED") {
      throw new GuardError("LEASE_REVOKED");
    }
    if (lease.status === "EXPIRED" || this.now() >= lease.expiresAt) {
      lease.status = "EXPIRED";
      throw new GuardError("LEASE_EXPIRED");
    }
    if (lease.status !== "ACTIVE") {
      throw new GuardError("LEASE_REVOKED", `unexpected status ${lease.status}`);
    }
    return lease;
  }
  async revoke(leaseId: string, reason?: string): Promise<boolean> {
    // 作用：撤销单个 Lease——下一次同 Scope 调用重新 Ask（规格 22.11）
    return await Promise.resolve(this.store.revoke(leaseId, reason));
  }
  async revokeSession(sessionId: string, reason?: string): Promise<number> {
    // 作用：撤销某 Session 全部 Lease（Session disposed / 用户主动收回时调用）
    return await Promise.resolve(this.store.revokeSession(sessionId, reason));
  }
  async list(): Promise<CapabilityLease[]> {
    return await Promise.resolve(this.store.list());
  }
}
