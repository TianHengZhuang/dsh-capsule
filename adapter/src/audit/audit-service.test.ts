import { describe, expect, it } from "vitest";
import { AuditService } from "./audit-service.js";
describe("AuditService", () => {
  it("record 自动填充 id/timestamp 并 list 可读", () => {
    const service = new AuditService();
    const event = service.record({ callId: "c1", rootCallId: "r1", toolName: "t", decision: "ASK" });
    expect(typeof event.id).toBe("string");
    expect(event.id.length).toBeGreaterThan(0);
    expect(typeof event.timestamp).toBe("number");
    expect(service.list()).toHaveLength(1);
    expect(service.list()[0].decision).toBe("ASK");
  });
  it("超出容量时环形裁剪，只保留最新 N 条", () => {
    const service = new AuditService(3);
    for (let i = 0; i < 5; i++) {
      service.record({ callId: `c${i}`, rootCallId: `r${i}`, toolName: "t", decision: "ASK" });
    }
    const events = service.list();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.callId)).toEqual(["c2", "c3", "c4"]);
  });
  it("list(limit) 返回最近 N 条", () => {
    const service = new AuditService();
    for (let i = 0; i < 5; i++) {
      service.record({ callId: `c${i}`, rootCallId: `r${i}`, toolName: "t", decision: "ASK" });
    }
    expect(service.list(2).map((e) => e.callId)).toEqual(["c3", "c4"]);
    expect(service.list()).toHaveLength(5);
  });
  it("容量非法抛错（Fail Closed）", () => {
    expect(() => new AuditService(0)).toThrow();
    expect(() => new AuditService(-1)).toThrow();
  });
});
