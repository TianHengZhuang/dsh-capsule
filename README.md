<p align="center">
  <img src="assets/hero-cn.svg" alt="DSH Capsule — DeepSeek Harness Capability Guard" width="100%" />
</p>

<p align="center">
  <a href="README.md"><b>简体中文</b></a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek_Harness-Plugin-4F46E5?style=flat-square" alt="DeepSeek Harness Plugin" />
  <img src="https://img.shields.io/badge/status-Developer_Preview-F59E0B?style=flat-square" alt="Developer Preview" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22" />
  <img src="https://img.shields.io/badge/Runtime_Dependencies-0-12B76A?style=flat-square" alt="No runtime dependencies" />
  <img src="https://img.shields.io/badge/License-MIT-12B76A?style=flat-square" alt="MIT" />
</p>

<p align="center">
  <b>让 Agent 获得短期、可撤销、可审计的能力，而不是长期持有凭证。</b>
</p>

<p align="center">
  DSH Capsule 是面向 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 的 <b>Capability Guard</b>：<br/>
  对已有 Tool 提供零改造的短期 Lease 层；对受管扩展提供 Credential Broker 与 Provider 代理执行。
</p>

> [!IMPORTANT]
> **项目定位已经变化。** 当前仓库是纯 TypeScript 的 Capability Guard，不再包含旧版 Python / Docker / Unix Domain Socket 隔离 Runtime。本文只描述当前代码真实存在的能力。

> [!WARNING]
> **Developer Preview。** Lease、Managed Capability、Broker、GitHub Provider、Audit 与 Governance Console 已在仓库实现；但 `adapter` 仍使用与 DSH 解耦的最小接口，真实 DeepSeek Harness / Cordis 包级类型与安装链路尚待正式联调。当前版本不应宣传为已可直接 `dsh plugin add` 的生产发行包。

---

## 为什么需要它？

Agent 工具权限通常有两个极端：要么每次敏感操作都重新审批，体验很差；要么把长期 Token / 宽权限一次性交给插件，授权面又过大。

DSH Capsule 在两者之间增加一层**短生命周期 Capability**：

| 问题 | DSH Capsule 的处理方式 |
|---|---|
| 同一个安全操作反复弹审批 | `allowed-once` 后签发短期 Lease，在相同 Scope + Session 内复用 |
| 授权范围太宽 | Lease 绑定 `Session × Tool × Scope × TTL` |
| 插件直接接触长期 Token | Managed Extension 只提交 Operation，Broker 每次调用时动态解析 Credential |
| 插件伪造资源或 Action | Guard 从可信 `run.arguments` 重算资源，再与 Operation 做完整比对 |
| 权限过期或需要立即回收 | 实时 TTL 校验 + `revoke()` / `revokeSession()` |
| 发生了什么难以追踪 | Secret-safe Audit + 只读 Governance Console |
| 安全失败被静默放行 | 关键路径统一 **Fail Closed** |

一句话理解：

> **Universal Mode 管“这个 Tool 现在还要不要再问一次”；Managed Mode 管“批准后谁能拿凭证、能执行什么外部操作”。**

---

## 两种工作模式

### 1. Universal Mode — 已有插件零改造获得短期授权

如果某个已安装 Tool 原本就会被 DSH Policy 判定为 `ask`，Guard 可以直接工作在原生 `tools/pre-execute` / `approval/request` / `tools/result` 链路上：

- 原始 `deny`：始终保持 `deny`，Lease **不能覆盖拒绝**；
- 原始 `allow`：直接透传，Guard 不制造新的 Approval；
- 原始 `ask`：先查找匹配 Lease；命中则临时 `allow`，否则继续 `ask`；
- 用户返回 `allowed-once` 后，Guard 才签发带 Scope 与 TTL 的 Lease；
- `rejected` / `cancelled` / `unavailable` 均不签发。

这意味着 Universal Mode 的价值是**减少重复审批，同时保持 DSH 原有权限语义不变**。

<p align="center">
  <img src="assets/universal-lease-cn.svg" alt="Universal Mode Lease Flow" width="100%" />
</p>

### 2. Managed Mode — 高权限操作通过 Broker 执行

对于按 Guard SDK 编写的 Managed Extension，扩展注册的不再只是一个 Tool，而是一条明确的语义能力：

```text
toolName + provider + action + resource(args) + ttl
```

