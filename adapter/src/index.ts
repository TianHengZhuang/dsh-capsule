import { AuditService } from "./audit/audit-service.js";
import { LeaseManager } from "./capability/lease-manager.js";
import { MemoryLeaseStore } from "./capability/lease-store.js";
import { PendingRegistry } from "./capability/pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver, type UniversalPolicyConfig } from "./capability/policy.js";
import { ScopeResolver } from "./capability/scope-resolver.js";
import { UniversalGate } from "./capability/universal-gate.js";
export type CapsuleHostContext = Record<string, unknown>;
export type DisposeHook = () => void | Promise<void>;
export { AuditService, LeaseManager, MemoryLeaseStore, PendingRegistry, PolicyResolver, ScopeResolver, UniversalGate, DEFAULT_UNIVERSAL_POLICY };
export type { UniversalPolicyConfig };
// 作用：DSH Guard 插件入口（重构规格第 16 节）——纯 TypeScript 挂载 Universal Gate 三个 hook；
// 默认路径不 spawn Python、不依赖 Docker / Unix Domain Socket（Phase 0 已冻结 Legacy Isolated Runtime，
// 旧实现保留于 adapter/src/legacy/，规格第 24 节 Phase 5 才作为可选后端接回）。
export const name = "dsh-capability-guard";
export const inject = ["tools", "approval"];
export function apply(ctx: CapsuleHostContext, config?: Partial<UniversalPolicyConfig>): DisposeHook {
  // 作用：组装 Guard 并安装到 DSH——策略来自插件配置（缺省 DEFAULT_UNIVERSAL_POLICY：默认 TTL 60s、
  // 上限 1800s、默认 exact-arguments scope）；任何安装失败立即抛错（Fail Closed，绝不静默降级）
  const policyConfig: UniversalPolicyConfig = {
    ...DEFAULT_UNIVERSAL_POLICY,
    ...config,
    rules: config?.rules ?? DEFAULT_UNIVERSAL_POLICY.rules,
  };
  const gate = new UniversalGate({
    policy: new PolicyResolver(policyConfig),
    scopes: new ScopeResolver(),
    leases: new LeaseManager(new MemoryLeaseStore()),
    pending: new PendingRegistry(),
    audit: new AuditService(),
  });
  if (typeof (ctx as { on?: unknown }).on !== "function") {
    throw new Error("GUARD_INSTALL_FAILED: ctx.on unavailable");
  }
  const dispose = gate.install(ctx as unknown as Parameters<UniversalGate["install"]>[0]);
  return () => {
    dispose();
  };
}
