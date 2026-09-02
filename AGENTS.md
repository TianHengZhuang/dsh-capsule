# AGENTS.md

> 本文件是 dsh-capsule 项目的"项目宪法"，所有 AI 编码会话开始前必须通读并遵守。
> 完整技术规格见本地 `docs/DSH_Capsule_MVP_Technical_Spec.md`（不入库，但必须以其为准）。

## 1. 项目一句话定位

DSH Capsule 是面向 DeepSeek Harness 的隔离式第三方 Tool Plugin Runtime：第三方插件代码运行在受限 Docker 容器（不可信侧），宿主侧通过 Session 绑定、短期、可撤销的 Capability Lease + 可信 Broker 代为访问外部 API，使插件永远不接触宿主长期凭证。

## 2. 架构分层（必须遵守，禁止破坏信任边界）

```text
Agent → DSH Tool Registry → Capsule Adapter (TypeScript, 可信, 薄层)
     → Python Capsule Runtime (可信, 核心逻辑)
     → 隔离 Docker Capsule (不可信)
     → Credential/Capability Broker (可信) → External API
```

- TypeScript 只负责"贴着 DSH"的部分：生命周期、ctx.tools.register、ctx.approval、ctx.credentials、NDJSON RPC 转发。**禁止**在 TS 层实现业务逻辑。
- Python Runtime 承载：CapsuleManager、DockerBackend、LeaseService、BrokerServer、ProviderRegistry、SQLite。
- 长期 Secret 只存在于可信侧（TS Adapter / Python Runtime 内存），**永远不得进入容器**。
- 若需绕过本分层（如为兼容任意 Cordis Plugin 而代理整个 Context），视为越界，禁止。

## 3. 技术栈与依赖（MVP 锁定）

- Adapter：TypeScript + 当前 DSH/Cordis 版本 + `@deepseek-ai/dsh-tools`。
- Runtime：Python 3.11+；仅 `pydantic`、`pyyaml`、`docker`、`httpx`、`aiosqlite`。
- 禁止引入：FastAPI、Redis、PostgreSQL、Celery、Kafka（Runtime 是本地 daemon，非 Web SaaS）。
- 依赖管理：Python 用 `pyproject.toml`（uv 可用）；npm 包用 pnpm（仓库根含 `pnpm-workspace.yaml`）。

## 4. 强制实现规则（技术规格第 41 节，逐条遵守）

1. 不修改 DeepSeek Harness Core 源码，以独立 DSH Plugin 接入。
2. TypeScript 只做薄 Adapter，核心 Runtime 用 Python。
3. 目标平台先只支持 Linux + Docker。
4. 不兼容任意现有 Cordis Plugin，只支持 Capsule Tool Plugin。
5. 不实现通用 HTTP Proxy；Container 默认 `network none`。
6. 长期 Secret 永远不能进入 Container。
7. 所有授权检查 **Fail Closed**：任意校验失败即拒绝，禁止"先放过去"。
8. 每条 Lease 必须绑定 `capsule_instance_id + session_id + provider + resource + action + TTL`。
9. Credential 每次 Provider operation 通过 DSH `ctx.credentials` 重新 resolve，不跨 operation 缓存。
10. stdout 若用于 NDJSON RPC，**不得打印普通日志**；Python 日志一律写 stderr。
11. 不记录 Secret 到日志、SQLite、Tool Result、异常信息。
12. 错误必须使用技术规格第 28 节的统一错误码（如 `CAPABILITY_DENIED`、`LEASE_REVOKED`），禁止返回杂乱字符串。
13. 每完成一个 Phase，先补齐测试并运行通过，再进入下一 Phase。
14. MVP 完成前禁止实现：Web UI、插件签名、Sigstore、SBOM、Kubernetes、microVM、eBPF、seccomp 自定义规则生成、Redis、PostgreSQL。
15. DSH API 属性名与规格不一致时，以当前安装版本的官方 TypeScript 类型定义与官方文档为准；**禁止**通过猜测 Session 文件路径绕过。

## 5. Capsule 容器隔离基线（等价 Docker 参数）

```text
--read-only
--network none
--cap-drop ALL
--security-opt no-new-privileges
--memory 256m
--pids-limit 64
--cpus 0.5
--tmpfs /tmp:rw,noexec,nosuid,size=64m
```

- 非 root 运行；不 mount `/home`、DSH workspace、`~/.dsh`、Docker Socket；不用 host network、privileged、host PID namespace；不批量注入宿主环境变量。
- 容器只可见：`/app`、`/tmp`、`/run/capsule/`（当前实例独享 IPC 目录）。禁止所有 Capsule 共用同一可互访目录。

## 6. IPC 约定

- TS ↔ Python：Bidirectional NDJSON JSON-RPC over stdin/stdout。Python 反向调用 TS 用 `host.approval.*`、`host.credential.resolve`。
- Python ↔ 容器：每实例独享 Unix Domain Socket（`plugin.sock` 下发调用 / `broker.sock` 上收 Broker 请求）。
- 资源限制：tool invocation 默认超时 30s，Provider 请求 15s，响应上限 2 MB。

## 7. 目录结构（技术规格第 10 节，新增模块必须归位）

```text
adapter/    TS Adapter（src: index / rpc-client / tool-loader / approval / credentials）
runtime/    Python Runtime（dsh_capsule: main / rpc / capsule / lease / broker / storage / security）
sdk/        python SDK（client / broker / tool）
capsules/   示例 Capsule（github-reader、malicious-demo，各含 capsule.yaml + Dockerfile + app.py）
cli/        capsulectl.py（leases / revoke / revoke-session / revoke-capsule）
tests/      unit / integration / security
```

## 8. 开发纪律

- 只做当前 Phase 范围内的事，禁止"顺手加功能"或超前实现后续 Phase（规格第 40 节 Phase 0→6 顺序）。
- 安全相关代码必须配负向测试（malicious-demo 场景：宿主文件、宿主 env、直接联网、docker.sock、越权 action、过期/撤销 Lease、跨 Session 复用、超大输出、死循环、容器崩溃）。
- 代码注释使用中文，给出方法作用说明；普通代码不随意空行，保持整洁。

## 9. 会话回复规范

- 全程使用中文回复用户。
- 每个任务执行完毕后，向用户说明本次使用了哪些大模型。