执行时，扩展向 `ctx.capabilities.execute()` 提交一个 `BrokerOperation`。Guard 会：

1. 从可信 Tool Runtime 的 `run.name / run.arguments / run.agent.id` 重新计算期望能力；
2. 比较 `provider / action / resource` 是否与注册定义完全一致；
3. 校验对应 Managed Lease 是否有效；
4. 交给受信任 Broker；
5. Broker 检查 Provider Action Allowlist；
6. **每次 Operation 重新**通过 `ctx.credentials.resolve(ref)` 解析 Credential；
7. Provider 执行受控 API 请求并返回白名单结果。

<p align="center">
  <img src="assets/managed-broker-cn.svg" alt="Managed Capability Broker Flow" width="100%" />
</p>

这里的关键原则是：

> **Extension 传递 Operation，Broker 持有 Authority；Secret 不需要成为 Extension 的长期状态。**

---

## 整体架构

<p align="center">
  <img src="assets/architecture-cn.svg" alt="DSH Capability Guard Architecture" width="100%" />
</p>

当前核心组件：

| 组件 | 职责 |
|---|---|
| `UniversalGate` | 横切 DSH Tool Pipeline，只增强下游 `ask`，处理 Lease 复用、签发与审计 |
| `PolicyResolver` | 解析全局和 Tool 级 TTL / Scope 策略，非法策略 Fail Closed |
| `ScopeResolver` | 生成 `exact-arguments` / `fields` / `tool` Scope |
| `LeaseManager` | `issue` / `validate` / `findMatching` / `revoke` / `revokeSession` |
| `CapabilityService` | 暴露 `ctx.capabilities`，管理 Managed Capability，并在执行前做双重校验 |
| `CredentialBroker` | Provider 查找、Action Allowlist、per-operation Credential Resolution、超时和错误脱敏 |
| `ProviderRegistry` | 管理可信 Provider Adapter；第三方 Extension 不直接注册 Secret-capable Provider |
| `GitHubProvider` | 当前示例 Provider，支持 `issues.read` / `issues.create` |
| `AuditService` | 内存 Ring Buffer，记录不含 Secret / 原始参数的安全事件 |
| `GovernanceConsole` | 只读聚合 Plugins / Tools / Capabilities / Leases / Activity / Audit |

### 与 DSH 原生机制的边界

DSH Capsule **不是第二套 Harness**。它有意复用 DSH 已有机制：

- Approval 仍由 DSH 原生 `approval/request` Answerer 决定；
- Tool 最终是否允许执行仍受 DSH 其他 Gate / Guard 约束；
- Credential 仍来自 DSH Credential Service；
- 进程 / 文件 / 网络隔离仍由 DSH Sandbox 或外部安全机制负责。

Guard 只新增一件事：**把一次明确的授权变成受 Scope、Session 与 TTL 约束的短期 Capability，并在 Managed Mode 中把 Credential 解析集中到 Broker。**

---

## Capability Lease

一份 Lease 的核心身份不是“这个插件被允许了”，而是：

```text
Session × Tool × Scope × TTL
```

Managed Capability 的 Scope 进一步表达为：

```text
Provider × Resource × Action
```

例如：

```text
session:   agent/session-42
tool:      guard_github_read_issue
provider:  github
resource:  repo:acme/platform
action:    issues.read
ttl:       60s
```

这表示：**这个 Session 在 Lease 有效期内，可以通过指定 Tool 对 `repo:acme/platform` 执行 `issues.read`，而不是“获得 GitHub 权限”。**

### Lease 生命周期

```text
ASK
 └─ allowed-once
      └─ ISSUE ────────┐
                       │
                  ACTIVE
                   ├─ match → REUSE
                   ├─ TTL   → EXPIRED
                   └─ revoke→ REVOKED
```

- TTL 在 `find` / `validate` 时通过当前时间实时判断，正确性不依赖后台定时器；
- Lease 始终绑定 Session；缺少可信 `agent.id` 时不会创建匿名 / 全局 Lease；
- `revoke(leaseId)` 可撤销单条 Lease；
- `revokeSession(sessionId)` 可一次撤销整个 Session 的 Lease；
- 当前默认存储是 `MemoryLeaseStore`，重启后不会保留。

---

## Scope：决定“授权可以复用到哪里”

