import { describe, expect, it } from "vitest";
import { LeaseManager } from "./lease-manager.js";
import { MemoryLeaseStore } from "./lease-store.js";
import type { CapabilityScope } from "./types.js";
const scopeOf = (key = "k1"): CapabilityScope => ({ kind: "exact-arguments", key, display: `d:${key}` });
describe("LeaseManager + MemoryLeaseStore", () => {
  it("issue 签发 ACTIVE Lease 并可 findMatching 复用", async () => {
    const now = 1000;
    const clock = () => now;
    const manager = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const lease = await manager.issue({ sessionId: "s1", toolName: "t", scope: scopeOf(), ttlSeconds: 60 });
    expect(lease.status).toBe("ACTIVE");
    expect(lease.kind).toBe("universal");
    expect(lease.expiresAt).toBe(1000 + 60_000);
    const hit = await manager.findMatching("s1", "t", "k1");
    expect(hit?.id).toBe(lease.id);
  });
  it("TTL 到期后 findMatching 返回 undefined（规格 22.10）", async () => {
    let now = 1000;
    const clock = () => now;
    const manager = new LeaseManager(new MemoryLeaseStore(clock), clock);
    await manager.issue({ sessionId: "s1", toolName: "t", scope: scopeOf(), ttlSeconds: 60 });
    now += 60_001;
    expect(await manager.findMatching("s1", "t", "k1")).toBeUndefined();
  });
  it("validate：过期抛 LEASE_EXPIRED 且惰性标记；撤销抛 LEASE_REVOKED", async () => {
    let now = 1000;
    const clock = () => now;
    const manager = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const expired = await manager.issue({ sessionId: "s1", toolName: "t", scope: scopeOf(), ttlSeconds: 60 });
    now += 60_001;
    expect(() => manager.validate(expired)).toThrow("LEASE_EXPIRED");
    expect(expired.status).toBe("EXPIRED");
    const revoked = await manager.issue({ sessionId: "s1", toolName: "t", scope: scopeOf("k2"), ttlSeconds: 60 });
    await manager.revoke(revoked.id, "manual");
    expect(() => manager.validate(revoked)).toThrow("LEASE_REVOKED");
    expect(revoked.status).toBe("REVOKED");
    expect(revoked.revokeReason).toBe("manual");
  });
  it("revoke 后 findMatching 立即失效（规格 22.11）", async () => {
    const now = 1000;
    const clock = () => now;
    const manager = new LeaseManager(new MemoryLeaseStore(clock), clock);
    const lease = await manager.issue({ sessionId: "s1", toolName: "t", scope: scopeOf(), ttlSeconds: 60 });
    expect(await manager.revoke(lease.id)).toBe(true);
    expect(await manager.findMatching("s1", "t", "k1")).toBeUndefined();
    expect(await manager.revoke(lease.id)).toBe(false);
  });
  it("revokeSession 撤销该 Session 全部 Lease 并返回数量", async () => {
    const clock = () => 1000;
    const manager = new LeaseManager(new MemoryLeaseStore(clock), clock);
    await manager.issue({ sessionId: "s1", toolName: "t1", scope: scopeOf("a"), ttlSeconds: 60 });
    await manager.issue({ sessionId: "s1", toolName: "t2", scope: scopeOf("b"), ttlSeconds: 60 });
    await manager.issue({ sessionId: "s2", toolName: "t1", scope: scopeOf("a"), ttlSeconds: 60 });
    expect(await manager.revokeSession("s1", "session disposed")).toBe(2);
    const remaining = await manager.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sessionId).toBe("s2");
  });
  it("issue 参数非法抛错（Fail Closed）", async () => {
    const manager = new LeaseManager(new MemoryLeaseStore());
    await expect(manager.issue({ sessionId: "", toolName: "t", scope: scopeOf(), ttlSeconds: 60 })).rejects.toThrow("LEASE_INVALID_INPUT");
    await expect(manager.issue({ sessionId: "s", toolName: "", scope: scopeOf(), ttlSeconds: 60 })).rejects.toThrow("LEASE_INVALID_INPUT");
    await expect(manager.issue({ sessionId: "s", toolName: "t", scope: { kind: "exact-arguments", key: "", display: "" }, ttlSeconds: 60 })).rejects.toThrow("LEASE_INVALID_INPUT");
    await expect(manager.issue({ sessionId: "s", toolName: "t", scope: scopeOf(), ttlSeconds: 0 })).rejects.toThrow("LEASE_TTL_INVALID");
    await expect(manager.issue({ sessionId: "s", toolName: "t", scope: scopeOf(), ttlSeconds: 1.5 })).rejects.toThrow("LEASE_TTL_INVALID");
  });
  it("撤销最新 Lease 后不回退复用更早的 ACTIVE Lease（Fail Closed）", async () => {
    const clock = () => 1000;
    const manager = new LeaseManager(new MemoryLeaseStore(clock), clock);
    await manager.issue({ sessionId: "s1", toolName: "t", scope: scopeOf(), ttlSeconds: 60 });
    const second = await manager.issue({ sessionId: "s1", toolName: "t", scope: scopeOf(), ttlSeconds: 60 });
    await manager.revoke(second.id);
    expect(await manager.findMatching("s1", "t", "k1")).toBeUndefined();
  });
  it("gc 删除过期超过 1 小时的记录（仅内存回收，非安全机制）", async () => {
    let now = 1000;
    const clock = () => now;
    const store = new MemoryLeaseStore(clock);
    const manager = new LeaseManager(store, clock);
    await manager.issue({ sessionId: "s1", toolName: "t", scope: scopeOf(), ttlSeconds: 60 });
    now += 3_600_001;
    expect(store.gc(now)).toBe(1);
    expect(await manager.list()).toHaveLength(0);
  });
});
