import { beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit-service.js";
import { GuardError } from "../capability/errors.js";
import { LeaseManager } from "../capability/lease-manager.js";
import { MemoryLeaseStore } from "../capability/lease-store.js";
import { PendingRegistry } from "../capability/pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver } from "../capability/policy.js";
import { ScopeResolver } from "../capability/scope-resolver.js";
import type { BrokerOperation, ManagedCapabilityDefinition, ToolRunContext } from "../capability/types.js";
import { UniversalGate } from "../capability/universal-gate.js";
import { CapabilityService, type BrokerOperationExecutor } from "./capability-service.js";
let now = 1_000_000;
const clock = () => now;
beforeEach(() => {
  now = 1_000_000;
});
function makeService(executor?: BrokerOperationExecutor) {
  // 作用：组装被测 CapabilityService（注入可控时钟与可选 executor，规格 22.10/10.5 模拟时间用）
  const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
  const service = new CapabilityService({
    leases,
    defaultTtlSeconds: 60,
    maxTtlSeconds: 1800,
    executor,
  });
  return { service, leases };
}
function makeStack(definition?: ManagedCapabilityDefinition) {
  // 作用：组装 Gate + CapabilityService 全链路（managed 源互连，验证语义 Scope 端到端）
  const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
  const service = new CapabilityService({ leases, defaultTtlSeconds: 60, maxTtlSeconds: 1800 });
  if (definition) service.register(definition);
  const gate = new UniversalGate({
    policy: new PolicyResolver(DEFAULT_UNIVERSAL_POLICY),
    scopes: new ScopeResolver(),
    leases,
    pending: new PendingRegistry(),
    audit: new AuditService(),
    managed: service,
    now: clock,
  });
  return { gate, service, leases };
}
const githubDefinition: ManagedCapabilityDefinition = {
  toolName: "guard_github_create_issue",
  provider: "github",
  action: "issues.create",
  resource: (args: unknown) => `repo:${(args as { repo: string }).repo}`,
  ttlSeconds: 120,
};
function runOf(callId: string, args: unknown, sessionId = "s1", name = "guard_github_create_issue"): ToolRunContext {
  // 作用：构造可信 Tool Runtime 的最小 run 上下文
  return { callId, rootCallId: callId, name, arguments: args, agent: { id: sessionId } };
}
function operationOf(args: { provider?: string; resource?: string; action?: string; input?: unknown } = {}): BrokerOperation {
  // 作用：构造 Extension 自报的 Broker Operation（缺省与 githubDefinition 一致）
  return {
    provider: args.provider ?? "github",
    resource: args.resource ?? "repo:a/b",
    action: args.action ?? "issues.create",
    input: (args.input ?? { title: "t" }) as BrokerOperation["input"],
  };
}
const ask = () => Promise.resolve({ kind: "ask" as const, reason: "need confirm" });
async function expectGuardError(promise: Promise<unknown>, code: string) {
  // 作用：断言 promise 以指定错误码的 GuardError 拒绝（Fail Closed 验证）
  await expect(promise).rejects.toMatchObject({ name: "GuardError", code });
}
describe("CapabilityService register（规格 10.4）", () => {
  it("正常注册并可通过 disposer 注销", () => {
    const { service } = makeService();
    const dispose = service.register(githubDefinition);
    expect(service.resolve(githubDefinition.toolName, { repo: "a/b" })).toBeDefined();
    dispose();
    expect(service.resolve(githubDefinition.toolName, { repo: "a/b" })).toBeUndefined();
  });
  it("重复注册同 toolName 覆盖旧定义，旧 disposer 不误删新定义", () => {
    const { service } = makeService();
    const disposeOld = service.register(githubDefinition);
    service.register({ ...githubDefinition, action: "issues.update" });
    const resolved = service.resolve(githubDefinition.toolName, { repo: "a/b" });
    expect(resolved?.scope.actions).toEqual(["issues.update"]);
    disposeOld();
    expect(service.resolve(githubDefinition.toolName, { repo: "a/b" })).toBeDefined();
  });
  it("非法定义一律拒绝注册（Fail Closed）", () => {
    const { service } = makeService();
    expect(() => service.register({ ...githubDefinition, toolName: "" })).toThrow(GuardError);
    expect(() => service.register({ ...githubDefinition, provider: "" })).toThrow(GuardError);
    expect(() => service.register({ ...githubDefinition, action: "" })).toThrow(GuardError);
    expect(() => service.register({ ...githubDefinition, resource: undefined as unknown as ManagedCapabilityDefinition["resource"] })).toThrow(GuardError);
    expect(() => service.register({ ...githubDefinition, ttlSeconds: 0 })).toThrow(GuardError);
    expect(() => service.register({ ...githubDefinition, ttlSeconds: 1801 })).toThrow(GuardError);
  });
  it("definition 未指定 ttlSeconds 时回落 defaultTtlSeconds", () => {
    const { service } = makeService();
    service.register({ ...githubDefinition, ttlSeconds: undefined });
    const resolved = service.resolve(githubDefinition.toolName, { repo: "a/b" });
    expect(resolved?.ttlSeconds).toBe(60);
  });
  it("语义 Scope：key 为 provider/resource/action 哈希，display 含语义三元组", () => {
    const { service } = makeService();
    service.register(githubDefinition);
    const a = service.resolve(githubDefinition.toolName, { repo: "a/b" });
    const b = service.resolve(githubDefinition.toolName, { repo: "other/r" });
    expect(a?.scope.kind).toBe("managed");
    expect(a?.scope.key).not.toBe(b?.scope.key);
    expect(a?.scope.display).toContain("provider=github");
    expect(a?.scope.display).toContain("resource=repo:a/b");
    expect(a?.scope.display).toContain("action=issues.create");
  });
  it("resource 函数抛错/返回非字符串：resolve 向上传播错误（Gate 将 Fail Closed）", () => {
    const { service } = makeService();
    service.register({ ...githubDefinition, resource: () => { throw new Error("boom"); } });
    expect(() => service.resolve(githubDefinition.toolName, {})).toThrow(GuardError);
    service.register({ ...githubDefinition, resource: (() => 42) as unknown as ManagedCapabilityDefinition["resource"] });
    expect(() => service.resolve(githubDefinition.toolName, {})).toThrow(GuardError);
  });
});
describe("CapabilityService execute 双重校验（规格 10.5 / 23.1-23.8）", () => {
  it("run 上下文缺 callId/name/agent.id：CAPABILITY_DENIED（身份必须来自可信 Runtime）", async () => {
    const { service } = makeService();
    service.register(githubDefinition);
    await expectGuardError(service.execute({} as ToolRunContext, operationOf()), "CAPABILITY_DENIED");
    await expectGuardError(service.execute(runOf("", {}), operationOf()), "CAPABILITY_DENIED");
    const noAgent = { callId: "c1", rootCallId: "c1", name: "t", arguments: {} } as ToolRunContext;
    await expectGuardError(service.execute(noAgent, operationOf()), "CAPABILITY_DENIED");
  });
  it("未注册 Tool 调 execute：CAPABILITY_NOT_REGISTERED（规格 23.2）", async () => {
    const { service } = makeService();
    await expectGuardError(service.execute(runOf("c1", { repo: "a/b" }, "s1", "unknown_tool"), operationOf()), "CAPABILITY_NOT_REGISTERED");
  });
  it("provider/action/resource 任一 mismatch：CAPABILITY_MISMATCH（规格 23.3-23.5）", async () => {
    const { service, leases } = makeService();
    service.register(githubDefinition);
    const scope = service.resolve(githubDefinition.toolName, { repo: "a/b" })!.scope;
    await leases.issue({ sessionId: "s1", toolName: githubDefinition.toolName, scope, ttlSeconds: 120, kind: "managed" });
    await expectGuardError(service.execute(runOf("c1", { repo: "a/b" }), operationOf({ provider: "gitlab" })), "CAPABILITY_MISMATCH");
    await expectGuardError(service.execute(runOf("c1", { repo: "a/b" }), operationOf({ action: "issues.update" })), "CAPABILITY_MISMATCH");
    await expectGuardError(service.execute(runOf("c1", { repo: "a/b" }), operationOf({ resource: "repo:other/r" })), "CAPABILITY_MISMATCH");
  });
  it("resource 重算与自报一致才放行：run.arguments 变化即 mismatch（规格 10.5 第 4 步）", async () => {
    const { service, leases } = makeService();
    service.register(githubDefinition);
    const scope = service.resolve(githubDefinition.toolName, { repo: "a/b" })!.scope;
    await leases.issue({ sessionId: "s1", toolName: githubDefinition.toolName, scope, ttlSeconds: 120, kind: "managed" });
    await expectGuardError(service.execute(runOf("c1", { repo: "x/y" }), operationOf({ resource: "repo:x/y" })), "LEASE_REQUIRED");
  });
  it("Lease missing：LEASE_REQUIRED（规格 23.6）", async () => {
    const { service } = makeService();
    service.register(githubDefinition);
    await expectGuardError(service.execute(runOf("c1", { repo: "a/b" }), operationOf()), "LEASE_REQUIRED");
  });
  it("Lease expired：LEASE_EXPIRED（规格 23.7）", async () => {
    const { service, leases } = makeService();
    service.register(githubDefinition);
    const scope = service.resolve(githubDefinition.toolName, { repo: "a/b" })!.scope;
    await leases.issue({ sessionId: "s1", toolName: githubDefinition.toolName, scope, ttlSeconds: 120, kind: "managed" });
    now += 120_001;
    await expectGuardError(service.execute(runOf("c1", { repo: "a/b" }), operationOf()), "LEASE_EXPIRED");
  });
  it("Lease revoked：LEASE_REVOKED（规格 23.8）", async () => {
    const { service, leases } = makeService();
    service.register(githubDefinition);
    const scope = service.resolve(githubDefinition.toolName, { repo: "a/b" })!.scope;
    const lease = await leases.issue({ sessionId: "s1", toolName: githubDefinition.toolName, scope, ttlSeconds: 120, kind: "managed" });
    await service.revoke(lease.id, "manual");
    await expectGuardError(service.execute(runOf("c1", { repo: "a/b" }), operationOf()), "LEASE_REVOKED");
  });
  it("Session 隔离：Session A 的 Lease 不能被 Session B execute（规格 23.15 变体）", async () => {
    const { service, leases } = makeService();
    service.register(githubDefinition);
    const scope = service.resolve(githubDefinition.toolName, { repo: "a/b" })!.scope;
    await leases.issue({ sessionId: "s1", toolName: githubDefinition.toolName, scope, ttlSeconds: 120, kind: "managed" });
    await expectGuardError(service.execute(runOf("c1", { repo: "a/b" }, "s2"), operationOf()), "LEASE_REQUIRED");
  });
  it("校验通过且有 executor：返回 executor 结果并透传 operation/signal（规格 23.9）", async () => {
    const calls: { operation: BrokerOperation; signal?: AbortSignal }[] = [];
    const executor: BrokerOperationExecutor = {
      execute: async (operation, signal) => {
        calls.push({ operation, signal });
        return { ok: true, number: 42 };
      },
    };
    const { service, leases } = makeService(executor);
    service.register(githubDefinition);
    const scope = service.resolve(githubDefinition.toolName, { repo: "a/b" })!.scope;
    await leases.issue({ sessionId: "s1", toolName: githubDefinition.toolName, scope, ttlSeconds: 120, kind: "managed" });
    const controller = new AbortController();
    const out = await service.execute({ ...runOf("c1", { repo: "a/b" }, "s1"), signal: controller.signal }, { ...operationOf(), input: { title: "T" } });
    expect(out).toEqual({ ok: true, number: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toEqual({ provider: "github", resource: "repo:a/b", action: "issues.create", input: { title: "T" } });
    expect(calls[0].signal).toBe(controller.signal);
  });
  it("校验通过但未注入 executor（Phase 2 无 Broker）：PROVIDER_NOT_FOUND（Fail Closed）", async () => {
    const { service, leases } = makeService();
    service.register(githubDefinition);
    const scope = service.resolve(githubDefinition.toolName, { repo: "a/b" })!.scope;
    await leases.issue({ sessionId: "s1", toolName: githubDefinition.toolName, scope, ttlSeconds: 120, kind: "managed" });
    await expectGuardError(service.execute(runOf("c1", { repo: "a/b" }), operationOf()), "PROVIDER_NOT_FOUND");
  });
  it("revokeSession 撤销后 execute 重新 LEASE_REQUIRED，listLeases 代理 LeaseManager", async () => {
    const { service, leases } = makeService();
    service.register(githubDefinition);
    const scope = service.resolve(githubDefinition.toolName, { repo: "a/b" })!.scope;
    await leases.issue({ sessionId: "s1", toolName: githubDefinition.toolName, scope, ttlSeconds: 120, kind: "managed" });
    expect(await service.listLeases()).toHaveLength(1);
    expect(await service.revokeSession("s1", "session disposed")).toBe(1);
    await expectGuardError(service.execute(runOf("c1", { repo: "a/b" }), operationOf()), "LEASE_REVOKED");
  });
});
describe("Gate + CapabilityService 语义 Scope 端到端（规格 10.4）", () => {
  it("managed Tool：ask → allowed-once 签发 managed Lease，reason 含 provider/resource/action", async () => {
    const { gate, leases } = makeStack(githubDefinition);
    const askOut = await gate.handlePreExecute(runOf("c1", { repo: "a/b", title: "A" }), ask);
    expect(askOut.kind).toBe("ask");
    expect(askOut.reason).toContain("provider=github");
    expect(askOut.reason).toContain("resource=repo:a/b");
    expect(askOut.reason).toContain("action=issues.create");
    expect(askOut.reason).toContain("TTL=120s");
    await gate.handleApprovalRequest({ callId: "c1" }, async () => "allowed-once");
    const all = await leases.list();
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe("managed");
    expect(all[0].scope.kind).toBe("managed");
  });
  it("语义 Scope 复用：同 repo 不同 title 在 TTL 内直接 allow（参数细节不参与 managed Scope）", async () => {
    const { gate } = makeStack(githubDefinition);
    await gate.handlePreExecute(runOf("c1", { repo: "a/b", title: "A" }), ask);
    await gate.handleApprovalRequest({ callId: "c1" }, async () => "allowed-once");
    const again = await gate.handlePreExecute(runOf("c2", { repo: "a/b", title: "B" }), ask);
    expect(again.kind).toBe("allow");
  });
  it("resource 变化（不同 repo）：重新 ask 不复用", async () => {
    const { gate } = makeStack(githubDefinition);
    await gate.handlePreExecute(runOf("c1", { repo: "a/b" }), ask);
    await gate.handleApprovalRequest({ callId: "c1" }, async () => "allowed-once");
    const out = await gate.handlePreExecute(runOf("c2", { repo: "other/r" }), ask);
    expect(out.kind).toBe("ask");
  });
  it("resource 函数抛错：Gate Fail Closed 保持原 ask 不签发", async () => {
    const { gate, leases } = makeStack({ ...githubDefinition, resource: () => { throw new Error("boom"); } });
    const out = await gate.handlePreExecute(runOf("c1", { repo: "a/b" }), ask);
    expect(out.kind).toBe("ask");
    expect(out.reason).toBe("need confirm");
    expect(await leases.list()).toHaveLength(0);
  });
  it("未注册 Tool：回落 exact-arguments 默认策略（kind=universal）", async () => {
    const { gate, leases } = makeStack(githubDefinition);
    await gate.handlePreExecute(runOf("c1", { repo: "a/b" }, "s1", "plain_tool"), ask);
    await gate.handleApprovalRequest({ callId: "c1" }, async () => "allowed-once");
    const all = await leases.list();
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe("universal");
    expect(all[0].scope.kind).toBe("exact-arguments");
  });
  it("端到端：Gate 签发 managed Lease 后 execute 双重校验通过并返回结果", async () => {
    const calls: BrokerOperation[] = [];
    const leases = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const service = new CapabilityService({ leases, defaultTtlSeconds: 60, maxTtlSeconds: 1800, executor: { execute: async (op) => { calls.push(op); return { number: 7 }; } } });
    service.register(githubDefinition);
    const gate = new UniversalGate({ policy: new PolicyResolver(DEFAULT_UNIVERSAL_POLICY), scopes: new ScopeResolver(), leases, pending: new PendingRegistry(), audit: new AuditService(), managed: service, now: clock });
    await gate.handlePreExecute(runOf("c1", { repo: "a/b", title: "A" }), ask);
    await gate.handleApprovalRequest({ callId: "c1" }, async () => "allowed-once");
    const result = await service.execute(runOf("c2", { repo: "a/b", title: "A" }), operationOf());
    expect(result).toEqual({ number: 7 });
    expect(calls[0].resource).toBe("repo:a/b");
  });
});
