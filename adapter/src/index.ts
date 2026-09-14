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
import { GovernanceConsole } from "./console/console-service.js";
import { startConsoleServer, type ConsoleHttpHandle } from "./console/http-server.js";
import type { ConsoleHttpConfig } from "./console/types.js";
import { DEFAULT_ISOLATED_INVOKE_TIMEOUT_MS, IsolatedRuntimeManager, type IsolatedRuntimeConfig } from "./isolated/isolated-runtime.js";
import { CapabilityService } from "./service/capability-service.js";
export type CapsuleHostContext = Record<string, unknown>;
export type DisposeHook = () => void | Promise<void>;
export { AuditService, CapabilityService, CredentialBroker, GitHubProvider, GovernanceConsole, IsolatedRuntimeManager, LeaseManager, MemoryLeaseStore, PendingRegistry, PolicyResolver, ProviderRegistry, ScopeResolver, UniversalGate, startConsoleServer, DEFAULT_UNIVERSAL_POLICY, DEFAULT_BROKER_TIMEOUT_MS, DEFAULT_ISOLATED_INVOKE_TIMEOUT_MS, findCredentialService };
export type { UniversalPolicyConfig, CredentialServiceLike, BrokerDeps, ConsoleHttpConfig, IsolatedRuntimeConfig };
// 作用：Guard 插件完整配置——策略项（Partial<UniversalPolicyConfig>）+ Phase 4 Governance Console
// 本地只读查看器开关（默认关闭：仅提供编程 API，不监听任何端口）+ Phase 5 Optional Isolated Runtime
//（默认 native 纯 TS 路径不 spawn Python、不依赖 Docker；仅 runtime.mode = "isolated" 显式 opt-in）。
export interface GuardPluginConfig extends Partial<UniversalPolicyConfig> {
  console?: ConsoleHttpConfig;
  runtime?: IsolatedRuntimeConfig;
}
// 作用：DSH Guard 插件入口（重构规格第 16 节）——纯 TypeScript 挂载 Universal Gate 三个 hook；
// 默认路径不 spawn Python、不依赖 Docker / Unix Domain Socket（Phase 0 已冻结 Legacy Isolated Runtime，
// 旧实现保留于 adapter/src/legacy/，规格第 24 节 Phase 5 才作为可选后端接回）。
export const name = "dsh-capability-guard";
export const inject = ["tools", "approval"];
export async function apply(ctx: CapsuleHostContext, config?: GuardPluginConfig): Promise<DisposeHook> {
  // 作用：组装 Guard 并安装到 DSH——策略来自插件配置（缺省 DEFAULT_UNIVERSAL_POLICY：默认 TTL 60s、
  // 上限 1800s、默认 exact-arguments scope）；任何安装失败立即抛错（Fail Closed，绝不静默降级）。
  // Phase 2：CapabilityService 挂到 ctx.capabilities 供 Managed Extension inject 使用，Managed Tool
  // 的语义 Scope 由 Gate 优先采用（规格 10.4）。Phase 3：组装 ProviderRegistry + GitHubProvider +
  // CredentialBroker 注入 executor——Provider 只能由 Guard Core 内置注册（规格 11.2），每个 operation
  // 现场定位 ctx.credentials 并重新 resolve（规格 11.3 禁止跨 operation 缓存 Secret）。
  // Phase 4：GovernanceConsole 聚合 Audit/Leases/Capabilities/Providers 五维治理视图；配置
  // console.enabled 时额外启动本地只读 HTTP 查看器（默认 127.0.0.1，启动失败 Fail Closed 抛错）。
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
  const audit = new AuditService();
  const gate = new UniversalGate({
    policy: new PolicyResolver(policyConfig),
    scopes: new ScopeResolver(),
    leases,
    pending: new PendingRegistry(),
    audit,
    managed: capabilities,
  });
  const govConsole = new GovernanceConsole({ audit, leases, capabilities, providers: registry, guardName: name });
  // Phase 5：Optional Isolated Runtime——仅 runtime.mode = "isolated" 显式 opt-in 时接回 Legacy
  // Python Runtime + Docker Capsule（规格第 24 节 Phase 5 / 第 3.3 节）；放在 hook 安装之前启动，
  // 失败即抛 ISOLATED_RUNTIME_FAILED（Fail Closed：不静默降级，且此时尚未产生任何 DSH 副作用）；
  // 默认（无 runtime 配置 / mode 缺省）完全不实例化，纯 TS 路径不 spawn Python、不依赖 Docker。
  let isolated: IsolatedRuntimeManager | undefined;
  if (config?.runtime?.mode === "isolated") {
    isolated = new IsolatedRuntimeManager({
      pythonCmd: config.runtime.pythonCmd,
      runtimeDir: config.runtime.runtimeDir,
      invokeTimeoutMs: config.runtime.invokeTimeoutMs,
      ctx,
    });
    await isolated.start();
  }
  if (typeof (ctx as { on?: unknown }).on !== "function") {
    throw new Error("GUARD_INSTALL_FAILED: ctx.on unavailable");
  }
  // TODO(规则 4/规格 10.1)：接入真实 DSH/Cordis 时改为 CapabilityService extends Cordis Service
  //（super(ctx, 'capabilities')）并经 declare module '@deepseek-ai/cordis' 声明 Context 类型扩展；
  // 当前以直接挂载属性方式提供 ctx.capabilities，dispose 时一并移除。
  (ctx as { capabilities?: unknown }).capabilities = capabilities;
  const dispose = gate.install(ctx as unknown as Parameters<UniversalGate["install"]>[0]);
  let consoleHandle: ConsoleHttpHandle | undefined;
  if (config?.console?.enabled === true) {
    consoleHandle = await startConsoleServer({ console: govConsole, host: config.console.host, port: config.console.port });
  }
  return async () => {
    if (consoleHandle) {
      await consoleHandle.close();
    }
    if (isolated) {
      await isolated.dispose();
    }
    dispose();
    delete (ctx as { capabilities?: unknown }).capabilities;
  };
}
