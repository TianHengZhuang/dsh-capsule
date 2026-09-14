import { GuardError } from "./errors.js";
// 作用：Universal Policy 配置与解析（重构规格第 7 节）——V1 的 match 只支持精确 Tool Name
// （V1.1 再扩展 glob/regex）；TTL 非法（<=0 或 > maxTtlSeconds）一律抛错 Fail Closed，禁止静默 clamp。
export interface FieldsScopeConfig {
  mode: "fields";
  paths: string[];
}
export type ScopeConfig =
  | { mode: "exact-arguments" }
  | FieldsScopeConfig
  | { mode: "tool" };
export interface ToolLeaseRule {
  match: string;
  enabled?: boolean;
  ttlSeconds?: number;
  scope?: ScopeConfig;
}
export interface UniversalPolicyConfig {
  enabled: boolean;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  defaultScope: "exact-arguments";
  rules: ToolLeaseRule[];
}
export interface ResolvedToolPolicy {
  enabled: boolean;
  ttlSeconds: number;
  scope: ScopeConfig;
}
export const DEFAULT_UNIVERSAL_POLICY: UniversalPolicyConfig = {
  enabled: true,
  defaultTtlSeconds: 60,
  maxTtlSeconds: 1800,
  defaultScope: "exact-arguments",
  rules: [],
};
export class PolicyResolver {
  constructor(private readonly config: UniversalPolicyConfig) {
    // 作用：构造即校验配置合法性（Fail Closed）——max/default TTL 非法、rule scope 非法直接抛错
    if (!Number.isInteger(config.maxTtlSeconds) || config.maxTtlSeconds <= 0) {
      throw new GuardError("LEASE_TTL_INVALID", "maxTtlSeconds must be a positive integer");
    }
    if (!Number.isInteger(config.defaultTtlSeconds) || config.defaultTtlSeconds <= 0 || config.defaultTtlSeconds > config.maxTtlSeconds) {
      throw new GuardError("LEASE_TTL_INVALID", "defaultTtlSeconds must be in (0, maxTtlSeconds]");
    }
    for (const rule of config.rules) this.validateRule(rule);
  }
  resolve(toolName: string): ResolvedToolPolicy {
    // 作用：按 Tool Name 解析生效策略——V1 精确匹配取第一条；规则 disabled 则该 Tool 不被 Guard 接管；
    // TTL 超上限或非法即抛错（上层捕获后保持原 ask，不签发 Lease）
    if (!this.config.enabled) {
      return { enabled: false, ttlSeconds: this.config.defaultTtlSeconds, scope: { mode: this.config.defaultScope } };
    }
    const rule = this.config.rules.find((r) => r.match === toolName);
    if (rule?.enabled === false) {
      return { enabled: false, ttlSeconds: this.config.defaultTtlSeconds, scope: { mode: this.config.defaultScope } };
    }
    const scope = rule?.scope ?? { mode: this.config.defaultScope } as ScopeConfig;
    const ttlSeconds = rule?.ttlSeconds ?? this.config.defaultTtlSeconds;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new GuardError("LEASE_TTL_INVALID", `tool ${toolName} ttlSeconds must be a positive integer`);
    }
    if (ttlSeconds > this.config.maxTtlSeconds) {
      throw new GuardError("LEASE_TTL_INVALID", `tool ${toolName} ttlSeconds ${ttlSeconds} exceeds maxTtlSeconds ${this.config.maxTtlSeconds}`);
    }
    return { enabled: true, ttlSeconds, scope };
  }
  private validateRule(rule: ToolLeaseRule): void {
    // 作用：单条规则校验（Fail Closed）——match 必须非空字符串；scope/paths/ttl 非法直接拒绝
    if (typeof rule.match !== "string" || rule.match.length === 0) {
      throw new GuardError("LEASE_POLICY_INVALID", "rule.match must be a non-empty string");
    }
    if (rule.ttlSeconds !== undefined && (!Number.isInteger(rule.ttlSeconds) || rule.ttlSeconds <= 0)) {
      throw new GuardError("LEASE_POLICY_INVALID", `rule ${rule.match} ttlSeconds must be a positive integer`);
    }
    if (rule.scope !== undefined) {
      if (rule.scope.mode === "fields") {
        const paths = (rule.scope as FieldsScopeConfig).paths;
        if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== "string" || p.length === 0)) {
          throw new GuardError("LEASE_POLICY_INVALID", `rule ${rule.match} fields scope requires non-empty string paths`);
        }
      } else if (rule.scope.mode !== "exact-arguments" && rule.scope.mode !== "tool") {
        throw new GuardError("LEASE_POLICY_INVALID", `rule ${rule.match} unknown scope mode`);
      }
    }
  }
}
