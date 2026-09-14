import { describe, expect, it } from "vitest";
import { GuardError } from "../capability/errors.js";
import type { HostHandler } from "../legacy/rpc-client.js";
import { extractIsolatedErrorCode, IsolatedRuntimeManager, type PythonRuntimeLike } from "./isolated-runtime.js";
class FakeRuntime implements PythonRuntimeLike {
  // 作用：PythonRuntime 测试替身——记录 host 方法注册/调用参数，可注入 start 失败与下一次 call 结果
  registered = new Map<string, HostHandler>();
  calls: Array<{ method: string; params: unknown; timeoutMs?: number }> = [];
  startedCount = 0;
  disposedCount = 0;
  failStart: Error | undefined;
  nextResult: unknown = { result: null };
  nextError: Error | undefined;
  registerHostMethod(method: string, handler: HostHandler): void {
    this.registered.set(method, handler);
  }
  async start(): Promise<void> {
    this.startedCount += 1;
    if (this.failStart) throw this.failStart;
  }
  async call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    this.calls.push({ method, params, timeoutMs });
    if (this.nextError) throw this.nextError;
    return this.nextResult;
  }
  async dispose(): Promise<void> {
    this.disposedCount += 1;
  }
}
function makeManager(extra: { ctx?: Record<string, unknown>; invokeTimeoutMs?: number } = {}) {
  // 作用：组装被测 IsolatedRuntimeManager（注入 FakeRuntime，不触碰真实 Python/Docker）
  const runtime = new FakeRuntime();
  const manager = new IsolatedRuntimeManager({ runtime, ...extra });
  return { manager, runtime };
}
describe("IsolatedRuntimeManager 生命周期（Phase 5）", () => {
  it("start 注册 legacy 宿主反向方法并完成健康检查", async () => {
    const { manager, runtime } = makeManager();
    await manager.start();
    expect(runtime.startedCount).toBe(1);
    expect(runtime.registered.has("host.approval.request_lease")).toBe(true);
    expect(runtime.registered.has("host.credential.resolve")).toBe(true);
  });
  it("start 失败 Fail Closed：抛 ISOLATED_RUNTIME_FAILED 并回收半死子进程", async () => {
    const { manager, runtime } = makeManager();
    runtime.failStart = new Error("spawn python ENOENT");
    await expect(manager.start()).rejects.toMatchObject({ code: "ISOLATED_RUNTIME_FAILED" });
    expect(runtime.disposedCount).toBe(1);
    await expect(manager.listTools()).rejects.toMatchObject({ code: "ISOLATED_RUNTIME_FAILED" });
  });
  it("重复 start 拒绝", async () => {
    const { manager } = makeManager();
    await manager.start();
    await expect(manager.start()).rejects.toMatchObject({ code: "ISOLATED_RUNTIME_FAILED" });
  });
  it("invokeTimeoutMs 非法在构造时即拒绝（Fail Closed，禁止静默 clamp）", () => {
    expect(() => new IsolatedRuntimeManager({ runtime: new FakeRuntime(), invokeTimeoutMs: 0 })).toThrow(GuardError);
    expect(() => new IsolatedRuntimeManager({ runtime: new FakeRuntime(), invokeTimeoutMs: 500 })).not.toThrow();
  });
  it("dispose 转发且幂等；dispose 后调用一律拒绝", async () => {
    const { manager, runtime } = makeManager();
    await manager.start();
    await manager.dispose();
    expect(runtime.disposedCount).toBe(1);
    await manager.dispose();
    expect(runtime.disposedCount).toBe(1);
    await expect(manager.listTools()).rejects.toMatchObject({ code: "ISOLATED_RUNTIME_FAILED" });
    await expect(manager.invoke("t", {}, "s1")).rejects.toMatchObject({ code: "ISOLATED_RUNTIME_FAILED" });
    await expect(manager.start()).rejects.toMatchObject({ code: "ISOLATED_RUNTIME_FAILED" });
  });
  it("未 start 直接调用拒绝（绝不顺手拉起 Python）", async () => {
    const { manager, runtime } = makeManager();
    await expect(manager.listTools()).rejects.toMatchObject({ code: "ISOLATED_RUNTIME_FAILED" });
    await expect(manager.invoke("t", {}, "s1")).rejects.toMatchObject({ code: "ISOLATED_RUNTIME_FAILED" });
    expect(runtime.startedCount).toBe(0);
  });
});
describe("IsolatedRuntimeManager 工具枚举与调用", () => {
  it("listTools 复用 legacy parseToolSchemas：剥离内部字段、过滤非法条目", async () => {
    const { manager, runtime } = makeManager();
    runtime.nextResult = [{ name: "hello", description: "say hi", parameters: { type: "object" }, capsule_id: "hello" }, { broken: true }];
    await manager.start();
    const tools = await manager.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "hello", description: "say hi" });
    expect(runtime.calls[0]).toMatchObject({ method: "capsule.list_tools" });
  });
  it("invoke 转发 tool/args/sessionId，容器超时按秒下发且 RPC 层留余量", async () => {
    const { manager, runtime } = makeManager();
    runtime.nextResult = { output: "done" };
    await manager.start();
    const out = await manager.invoke("hello", { who: "dsh" }, "s1");
    expect(out).toEqual({ output: "done" });
    expect(runtime.calls[0]).toMatchObject({ method: "capsule.invoke", params: { tool: "hello", args: { who: "dsh" }, sessionId: "s1" } });
    expect(runtime.calls[0].params).toHaveProperty("timeout", 30);
    expect(runtime.calls[0].timeoutMs).toBe(35_000);
  });
  it("invoke args 缺省补空对象；自定义 invokeTimeoutMs 生效", async () => {
    const { manager, runtime } = makeManager({ invokeTimeoutMs: 5000 });
    await manager.start();
    await manager.invoke("hello", undefined, "s1");
    expect(runtime.calls[0].params).toMatchObject({ args: {}, timeout: 5 });
    expect(runtime.calls[0].timeoutMs).toBe(10_000);
  });
  it("invoke 参数非法拒绝：空 tool / 空 sessionId（Lease 绑定 Session，禁止匿名）", async () => {
    const { manager } = makeManager();
    await manager.start();
    await expect(manager.invoke("", {}, "s1")).rejects.toMatchObject({ code: "ISOLATED_RUNTIME_FAILED" });
    await expect(manager.invoke("hello", {}, "")).rejects.toMatchObject({ code: "ISOLATED_RUNTIME_FAILED" });
  });
  it("invoke Python 业务错误：白名单码透传（保持 Python 侧 Fail Closed 语义）", async () => {
    const { manager, runtime } = makeManager();
    await manager.start();
    runtime.nextError = new Error("rpc error -32603: LEASE_REQUIRED: no active lease for repo:foo/bar");
    await expect(manager.invoke("github_read", {}, "s1")).rejects.toMatchObject({ code: "LEASE_REQUIRED" });
    runtime.nextError = new Error("rpc error -32603: CAPSULE_TIMEOUT: invocation timed out");
    await expect(manager.invoke("github_read", {}, "s1")).rejects.toMatchObject({ code: "CAPSULE_TIMEOUT" });
    runtime.nextError = new Error("rpc error -32603: CREDENTIAL_NOT_CONFIGURED: resolve failed for github-token");
    await expect(manager.invoke("github_read", {}, "s1")).rejects.toMatchObject({ code: "CREDENTIAL_NOT_CONFIGURED" });
  });
  it("invoke RPC 基础设施错误（无业务码）统一 ISOLATED_RUNTIME_FAILED", async () => {
    const { manager, runtime } = makeManager();
    await manager.start();
    runtime.nextError = new Error("rpc error -32000: connection closed");
    await expect(manager.invoke("hello", {}, "s1")).rejects.toMatchObject({ code: "ISOLATED_RUNTIME_FAILED" });
  });
});
describe("宿主反向方法（复用 legacy 冻结实现）", () => {
  it("host.approval.request_lease：ctx.approval 不可用即 LEASE_REJECTED（Fail Closed）", async () => {
    const { manager, runtime } = makeManager();
    await manager.start();
    const handler = runtime.registered.get("host.approval.request_lease")!;
    await expect(handler({ capsuleId: "github-reader", provider: "github", resource: "repo:foo/bar", action: "issues.read", ttlSeconds: 60 })).rejects.toThrow(/LEASE_REJECTED/);
  });
  it("host.credential.resolve：ctx.credentials 不可用即 CREDENTIAL_NOT_CONFIGURED（Fail Closed）", async () => {
    const { manager, runtime } = makeManager();
    await manager.start();
    const handler = runtime.registered.get("host.credential.resolve")!;
    await expect(handler({ ref: "github-token" })).rejects.toThrow(/CREDENTIAL_NOT_CONFIGURED/);
  });
  it("host.credential.resolve：真实 resolve 只回传 value 且 ref 注入 DSH credentials", async () => {
    const { manager, runtime } = makeManager({ ctx: { credentials: { resolve: async (ref: string) => (ref === "github-token" ? { value: "secret-value" } : { value: "" }) } } });
    await manager.start();
    const handler = runtime.registered.get("host.credential.resolve")!;
    await expect(handler({ ref: "github-token" })).resolves.toEqual({ value: "secret-value" });
  });
});
describe("extractIsolatedErrorCode", () => {
  it("仅提取白名单内的结构化错误码，未命中返回 undefined", () => {
    expect(extractIsolatedErrorCode("rpc error -32603: LEASE_REQUIRED: no active lease")).toBe("LEASE_REQUIRED");
    expect(extractIsolatedErrorCode("rpc error -32603: FAKE_CODE_SOME_RANDOM: detail")).toBeUndefined();
    expect(extractIsolatedErrorCode("rpc timeout: capsule.invoke")).toBeUndefined();
    expect(extractIsolatedErrorCode("python runtime exited unexpectedly")).toBeUndefined();
  });
});
