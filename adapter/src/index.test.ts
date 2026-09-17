import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { apply, buildSandboxContext, type CapsuleHostContext } from "./index.js";
function makeBus(host: CapsuleHostContext) {
  // 作用：为任意宿主 ctx 挂上事件总线（Guard 的 install 需要 on）；宿主本身可以是真实 cordis Context
  (host as { on?: unknown }).on = () => () => {};
  return host;
}
function makeCtx(): CapsuleHostContext {
  return makeBus({});
}
describe("Guard 插件入口（基线修正后：服务化注册）", () => {
  it("真实 cordis 宿主：CapabilityService 以 ctx.capabilities 注册为服务（不再是硬挂属性）", async () => {
    const ctx = makeBus(new Context());
    const dispose = await apply(ctx);
    const capabilities = (ctx as unknown as { get(name: string): unknown }).get("capabilities") as { register?: unknown; execute?: unknown; listCapabilities?: unknown };
    expect(typeof capabilities?.register).toBe("function");
    expect(typeof capabilities?.execute).toBe("function");
    expect(typeof capabilities?.listCapabilities).toBe("function");
    await dispose();
  });
  it("带策略配置：默认路径正常组装，dispose 不抛错", async () => {
    const ctx = makeBus(new Context());
    const dispose = await apply(ctx, { defaultTtlSeconds: 120 });
    expect((ctx as unknown as { get(name: string): unknown }).get("capabilities")).toBeDefined();
    await dispose();
  });
  it("非 cordis 宿主：退化为游离 Context 承载服务，不抛错（仅注入可见性受影响）", async () => {
    const ctx = makeCtx();
    const dispose = await apply(ctx);
    await dispose();
    expect((ctx as { capabilities?: unknown }).capabilities).toBeUndefined();
  });
});
describe("buildSandboxContext（P0-2 宿主适配器）", () => {
  const sessionWith = (id: string, sink: { type: string; data: unknown }[]) => ({ id, append: (type: string, data: unknown) => sink.push({ type, data }) });
  it("读取 DSH 会话投影中的 sandboxMode，写入走 session.append('sandbox/mode')", () => {
    const sink: { type: string; data: unknown }[] = [];
    const ctx = { sessionProjections: { stateOf: () => "workspace-write" } };
    const sandbox = buildSandboxContext(ctx);
    const session = sessionWith("s1", sink);
    expect(sandbox.sessionSandboxMode(session)).toBe("workspace-write");
    sandbox.setSessionSandboxMode(session, "danger-full-access");
    expect(sink).toEqual([{ type: "sandbox/mode", data: { mode: "danger-full-access" } }]);
  });
  it("投影缺失 / 返回非法值：读返回保守默认，绝不猜测", () => {
    expect(buildSandboxContext({}).sessionSandboxMode({ id: "s1" })).toBe("workspace-write");
    expect(buildSandboxContext({ sessionProjections: { stateOf: () => "full-access" } }).sessionSandboxMode({ id: "s1" })).toBe("workspace-write");
    expect(buildSandboxContext({ sessionProjections: { stateOf: () => undefined } }).sessionSandboxMode({ id: "s1" })).toBe("workspace-write");
  });
  it("投影读取抛错：仍返回保守默认（不向外抛，避免打断执行链）", () => {
    const ctx = {
      sessionProjections: {
        stateOf: () => {
          throw new Error("boom");
        },
      },
    };
    expect(buildSandboxContext(ctx).sessionSandboxMode({ id: "s1" })).toBe("workspace-write");
  });
  it("session 不可写（无 append / 无 id）：写入静默忽略，不抛错", () => {
    const sink: { type: string; data: unknown }[] = [];
    const sandbox = buildSandboxContext({ sessionProjections: { stateOf: () => "read-only" } });
    expect(() => sandbox.setSessionSandboxMode({ id: "s1" }, "workspace-write")).not.toThrow();
    expect(() => sandbox.setSessionSandboxMode({ append: () => {} }, "workspace-write")).not.toThrow();
    expect(() => sandbox.setSessionSandboxMode(null, "workspace-write")).not.toThrow();
    expect(() => sandbox.setSessionSandboxMode("not-a-session", "workspace-write")).not.toThrow();
    expect(sink).toHaveLength(0);
  });
});
