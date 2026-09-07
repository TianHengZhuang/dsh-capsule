import { describe, expect, it } from "vitest";
import { createLeaseApprovalHandler, getApprovalService, type DshApprovalService } from "./approval.js";
const baseReq = { capsuleId: "github-reader", provider: "github", resource: "repo:foo/bar", action: "issues.read", ttlSeconds: 600 };
function approvalReturning(result: unknown): { service: DshApprovalService; calls: any[] } {
  // 作用：构造记录调用参数的假 DSH approval 服务
  const calls: any[] = [];
  return { calls, service: { request: async (req: any) => { calls.push(req); return result; } } };
}
describe("createLeaseApprovalHandler", () => {
  it("allowed-once 决策放行并回传 decision，reason 含完整授权信息", async () => {
    const { service, calls } = approvalReturning("allowed-once");
    await expect(createLeaseApprovalHandler(() => service)({ ...baseReq })).resolves.toEqual({ decision: "allowed-once" });
    expect(calls[0].reason).toContain("github-reader");
    expect(calls[0].reason).toContain("issues.read");
    expect(calls[0].reason).toContain("repo:foo/bar");
    expect(calls[0].reason).toContain("600");
  });
  it("对象形 decision=allowed-once 同样放行（规则 15：以实际 DSH 返回形状为准）", async () => {
    const { service } = approvalReturning({ decision: "allowed-once" });
    await expect(createLeaseApprovalHandler(() => service)({ ...baseReq })).resolves.toEqual({ decision: "allowed-once" });
  });
  it("rejected/cancelled/unavailable 决策一律拒绝（Fail Closed）", async () => {
    for (const decision of ["rejected", "cancelled", "unavailable"]) {
      const { service } = approvalReturning(decision);
      await expect(createLeaseApprovalHandler(() => service)({ ...baseReq })).rejects.toThrow("LEASE_REJECTED");
    }
  });
  it("approval 服务不可用即拒绝", async () => {
    await expect(createLeaseApprovalHandler(() => undefined)({ ...baseReq })).rejects.toThrow("LEASE_REJECTED");
  });
  it("参数缺失或非法拒绝（Fail Closed）", async () => {
    const { service } = approvalReturning("allowed-once");
    const handler = createLeaseApprovalHandler(() => service);
    await expect(handler({ ...baseReq, resource: undefined })).rejects.toThrow("LEASE_REJECTED");
    await expect(handler({ ...baseReq, capsuleId: "" })).rejects.toThrow("LEASE_REJECTED");
    await expect(handler({ ...baseReq, ttlSeconds: 0 })).rejects.toThrow("LEASE_REJECTED");
    await expect(handler({ ...baseReq, ttlSeconds: 10.5 })).rejects.toThrow("LEASE_REJECTED");
    await expect(handler(null)).rejects.toThrow("LEASE_REJECTED");
  });
});
describe("getApprovalService", () => {
  it("从 ctx 定位 approval 服务", () => {
    expect(getApprovalService({ approval: { request: async () => "allowed-once" } })).toBeDefined();
  });
  it("形状不符或缺失时返回 undefined（Fail Closed）", () => {
    expect(getApprovalService({})).toBeUndefined();
    expect(getApprovalService({ approval: {} })).toBeUndefined();
    expect(getApprovalService({ approval: "nope" })).toBeUndefined();
  });
});
