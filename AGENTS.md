# AGENTS.md

> 本文件是 dsh-capsule 项目的"项目宪法"，所有 AI 编码会话开始前必须通读并遵守。
> 当前有效规格：`docs/DSH_Capability_Guard_基于现有版本重构技术规格.md`（增量重构，以其为准）。
> 旧规格 `docs/DSH_Capsule_MVP_Technical_Spec.md` 仅约束 Legacy Docker Runtime 冻结层，不再约束新主链路。

## 1. 项目一句话定位

DSH Capability Guard 是面向 DeepSeek Harness 的通用 Tool 短期授权 + Managed Extension Broker 插件：任何原本触发 DSH Approval 的已装插件，**零代码改造**即获得短期 Lease、复用、过期、撤销与审计（Universal Mode）；遵循 Guard 标准开发的 Managed Extension 进一步由 Broker 代解析凭证与调用 Provider（Managed Mode）。默认主链路纯 TypeScript，Windows / macOS / Linux 均可运行。

## 2. 架构分层（必须遵守，禁止破坏信任边界）

```text
DeepSeek Harness 原生（Tool Pipeline / Approval / Credentials / Sandbox）
        ↓
DSH Capability Guard（TS 插件，横切）
   ├── Universal Gate：tools/pre-execute(prepend) → 只接管下游 ASK
   │     ├── 有效 Lease 命中 → ALLOW
   │     └── 无 Lease → 保持 ASK（reason 附加 Lease 说明）→ allowed-once → 签发
   ├── LeaseManager（MemoryLeaseStore，接口抽象可换持久化）
   ├── CapabilityService（ctx.capabilities，Managed Extension 用）
   └── Broker（Lease 校验 → ctx.credentials.resolve → Provider → External API）
```

- Legacy 层（旧 Python Runtime + Docker Capsule + UDS）：保留不删除，但**不得进入默认启动链**，作为未来 `runtime.mode = isolated` 可选后端。
- V1/V2 默认路径禁止：spawn Python、依赖 Docker、使用 Unix Domain Socket。
- Provider 是 Trusted Code，由 Guard Core 内置/审核；Managed Extension **不得**注册可获得 Secret 的 Provider。
- Managed Extension 通过 `ctx.capabilities.execute(run, operation)` 拿业务结果；项目标准禁止 Extension `inject credentials` 直接 `ctx.credentials.resolve`。

## 3. 与 DSH 原生机制的职责边界（不得越权）

- **不替代 Approval**：只增强——用户 `allowed-once` 后签发明确 Scope + TTL 的短期 Lease；`approval policy=never` 不得绕过。
- **不重定义权限体系**：只处理下游已返回 `kind === 'ask'` 的调用；原 `deny` 永远保持 deny，Lease 不得覆盖；Guard ALLOW 后 monotonic guard（`ctx.tools.guard()`）仍可 Deny，不得绕过。
- **不自存 Secret**：Broker 只能 `ctx.credentials.resolve(ref)`，每次 Provider operation 重新 resolve，禁止跨 operation 缓存。

## 4. 技术栈与依赖

- 新主链路：TypeScript + 当前 DSH/Cordis 版本（Service / events / waterfall 中间件）。
- 新增 SDK：`sdk/typescript/`（`@dsh-capsule/extension-sdk`，第一版只有类型与 helper；禁止在 SDK 复制 Lease/Broker/Credential 逻辑——这些只存在于 Guard Core）。
- Legacy 层依赖冻结现状：Python 3.11+（pydantic / pyyaml / docker / httpx / aiosqlite）。
- 依赖管理：pnpm workspaces；Python 用 uv（`pyproject.toml`）。
- V1 默认路径禁止依赖：docker、python、unix socket、chmod、UID/GID、`/run/*`、Linux capability。

## 5. 强制实现规则（重构规格 MUST/MUST NOT 逐条遵守）

