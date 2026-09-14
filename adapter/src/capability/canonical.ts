import { createHash } from "node:crypto";
// 作用：稳定 Canonical JSON 与 Scope 哈希（重构规格第 5.5 节）——object key 按字典序排序、
// array 保持顺序、禁止 function/symbol/bigint/undefined/非有限数字；任何非法值抛错（Fail Closed，
// 上层 Scope Resolver 捕获后不签发 Lease）。
export function canonicalize(value: unknown): string {
  return serializeCanonical(value);
}
export function sha256Scope(value: unknown): string {
  // 作用：对任意 JSON 兼容值生成 SHA-256 十六进制 Scope key——Lease 只保存哈希，不保存参数原文
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}
function serializeCanonical(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value)) throw new Error("LEASE_SCOPE_INVALID: non-finite number");
    return JSON.stringify(value);
  }
  if (type === "boolean") return value ? "true" : "false";
  if (type === "undefined" || type === "bigint" || type === "function" || type === "symbol") {
    throw new Error(`LEASE_SCOPE_INVALID: unsupported value type ${type}`);
  }
  if (Array.isArray(value)) return `[${value.map((item) => serializeCanonical(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serializeCanonical(obj[k])}`).join(",")}}`;
}