<p align="center">
  <img src="assets/scope-model-cn.svg" alt="Capability Scope Model" width="100%" />
</p>

### `exact-arguments` — 默认

默认 Scope：

```text
SHA-256(toolName + canonical JSON(arguments))
```

只有 Tool 与参数完全一致时才能复用，是 Universal Mode 最保守的零配置策略。

### `fields` — 显式放宽

只把指定字段纳入 Scope。例如只按 `repo` 与 `branch` 授权，其他参数变化不会重新 Ask。

### `tool` — 最宽

同一 Session 内只按 Tool Name 复用。它必须显式配置，不能成为默认行为。

### `managed` — 业务语义 Scope

Managed Extension 不依赖参数字符串猜测，而是由扩展确定性声明：

```text
provider + resource(args) + action
```

Guard 将其哈希为 Scope Key，并在实际执行前再次从 `run.arguments` 重算 resource，阻止 Extension 提交与注册能力不一致的 Operation。

---

## Credential Broker 为什么仍然重要？

即使当前版本不再提供 Docker 隔离 Runtime，Broker 依然有独立价值：**减少长期 Credential 的分发面，并把高权限 API 调用集中到可审核的可信路径。**

当前 Broker 具备以下约束：

- Provider 必须存在于 `ProviderRegistry`；
- Action 必须在 Provider 的 `allowedActions` 中；
- Credential **不跨 Operation 缓存**；
- Provider 请求可配置超时，默认 `15s`；
- Provider 错误从 Broker 出口统一包装，Credential 原文会被替换为 `***`；
- Provider Result 由 Adapter 做字段白名单提取；
- Extension SDK 不包含 Credential API。

当前内置 GitHub Provider 只允许：

```text
issues.read
issues.create
```

目标仓库必须来自已经通过 Lease 校验的 `repo:owner/repo` Resource，而不是任意 URL。

---

## Governance Console

<p align="center">
  <img src="assets/governance-console-cn.svg" alt="Governance Console Preview" width="100%" />
</p>

Console 默认关闭。开启后启动一个**只读**本地 HTTP 查看器：

```ts
{
  console: {
    enabled: true,
    host: "127.0.0.1",
    port: 8787,
  }
}
```

只提供：

```text
GET /
GET /api/snapshot
GET /api/audit
```

`/api/audit` 支持按 `sessionId`、`toolName`、`decision`、`limit` 过滤。

安全属性：

- 默认仅监听 `127.0.0.1`；
- 无任何写接口；
- 响应使用 `no-store`、`nosniff` 与 CSP；
- UI 动态数据通过 `textContent` 渲染；
- 只展示白名单投影，不包含 Credential、Authorization Header 或原始 Tool Arguments。

---

## 快速开始

### 环境要求

- Node.js `22`
- pnpm `11.25.0`（仓库 `packageManager` 已固定版本）
- Windows / macOS / Linux 均可运行核心 TypeScript 代码；CI 已配置三平台矩阵

> [!NOTE]
> 当前仓库尚未完成正式的 DSH package / profile 发布，因此以下步骤是**源码开发方式**，不是最终用户安装命令。

```bash
git clone <your-repository-url>
cd dsh-capsule

pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Workspace：

```text
@dsh-capsule/adapter
@dsh-capsule/extension-sdk
@dsh-capsule/github-demo
```

### 默认策略

```ts
{
  enabled: true,
  defaultTtlSeconds: 60,
  maxTtlSeconds: 1800,
  defaultScope: "exact-arguments",
  rules: []
}
```

### Tool 级规则

```ts
{
  enabled: true,
  defaultTtlSeconds: 60,
  maxTtlSeconds: 1800,
  defaultScope: "exact-arguments",
  rules: [
    {
      match: "deploy.preview",
      ttlSeconds: 120,
      scope: {
        mode: "fields",
        paths: ["project", "environment"]
      }
    },
    {
      match: "dangerous.admin",
      enabled: false
    }
  ]
}
```

当前 V1 的 `match` 是**精确 Tool Name 匹配**，不是 glob / regex。

---

## 开发 Managed Extension

`@dsh-capsule/extension-sdk` 只提供类型和轻量 helper，不复制 Lease、Broker 或 Credential 逻辑。

### 1. 注册 Capability

```ts
import { defineCapability } from "@dsh-capsule/extension-sdk";

