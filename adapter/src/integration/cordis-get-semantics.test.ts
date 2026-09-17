import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { buildSandboxContext } from "../index.js";
// 作用：固化一条【外部依赖行为】——`ctx.get(name)` 在服务缺失时返回 undefined 而不是抛错。
// Guard 的整个降级契约（服务缺失 → 不提升沙箱模式 → 回到 DSH 原生逐次审批）就建立在这条语义上：
// 若未来 cordis 改为抛错，降级会变成"抛错打断调用链"，属安全方向退化，必须由测试立刻拦住。
describe("cordis ctx.get 语义（Guard 降级契约的外部前提）", () => {
  it("服务未注册：ctx.get 返回 undefined，不抛错", () => {
    const root = new Context();
    expect(root.get("definitely-not-registered")).toBeUndefined();
  });
  it("服务已注册：ctx.get 返回实例；子上下文继承可见", () => {
    const root = new Context();
    root.provide("probeService", { hello: "world" } as never);
    expect(root.get("probeService")).toEqual({ hello: "world" });
    expect(root.extend().get("probeService")).toEqual({ hello: "world" });
  });
  it("缺少 sessionProjections 服务时 sandbox context 完整降级：读保守默认、写静默忽略、均不抛错", () => {
    const root = new Context();
    const sandbox = buildSandboxContext(root as unknown as Record<string, unknown>);
    const session = { id: "s1" };
    expect(sandbox.sessionSandboxMode(session)).toBe("workspace-write");
    expect(() => sandbox.setSessionSandboxMode(session, "danger-full-access")).not.toThrow();
  });
  it("非 cordis 宿主（完全没有 ctx.get）：同样降级且不抛错", () => {
    const sandbox = buildSandboxContext({ on: () => () => undefined });
    expect(sandbox.sessionSandboxMode({ id: "s1" })).toBe("workspace-write");
    expect(() => sandbox.setSessionSandboxMode({ id: "s1" }, "read-only")).not.toThrow();
  });
});
