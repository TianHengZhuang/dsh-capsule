import { describe, expect, it } from "vitest";
import { canonicalize, sha256Scope } from "./canonical.js";
describe("canonicalize / sha256Scope", () => {
  it("object key 顺序不同 canonical 与 hash 完全一致（规格 22.14）", () => {
    const a = { repo: "company/backend", title: "bug", labels: ["p0", "ui"] };
    const b = { labels: ["p0", "ui"], title: "bug", repo: "company/backend" };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(sha256Scope(a)).toBe(sha256Scope(b));
  });
  it("嵌套结构按字典序稳定序列化且 array 保持顺序", () => {
    expect(canonicalize({ b: { d: 1, c: 2 }, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"b":{"c":2,"d":1}}');
  });
  it("基础类型编码稳定", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize("x")).toBe('"x"');
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize([])).toBe("[]");
    expect(canonicalize({})).toBe("{}");
  });
  it("非法值一律抛错（Fail Closed）", () => {
    for (const bad of [() => 1, Symbol("s"), 10n, undefined, NaN, Infinity]) {
      expect(() => canonicalize(bad)).toThrow("LEASE_SCOPE_INVALID");
    }
    expect(() => canonicalize({ nested: 10n })).toThrow("LEASE_SCOPE_INVALID");
    expect(() => canonicalize({ a: undefined })).toThrow("LEASE_SCOPE_INVALID");
    expect(() => sha256Scope({ a: () => 1 })).toThrow("LEASE_SCOPE_INVALID");
  });
});
