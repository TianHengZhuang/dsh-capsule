import { describe, expect, it } from "vitest";
import { defineCapability, isGuardError, SDK_INVALID_CAPABILITY } from "./define-tool.js";
// 作用：断言 fn 抛出的错误 code 为 SDK_INVALID_CAPABILITY（toThrowError 只匹配 message，不匹配 code 属性）
function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(SDK_INVALID_CAPABILITY);
    return;
  }
  expect.unreachable("expected SDK_INVALID_CAPABILITY");
}
describe("extension-sdk defineCapability / isGuardError", () => {
  it("合法定义原样返回（同一引用）", () => {
    const definition = { toolName: "t", provider: "github", action: "issues.read", resource: () => "repo:a/b", ttlSeconds: 60 };
    expect(defineCapability(definition)).toBe(definition);
  });
  it("toolName/provider/action 为空字符串或缺失：抛 SDK_INVALID_CAPABILITY", () => {
    const base = { provider: "github", action: "issues.read", resource: () => "repo:a/b" };
    expectInvalid(() => defineCapability({ ...base, toolName: "" }));
    expectInvalid(() => defineCapability({ ...base, toolName: undefined } as never));
    expectInvalid(() => defineCapability({ toolName: "t", action: "issues.read", resource: () => "repo:a/b" } as never));
    expectInvalid(() => defineCapability({ toolName: "t", provider: "github", resource: () => "repo:a/b" } as never));
  });
  it("resource 非函数或 ttlSeconds 非正整数：抛 SDK_INVALID_CAPABILITY", () => {
    const base = { toolName: "t", provider: "github", action: "issues.read" };
    expectInvalid(() => defineCapability({ ...base, resource: "repo:a/b" } as never));
    expectInvalid(() => defineCapability({ ...base, resource: () => "repo:a/b", ttlSeconds: 0 }));
    expectInvalid(() => defineCapability({ ...base, resource: () => "repo:a/b", ttlSeconds: 1.5 }));
  });
  it("isGuardError：GuardError 形状判别与类型收窄", () => {
    const guardLike = Object.assign(new Error("no lease"), { code: "LEASE_REQUIRED" });
    expect(isGuardError(guardLike)).toBe(true);
    if (isGuardError(guardLike)) {
      expect(guardLike.code).toBe("LEASE_REQUIRED");
    }
    expect(isGuardError(new Error("plain"))).toBe(false);
    expect(isGuardError(Object.assign(new Error("x"), { code: "" }))).toBe(false);
    expect(isGuardError(null)).toBe(false);
    expect(isGuardError("string")).toBe(false);
  });
});
