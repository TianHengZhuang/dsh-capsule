import { describe, expect, it } from "vitest";
import { ESCALATION_DISPLAY_MAX_LENGTH, SANDBOX_MODES, escalationScopeDisplay, escalationScopeKey, isModeWiderThan, isSandboxMode, parseEscalation } from "./escalation.js";
describe("沙箱升级确定性识别（P0-1）", () => {
  it("识别标准升级参数：sandbox_permissions 为闭集字面量且 justification 非空", () => {
    const parsed = parseEscalation({ sandbox_permissions: "danger-full-access", justification: "需要写入工作区外文件" });
    expect(parsed).toEqual({ requestedMode: "danger-full-access", justification: "需要写入工作区外文件" });
  });
  it("三个闭集模式都能识别", () => {
    for (const mode of SANDBOX_MODES) {
      expect(parseEscalation({ sandbox_permissions: mode, justification: "x" })?.requestedMode).toBe(mode);
    }
  });
  it("非闭集模式一律不识别（Fail Closed，不猜测）", () => {
    for (const bad of ["full-access", "DANGER-FULL-ACCESS", "workspace_write", "", "root", "danger-full-access "]) {
      expect(parseEscalation({ sandbox_permissions: bad, justification: "x" })).toBeUndefined();
    }
  });
  it("非字符串 / 非对象 / 数组 / null 一律不识别", () => {
    expect(parseEscalation(undefined)).toBeUndefined();
    expect(parseEscalation(null)).toBeUndefined();
    expect(parseEscalation([])).toBeUndefined();
    expect(parseEscalation("sandbox_permissions")).toBeUndefined();
    expect(parseEscalation({ sandbox_permissions: 1, justification: "x" })).toBeUndefined();
    expect(parseEscalation({ sandbox_permissions: null, justification: "x" })).toBeUndefined();
  });
  it("justification 缺失、空串或非字符串一律不识别（DSH 要求两者配对）", () => {
    expect(parseEscalation({ sandbox_permissions: "workspace-write" })).toBeUndefined();
    expect(parseEscalation({ sandbox_permissions: "workspace-write", justification: "" })).toBeUndefined();
    expect(parseEscalation({ sandbox_permissions: "workspace-write", justification: 42 })).toBeUndefined();
    expect(parseEscalation({ sandbox_permissions: "workspace-write", justification: null })).toBeUndefined();
  });
  it("只识别 DSH 的精确键名，近似键名不识别（防止第三方工具的同名语义混淆）", () => {
    expect(parseEscalation({ sandboxPermissions: "danger-full-access", justification: "x" })).toBeUndefined();
    expect(parseEscalation({ sandbox_permission: "danger-full-access", justification: "x" })).toBeUndefined();
    expect(parseEscalation({ mode: "danger-full-access", justification: "x" })).toBeUndefined();
  });
  it("允许携带无关参数：识别只依赖两个升级字段的存在与形状", () => {
    const parsed = parseEscalation({ command: "Set-Content C:\\x", sandbox_permissions: "danger-full-access", justification: "y", timeoutMs: 1000 });
    expect(parsed?.requestedMode).toBe("danger-full-access");
  });
});
describe("沙箱升级语义 Scope（P0-1）", () => {
  it("key 与模型自由文本无关：justification 不同但工具与模式相同 → key 相同（获批后可复用）", () => {
    const a = parseEscalation({ sandbox_permissions: "danger-full-access", justification: "第一次措辞" });
    const b = parseEscalation({ sandbox_permissions: "danger-full-access", justification: "完全不同的第二次措辞" });
    expect(a && b).toBeTruthy();
    expect(escalationScopeKey({ toolName: "pwsh", requestedMode: a!.requestedMode })).toBe(escalationScopeKey({ toolName: "pwsh", requestedMode: b!.requestedMode }));
  });
  it("key 与参数原文无关：命令不同但工具与模式相同 → key 相同", () => {
    expect(escalationScopeKey({ toolName: "pwsh", requestedMode: "danger-full-access" })).toBe(escalationScopeKey({ toolName: "pwsh", requestedMode: "danger-full-access" }));
  });
  it("工具名或目标模式不同 → key 不同（授权面不跨工具、不跨模式扩大）", () => {
    const base = escalationScopeKey({ toolName: "pwsh", requestedMode: "danger-full-access" });
    expect(escalationScopeKey({ toolName: "write", requestedMode: "danger-full-access" })).not.toBe(base);
    expect(escalationScopeKey({ toolName: "pwsh", requestedMode: "workspace-write" })).not.toBe(base);
    expect(escalationScopeKey({ toolName: "bash", requestedMode: "danger-full-access" })).not.toBe(base);
  });
  it("key 是稳定 SHA-256 十六进制（64 字符）", () => {
    expect(escalationScopeKey({ toolName: "pwsh", requestedMode: "read-only" })).toMatch(/^[0-9a-f]{64}$/);
  });
  it("display 只含工具名与目标模式，无 justification 时不追加", () => {
    expect(escalationScopeDisplay({ toolName: "pwsh", requestedMode: "danger-full-access" })).toBe("tool=pwsh 沙箱升级至 danger-full-access");
  });
  it("display 超长 justification 必须截断到固定上限（审计与 Approval reason 不接受无限文本）", () => {
    const long = "理由".repeat(500);
    const display = escalationScopeDisplay({ toolName: "write", requestedMode: "danger-full-access" }, long);
    expect(display).toBe(`tool=write 沙箱升级至 danger-full-access（模型理由：${"理由".repeat(ESCALATION_DISPLAY_MAX_LENGTH / 2)}…）`);
  });
});
describe("沙箱模式宽窄比较（P0-1）", () => {
  it("只有严格更宽才为 true（用于判断是否需要提升会话模式）", () => {
    expect(isModeWiderThan("danger-full-access", "workspace-write")).toBe(true);
    expect(isModeWiderThan("workspace-write", "read-only")).toBe(true);
    expect(isModeWiderThan("danger-full-access", "read-only")).toBe(true);
  });
  it("相同或更窄均为 false（避免无意义的模式抖动与降级）", () => {
    expect(isModeWiderThan("workspace-write", "workspace-write")).toBe(false);
    expect(isModeWiderThan("workspace-write", "danger-full-access")).toBe(false);
    expect(isModeWiderThan("read-only", "workspace-write")).toBe(false);
  });
  it("isSandboxMode 只接受闭集字面量", () => {
    expect(isSandboxMode("danger-full-access")).toBe(true);
    expect(isSandboxMode("danger-full-access ")).toBe(false);
    expect(isSandboxMode(undefined)).toBe(false);
    expect(isSandboxMode(3)).toBe(false);
  });
});
