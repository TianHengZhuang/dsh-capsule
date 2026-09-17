import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { AuditService } from "../audit/audit-service.js";
import type { AuditDecision, ToolAuditEvent } from "../audit/types.js";
import { LeaseManager } from "../capability/lease-manager.js";
import { MemoryLeaseStore } from "../capability/lease-store.js";
import { apply, type CapsuleHostContext, type DisposeHook } from "../index.js";
import { CapabilityService } from "../service/capability-service.js";
import { GovernanceConsole } from "./console-service.js";
import { startConsoleServer } from "./http-server.js";
import type { ConsoleProviderSource } from "./types.js";
// 作用：测试用 Provider 白名单投影源——与真实 ProviderRegistry.list() 的投影形状一致，
// credentialRef 是 resolve 引用名而非 Secret（规格 11.3）
const fakeProviders: ConsoleProviderSource = {
  list: () => [{ id: "github", credentialRef: "github-token", allowedActions: ["issues.read", "issues.create"] }],
};
function makeCapabilities(leases: LeaseManager): CapabilityService {
  // 作用：构造注册了一条 managed 定义的 CapabilityService——resource 函数确定性返回，供投影断言
  const service = new CapabilityService(new Context(), { leases, defaultTtlSeconds: 60, maxTtlSeconds: 1800 });
  service.register({ toolName: "github.create_issue", provider: "github", action: "issues.create", resource: () => "repo:o/r", ttlSeconds: 300 });
  return service;
}
function recordEvent(audit: AuditService, event: { callId: string; toolName: string; decision: AuditDecision; sessionId?: string; leaseId?: string }): ToolAuditEvent {
  // 作用：写入一条最简形状的审计事件（rootCallId 缺省与 callId 相同）
  return audit.record({ rootCallId: event.callId, ...event });
}
interface ConsoleFixture {
  gov: GovernanceConsole;
  audit: AuditService;
  leases: LeaseManager;
  capabilities: CapabilityService;
  advance: (ms: number) => void;
}
async function makeConsole(): Promise<ConsoleFixture> {
  // 作用：构造可注入假时钟的完整 Console 依赖——audit 填一条调用链（ASK→LEASE_ISSUED→TOOL_SUCCESS）
  // + 一次复用 + 一次透传 deny；leases 签发一条 60s 的 ACTIVE Lease
  let now = 10_000;
  const audit = new AuditService();
  const leases = new LeaseManager(new MemoryLeaseStore(), () => now);
  const capabilities = makeCapabilities(leases);
  recordEvent(audit, { callId: "call-1", toolName: "github.create_issue", decision: "ASK", sessionId: "sess-1" });
  recordEvent(audit, { callId: "call-1", toolName: "github.create_issue", decision: "LEASE_ISSUED", sessionId: "sess-1", leaseId: "lease-1" });
  recordEvent(audit, { callId: "call-1", toolName: "github.create_issue", decision: "TOOL_SUCCESS", sessionId: "sess-1" });
  recordEvent(audit, { callId: "call-2", toolName: "github.create_issue", decision: "LEASE_REUSED", sessionId: "sess-1", leaseId: "lease-1" });
  recordEvent(audit, { callId: "call-3", toolName: "fs.write", decision: "PASSTHROUGH_DENY" });
  await leases.issue({ sessionId: "sess-1", toolName: "github.create_issue", scope: { kind: "exact-arguments", key: "hash-1", display: "tool=github.create_issue args=<sha256>" }, ttlSeconds: 60 });
  return { gov: new GovernanceConsole({ audit, leases, capabilities, providers: fakeProviders, now: () => now }), audit, leases, capabilities, advance: (ms) => { now += ms; } };
}
async function makeGov(): Promise<GovernanceConsole> {
  // 作用：仅取聚合实例（HTTP 只读查询用）
  return (await makeConsole()).gov;
}
describe("GovernanceConsole 聚合（规格第 24 节 Phase 4）", () => {
  it("snapshot 聚合五维视图：summary 计数、plugins 白名单投影、capabilities 投影、activity 最新在前", async () => {
    const { gov } = await makeConsole();
    const snap = await gov.snapshot();
    expect(snap.guardName).toBe("dsh-capability-guard");
    expect(snap.summary).toMatchObject({ leasesTotal: 1, leasesActive: 1, leasesRevoked: 0, leasesExpired: 0, managedCapabilities: 1, providers: 1, auditedEvents: 5 });
    expect(snap.plugins).toEqual([
      { id: "dsh-capability-guard", kind: "guard" },
      { id: "github", kind: "provider", credentialRef: "github-token", allowedActions: ["issues.read", "issues.create"] },
    ]);
    expect(snap.capabilities).toEqual([{ toolName: "github.create_issue", provider: "github", action: "issues.create", ttlSeconds: 300 }]);
    expect(snap.activity.map((event) => event.decision)).toEqual(["PASSTHROUGH_DENY", "LEASE_REUSED", "TOOL_SUCCESS", "LEASE_ISSUED", "ASK"]);
  });
  it("activityLimit 截断最近活动，非法值构造 Fail Closed 抛错", async () => {
    let now = 10_000;
    const audit = new AuditService();
    const leases = new LeaseManager(new MemoryLeaseStore(), () => now);
    for (let i = 0; i < 8; i += 1) {
      recordEvent(audit, { callId: `call-${i}`, toolName: "t", decision: "ASK" });
    }
    const gov = new GovernanceConsole({ audit, leases, capabilities: { listCapabilities: () => [] }, providers: { list: () => [] }, activityLimit: 3, now: () => now });
    const snap = await gov.snapshot();
    expect(snap.activity).toHaveLength(3);
    expect(snap.activity[0].callId).toBe("call-7");
    expect(() => new GovernanceConsole({ audit, leases, capabilities: { listCapabilities: () => [] }, providers: { list: () => [] }, activityLimit: 0 })).toThrow(/GUARD_CONSOLE_INVALID/);
  });
  it("Tool 统计按 callId 去重：调用链多事件只计 1 次 invocations，各决策计数正确", async () => {
    const { gov } = await makeConsole();
    const snap = await gov.snapshot();
    const tool = snap.tools.find((stat) => stat.toolName === "github.create_issue");
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({ invocations: 2, ask: 1, leaseIssued: 1, leaseReused: 1, approvalRejected: 0, passthroughAllow: 0, passthroughDeny: 0, toolSuccess: 1, toolError: 0 });
    const fs = snap.tools.find((stat) => stat.toolName === "fs.write");
    expect(fs).toMatchObject({ invocations: 1, passthroughDeny: 1 });
    expect(tool?.lastActivityAt).toBeGreaterThan(0);
  });
  it("Lease 视图实时投影：剩余毫秒正确，已过期未标记的 ACTIVE 在视图层修正为 EXPIRED", async () => {
    const { gov, leases, advance } = await makeConsole();
    const scope = { kind: "exact-arguments" as const, key: "hash-2", display: "d2" };
    const revocable = await leases.issue({ sessionId: "sess-2", toolName: "t2", scope, ttlSeconds: 60 });
    await leases.revoke(revocable.id, "manual");
    await leases.issue({ sessionId: "sess-3", toolName: "t3", scope, ttlSeconds: 10 });
    advance(20_000);
    const snap = await gov.snapshot();
    const views = new Map(snap.leases.map((lease) => [lease.id, lease]));
    expect(views.get(revocable.id)).toMatchObject({ status: "REVOKED", revokeReason: "manual" });
    const active = snap.leases.find((lease) => lease.status === "ACTIVE");
    expect(active?.remainingMs).toBe(40_000);
    const expired = snap.leases.find((lease) => lease.sessionId === "sess-3");
    expect(expired).toMatchObject({ status: "EXPIRED", remainingMs: 0 });
    expect(snap.summary.leasesTotal).toBe(3);
  });
  it("queryAudit 按 sessionId/toolName/decision 过滤（最新在前）并支持 limit；非法 limit Fail Closed", async () => {
    const { gov } = await makeConsole();
    expect(gov.queryAudit({ toolName: "github.create_issue" })).toHaveLength(4);
    expect(gov.queryAudit({ sessionId: "sess-1", decision: "TOOL_SUCCESS" }).map((event) => event.callId)).toEqual(["call-1"]);
    expect(gov.queryAudit({ limit: 2 }).map((event) => event.decision)).toEqual(["PASSTHROUGH_DENY", "LEASE_REUSED"]);
    expect(() => gov.queryAudit({ limit: 0 })).toThrow(/GUARD_CONSOLE_INVALID/);
    expect(gov.queryAudit({})).toHaveLength(5);
  });
  it("CapabilityService.listCapabilities 返回安全投影：不含 resource 函数字段", () => {
    const leases = new LeaseManager(new MemoryLeaseStore());
    const capabilities = makeCapabilities(leases);
    const list = capabilities.listCapabilities();
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(["action", "provider", "toolName", "ttlSeconds"]);
  });
});
describe("HTTP 只读查看器（规格 Phase 4）", () => {
  it("GET /api/snapshot 返回快照 JSON 与安全响应头", async () => {
    const handle = await startConsoleServer({ console: await makeGov(), port: 0 });
    try {
      const res = await fetch(`${handle.url}api/snapshot`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const body = (await res.json()) as { summary: Record<string, number> };
      expect(body.summary.auditedEvents).toBe(5);
    } finally {
      await handle.close();
    }
  });
  it("GET /api/audit 支持 toolName/decision/limit 过滤，非法 decision/limit 返回 400", async () => {
    const handle = await startConsoleServer({ console: await makeGov(), port: 0 });
    try {
      const filtered = await (await fetch(`${handle.url}api/audit?toolName=github.create_issue&decision=TOOL_SUCCESS&limit=5`)).json();
      expect(filtered).toHaveLength(1);
      const invalidDecision = await fetch(`${handle.url}api/audit?decision=NOT_A_DECISION`);
      expect(invalidDecision.status).toBe(400);
      const invalidLimit = await fetch(`${handle.url}api/audit?limit=abc`);
      expect(invalidLimit.status).toBe(400);
    } finally {
      await handle.close();
    }
  });
  it("非 GET 一律 405，未知路径 404（只读 Fail Closed）", async () => {
    const handle = await startConsoleServer({ console: await makeGov(), port: 0 });
    try {
      const post = await fetch(`${handle.url}api/snapshot`, { method: "POST" });
      expect(post.status).toBe(405);
      const unknown = await fetch(`${handle.url}api/revoke`);
      expect(unknown.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
  it("GET / 返回内嵌 HTML 页面（含标题与 CSP）", async () => {
    const handle = await startConsoleServer({ console: await makeGov(), port: 0 });
    try {
      const res = await fetch(handle.url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-security-policy")).toContain("connect-src 'self'");
      const html = await res.text();
      expect(html).toContain("DSH Capability Guard Console");
    } finally {
      await handle.close();
    }
  });
  it("close() 后端口释放，连接被拒绝；非法 host/port Fail Closed 抛错", async () => {
    const handle = await startConsoleServer({ console: await makeGov(), port: 0 });
    await handle.close();
    await expect(fetch(handle.url)).rejects.toThrow();
    await expect(startConsoleServer({ console: await makeGov(), port: 99999 })).rejects.toThrow(/GUARD_CONSOLE_INVALID/);
    await expect(startConsoleServer({ console: await makeGov(), host: "" })).rejects.toThrow(/GUARD_CONSOLE_INVALID/);
  });
});
describe("插件装配（index.ts apply + console 配置）", () => {
  it("console.enabled 启动只读查看器，dispose 后端口释放且 capabilities 服务仍可解析", async () => {
    const ctx = new Context() as unknown as CapsuleHostContext & { get(name: string): unknown };
    (ctx as { on?: unknown }).on = () => () => undefined;
    const dispose: DisposeHook = await apply(ctx, { console: { enabled: true, port: 0 } });
    expect(typeof ctx.get("capabilities")).toBe("object");
    await dispose();
  });
  it("默认不启用 console：不监听任何端口，apply 仍完成装配并注册 capabilities 服务", async () => {
    const ctx = new Context() as unknown as CapsuleHostContext & { get(name: string): unknown };
    (ctx as { on?: unknown }).on = () => () => undefined;
    const dispose = await apply(ctx, {});
    expect(typeof ctx.get("capabilities")).toBe("object");
    await dispose();
  });
});