1. 基于现有仓库增量重构，禁止另起炉灶；动手前先跑现有 TypeScript 测试确认基线。
2. 不得删除 `runtime/`、`capsules/`、`sdk/python/`、`cli/`（Legacy 冻结保留）。
3. 不修改 DSH Core 源码，以独立 DSH Plugin 接入。
4. DSH API（`tools/pre-execute`、`approval/request`、`tools/result`、Cordis Service、`ctx.credentials`）以当前安装版本 TypeScript 类型定义为准，禁止凭猜测硬编码（规格第 34 节校验基线，2026-09-14）。
5. Universal V1 默认路径不得 spawn Python、不得依赖 Docker。
6. Lease 必须绑定 Session，一律取 `exec.agent.id`；agent 缺失则禁止创建 Lease（不得发明 global / anonymous lease），保持原始 ask/deny 语义。
7. 默认 Universal Scope 必须是 exact-arguments（toolName + canonical JSON 的 SHA-256）；`tool` 宽 scope 只允许用户显式配置，禁止作为默认值。
8. 禁止用 LLM 或字符串启发式猜测 Tool 的 Provider/Resource/Action；Tool Name 字符串猜测不得当作安全边界。
9. Lease 复用不能覆盖原始 DENY；只有下游 `ask` 才进入 Guard。
10. Approval reason 必须明确告知"批准将签发 Scope=xxx、TTL=xx 秒的短期 Lease"；只有 `allowed-once` 才签发，禁止把 allowed-once 静默扩展成 Lease。
11. 并行调用必须通过 callId（PendingExecution Map）隔离上下文；禁止 global `currentSession/currentTool`。
12. 过期采用 find/validate 时实时比较 `Date.now()`，禁止依赖 setInterval 作为安全正确性前提（低频 GC 只做内存回收）。
13. 所有关键失败路径 Fail Closed：Scope Resolver 抛错、TTL 非法、Lease 状态不合法、Provider/Resource/Action 不一致等一律拒绝或不签发。
14. Credential 不得写入日志、Lease、Audit、Tool Result、异常信息；每次 Provider operation 重新 resolve，禁止缓存。
15. 错误统一使用规格第 18 节错误码（`LEASE_REQUIRED` / `CAPABILITY_MISMATCH` / `CREDENTIAL_NOT_CONFIGURED` 等），禁止杂乱字符串。
16. 每完成一个 Phase，先补齐规格要求的测试并全部通过，再进入下一 Phase；禁止为通过测试删除安全断言。
17. V1 禁止顺手实现 Dashboard/Web UI（Phase 4 才做）；禁止在同一 Phase 大规模 Rename 仓库（项目名暂保 dsh-capsule，新模块内部命名用 Capability Guard / LeaseManager / Managed Extension）。

## 6. 实现阶段顺序（重构规格第 24 节，禁止跳序或超前）

1. **Phase 0**：冻结旧 Docker Runtime——旧 TS 文件（rpc-client / approval / credentials / tool-loader）移入 `adapter/src/legacy/`，默认启动不 spawn Python，旧测试保持可独立运行。
2. **Phase 1**：Universal Short-lived Authorization——types / canonical / scope-resolver / policy / MemoryLeaseStore / LeaseManager / PendingExecution + `tools/pre-execute`、`approval/request`、`tools/result` 三个 hook + audit。
3. **Phase 2**：Managed Capability Service（`ctx.capabilities` register / execute / 语义 Scope）。
4. **Phase 3**：Credential Broker（ProviderRegistry + GitHubProvider + per-operation resolve + 双重校验）。
5. **Phase 4**：Governance Console / Observability。
6. **Phase 5**：Optional Isolated Runtime（接回旧 Python/Docker 作为可选后端）。

第一轮实现只做 Phase 0 + Phase 1（规格第 32 节），验收通过后再交下一轮。

## 7. 目录结构（新增模块必须归位）

```text
adapter/src/
├── index.ts                 # Guard Plugin 入口（不再 spawn Python）
├── capability/              # types / canonical / scope-resolver / policy / lease-store / lease-manager / pending / universal-gate
├── service/                 # capability-service.ts（ctx.capabilities）
├── broker/                  # errors / provider / registry / broker / providers/github.ts
├── audit/                   # types / audit-service
└── legacy/                  # 旧 rpc-client / approval / credentials / tool-loader（冻结）
sdk/typescript/              # @dsh-capsule/extension-sdk
extensions/github-demo/      # Managed Extension 示例
runtime/ capsules/ sdk/python/ cli/   # Legacy 冻结，不删除
```

## 8. 安全声明边界（README / 注释不得混淆）

- Universal Mode 可声明：短期授权、Session/Scope 绑定、TTL、撤销、审计、零改造集成；**不得**声明"第三方插件看不到 Credential / 无法绕过 Broker / 网络被隔离"。
- Managed Broker Mode 可声明：按 Guard SDK 编写的 Tool 不直接解析 Credential、Broker 统一执行 Provider Operation；它是 Architectural Contract，不是 OS 强隔离边界，文档必须如实说明。
- 需要恶意代码强隔离保证时启用 Legacy Container Runtime（Phase 5）。

## 9. 测试与跨平台

- 新 TS 测试位于 `adapter/src/capability/*.test.ts`，必须覆盖规格第 22 节 V1 清单（原 allow/deny 不受影响、deny 不可被 Lease 覆盖、Lease 复用、Session/Scope 隔离、TTL、revoke、并行 callId 隔离、取消清理、canonical JSON 哈希稳定）与第 23 节 V2 清单（15 项）。
- CI 必须在 ubuntu / windows / macos 三平台跑 build + test；旧 Docker 测试只在 Linux optional job。
- 安全相关代码必须配负向测试（rejected / cancelled / unavailable 不签发、mismatch 拒绝、Secret 不入日志）。

## 10. 开发纪律

- 只做当前 Phase 范围内的事，禁止"顺手加功能"或超前实现。
- 代码注释使用中文，给出方法作用说明；普通代码不随意空行，保持整洁。

## 11. 会话回复规范

- 全程使用中文回复用户。
- 每个任务执行完毕后，向用户说明本次使用了哪些大模型。
