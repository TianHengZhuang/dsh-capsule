import { AuditService } from "./audit/audit-service.js";
import { CredentialBroker, DEFAULT_BROKER_TIMEOUT_MS, findCredentialService, type BrokerDeps, type CredentialServiceLike } from "./broker/broker.js";
import { GitHubProvider } from "./broker/providers/github.js";
import { ProviderRegistry } from "./broker/registry.js";
import { LeaseManager } from "./capability/lease-manager.js";
import { MemoryLeaseStore } from "./capability/lease-store.js";
import { PendingRegistry } from "./capability/pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver, type UniversalPolicyConfig } from "./capability/policy.js";
import { ScopeResolver } from "./capability/scope-resolver.js";
import { UniversalGate } from "./capability/universal-gate.js";
import { CapabilityService } from "./service/capability-service.js";
export type CapsuleHostContext = Record<string, unknown>;
export type DisposeHook = () => void | Promise<void>;
export { AuditService, CapabilityService, CredentialBroker, GitHubProvider, LeaseManager, MemoryLeaseStore, PendingRegistry, PolicyResolver, ProviderRegistry, ScopeResolver, UniversalGate, DEFAULT_UNIVERSAL_POLICY, DEFAULT_BROKER_TIMEOUT_MS, findCredentialService };
export type { UniversalPolicyConfig, CredentialServiceLike, BrokerDeps };
// 作用：DSH Guard 插件入口（重构规格第 16 节）——纯 TypeScript 挂载 Universal Gate 三个 hook；
// 默认路径不 spawn Python、不依赖 Docker / Unix Domain Socket（Phase 0 已冻结 Legacy Isolated Runtime，
// 旧实现保留于 adapter/src/legacy/，规格第 24 节 Phase 5 才作为可选后端接回）。
export const name = "dsh-capability-guard";
export const inject = ["tools", "approval"];
export function apply(ctx: CapsuleHostContext, config?: Partial<UniversalPolicyConfig>): DisposeHook {
  // 作用：组装 Guard 并安装到 DSH——策略来自插件配置（缺省 DEFAULT_UNIVERSAL_POLICY：默认 TTL 60s、
  // 上限 1800s、默认 exact-arguments scope）；任何安装失败立即抛错（Fail Closed，绝不静默降级）。
  // Phase 2：CapabilityService 挂到 ctx.capabilities 供 Managed Extension inject 使用，Managed Tool
  // 的语义 Scope 由 Gate 优先采用（规格 10.4）。Phase 3：组装 ProviderRegistry + GitHubProvider +
  // CredentialBroker 注入 executor——Provider 只能由 Guard Core 内置注册（规格 11.2），每个 operation
  // 现场定位 ctx.credentials 并重新 resolve（规格 11.3 禁止跨 operation 缓存 Secret）。
  const policyConfig: UniversalPolicyConfig = {
    ...DEFAULT_UNIVERSAL_POLICY,
    ...config,
    rules: config?.rules ?? DEFAULT_UNIVERSAL_POLICY.rules,
  };
  const leases = new LeaseManager(new MemoryLeaseStore());
  const registry = new ProviderRegistry();
  registry.register(new GitHubProvider());
  const broker = new CredentialBroker({ registry, getCredentials: () => findCredentialService(ctx) });
  const capabilities = new CapabilityService({
    leases,
    defaultTtlSeconds: policyConfig.defaultTtlSeconds,
    maxTtlSeconds: policyConfig.maxTtlSeconds,
    executor: broker,
  });
  const gate = new UniversalGate({
    policy: new PolicyResolver(policyConfig),
    scopes: new ScopeResolver(),
    leases,
    pending: new PendingRegistry(),
    audit: new AuditService(),
    managed: capabilities,
  });
  if (typeof (ctx as { on?: unknown }).on !== "function") {
    throw new Error("GUARD_INSTALL_FAILED: ctx.on unavailable");
  }
  // TODO(规则 4/规格 10.1)：接入真实 DSH/Cordis 时改为 CapabilityService extends Cordis Service
  //（super(ctx, 'capabilities')）并经 declare module '@deepseek-ai/cordis' 声明 Context 类型扩展；
  // 当前以直接挂载属性方式提供 ctx.capabilities，dispose 时一并移除。
  (ctx as { capabilities?: unknown }).capabilities = capabilities;
  const dispose = gate.install(ctx as unknown as Parameters<UniversalGate["install"]>[0]);
  return () => {
    dispose();
    delete (ctx as { capabilities?: unknown }).capabilities;
  };
}