function repoResource(args: unknown): string {
  const repo = (args as { repo?: unknown })?.repo;
  if (typeof repo !== "string") throw new Error("repo is required");
  return `repo:${repo}`;
}

const readIssue = defineCapability({
  toolName: "guard_github_read_issue",
  provider: "github",
  action: "issues.read",
  resource: repoResource,
  ttlSeconds: 60,
});

const disposeCapability = ctx.capabilities.register(readIssue);
```

### 2. Tool 执行时提交 Operation

```ts
const args = run.arguments as { repo: string; issue_number: number };

return await ctx.capabilities.execute(run, {
  provider: "github",
  resource: repoResource(args),
  action: "issues.read",
  input: { issue_number: args.issue_number },
});
```

这里的 `resource` 不是“Extension 说了算”。`CapabilityService` 会再次调用注册时的 `resource(args)`，任何 Provider / Action / Resource 不一致都会抛出 `CAPABILITY_MISMATCH`。

完整示例见：

```text
extensions/github-demo/
```

---

## Fail-Closed 错误模型

关键安全失败使用结构化错误码，而不是静默降级：

```text
LEASE_REQUIRED
LEASE_REVOKED
LEASE_EXPIRED
LEASE_TTL_INVALID
LEASE_SCOPE_INVALID
LEASE_POLICY_INVALID
CAPABILITY_DENIED
CAPABILITY_MISMATCH
CAPABILITY_NOT_REGISTERED
PROVIDER_NOT_FOUND
ACTION_NOT_ALLOWED
CREDENTIAL_NOT_CONFIGURED
PROVIDER_TIMEOUT
PROVIDER_ERROR
```

核心原则：

> **无法证明当前 Operation 被授权，就不执行。**

---

## 安全边界与非目标

<p align="center">
  <img src="assets/security-boundary-cn.svg" alt="Security Boundary" width="100%" />
</p>

这是当前项目最重要的边界说明：

### Universal Mode 能承诺什么

- 为原本触发 `ask` 的 Tool 增加短期 Lease；
- Session / Tool / Scope / TTL 绑定；
- 过期、撤销、复用与审计；
- 不覆盖 DSH 原始 `deny`；
- 不修改已有 Tool 代码即可接入。

### Universal Mode **不能**承诺什么

- 不能保证任意第三方插件看不到 Credential；
- 不能阻止插件自己发网络请求；
- 不能把任意第三方代码强制路由到 Broker；
- 不提供进程、容器、VM 或 microVM 级恶意代码隔离。

### Managed Mode 额外提供什么

- Guard SDK 的 Managed Extension 不直接依赖 Credential API；
- Broker 集中执行受控 Provider Operation；
- Provider / Resource / Action 双重校验；
- Provider Action Allowlist；
- per-operation Credential Resolution；
- Provider Error Secret Redaction。

但它仍然是一个**架构级信任边界**，不是 OS 强隔离边界。需要不可信代码隔离时，应组合 DSH 原生 Sandbox 或其他外部隔离机制。

---

## 当前状态

| 能力 | 状态 |
|---|---|
| Universal Lease Gate | ✅ 已实现 |
| Session / Scope / TTL / Revoke | ✅ 已实现 |
| Managed Capability Service | ✅ 已实现 |
| Credential Broker | ✅ 已实现 |
| GitHub `issues.read` / `issues.create` Provider | ✅ 已实现 |
| Secret-safe Audit | ✅ 已实现 |
| Read-only Governance Console | ✅ 已实现 |
| TypeScript Extension SDK | ✅ 已实现 |
| GitHub Managed Extension Demo | ✅ 已实现 |
| Ubuntu / Windows / macOS CI workflow | ✅ 已配置 |
| 真实 DSH/Cordis 类型与 Loader 联调 | 🚧 待完成 |
| 可直接安装的公开 DSH Release Package | 🚧 待完成 |
| Durable Lease Store | 🗺️ Roadmap |
| 更多 Trusted Providers | 🗺️ Roadmap |

DeepSeek Harness 本身也处于 Developer Preview 并快速迭代，因此正式接入时应始终以当前安装版本的 TypeScript 类型为准，而不是把事件签名硬编码为长期兼容承诺。

---

## 仓库结构

```text
.
├── adapter/
│   └── src/
│       ├── index.ts                 # Guard 插件装配入口
│       ├── capability/
│       │   ├── universal-gate.ts    # DSH Tool / Approval / Result Gate
│       │   ├── policy.ts            # TTL / Scope Policy
│       │   ├── scope-resolver.ts    # Universal Scope
│       │   ├── lease-manager.ts     # Lease 生命周期
│       │   ├── lease-store.ts       # MemoryLeaseStore
│       │   └── pending.ts           # callId 并发隔离
│       ├── service/
│       │   └── capability-service.ts
│       ├── broker/
│       │   ├── broker.ts
│       │   ├── registry.ts
│       │   └── providers/github.ts
│       ├── audit/
│       └── console/
├── sdk/typescript/                  # @dsh-capsule/extension-sdk
├── extensions/github-demo/          # Managed Extension 示例
└── .github/workflows/ci.yml         # 三平台 build + test
```

---

## 设计原则

**Preserve DSH semantics.** Guard 只增强 `ask`，不覆盖 `deny`，不重新发明 Approval。

**Short-lived authority.** 权限必须有明确 Session、Scope 与 TTL，而不是永久授权。

**Capabilities over credentials.** Managed Extension 请求业务操作，不直接持有长期 Secret。

**Deterministic scope.** 安全边界来自确定性规则，不让 LLM 猜 Provider / Resource / Action。

**Fail closed.** 身份、Scope、TTL、Provider、Action、Credential 任一无法验证就拒绝执行。

**Secret-safe observability.** Audit 与 Console 只保留治理所需的白名单字段。

**Small trusted core.** Provider 属于可信 Guard Core；Extension SDK 保持薄，不复制核心安全逻辑。

---

## FAQ

### 这和 RBAC 有什么区别？

RBAC 更适合回答“这个角色通常拥有什么权限”。Capability Lease 回答的是：**这个 Session 在当前 TTL 内，是否允许这个 Tool 对这个 Scope 执行当前操作。** 它更适合 Agent 的动态、短时工作流。

### 没有 Docker 以后，Broker 还有意义吗？

有。Broker 的核心价值不是容器通信，而是**减少 Secret 分发、集中 Provider Policy、统一审计与错误脱敏**。不过，没有 OS 隔离时它属于架构约束，不应宣传成恶意代码强隔离。

### Universal Mode 能保护所有第三方插件吗？

它可以零改造地为**原本会触发 DSH `ask`** 的 Tool 增加短期 Lease；但不能强制第三方插件使用 Broker，也不能阻止插件访问其进程本身已经拥有的资源。

### 支持 Windows / macOS / Linux 吗？

当前主链路是纯 TypeScript，没有 Python / Docker / Unix Domain Socket 依赖；仓库 CI 也配置了三平台矩阵。真实 DSH 集成仍需按具体 DSH 版本做兼容性验证。

### 为什么默认 Scope 是 `exact-arguments`？

因为零配置情况下无法可靠猜测某个第三方 Tool 的业务资源语义。默认只复用完全相同的参数，宁可多问一次，也不扩大授权面。

---

## Roadmap

近期优先级：

1. 使用真实 DeepSeek Harness / Cordis package types 完成 Adapter 联调；
2. 补齐可复现的 DSH Loader / Profile 安装示例与版本兼容矩阵；
3. 将 `MemoryLeaseStore` 抽象落到可选持久化实现；
4. 增加更多窄 Action Schema 的 Trusted Provider；
5. 强化 Console 的只读治理与可观测性，但不把它变成权限修改入口；
6. 发布稳定的 Extension SDK 与最小 Managed Extension 模板。

---

## Contributing

安全基础设施最需要的是**负向测试与清晰边界**。欢迎贡献：

- Lease / Scope / Session 隔离测试；
- 并发 `callId`、取消与生命周期 Race 测试；
- Credential 泄漏回归测试；
- 窄 Action Schema 的 Trusted Provider；
- DSH 版本兼容性验证；
- 文档、Demo 与可复现集成样例。

如果一个改动会扩大可信计算面、让 Extension 直接接触 Secret，或试图绕开 DSH 原生 Approval / Sandbox，请先讨论设计再实现。

---

## License

MIT License. See [`LICENSE`](LICENSE).

<p align="center">
  <b>DSH Capsule</b><br/>
  <sub>Short-lived capabilities · Brokered credentials · Fail-closed by design</sub>
</p>
