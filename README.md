<p align="center">
  <h1 align="center">DSH Capsule</h1>
</p>

<p align="center">
  <b>DeepSeek Harness 第三方插件隔离执行与短期授权运行时</b><br/>
  <i>Isolated Plugin Runtime with Revocable Capability Leases for DeepSeek Harness</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.11+-3776AB?style=for-the-badge&logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white" />
</p>

---

## 项目定位

DSH Capsule is an isolated tool-plugin runtime for DeepSeek Harness.

Third-party Capsule code runs outside the Harness process in a restricted Docker container. Capsules do not receive host credentials or direct network access. When a Capsule needs an external capability, the trusted host broker mediates the operation through a short-lived, session-bound, revocable capability lease.

DSH Capsule 是面向 DeepSeek Harness 的隔离式第三方 Tool Plugin Runtime。

第三方 Capsule 代码不会直接运行在 Harness 主进程中，而是在受限 Docker 容器中执行；容器无法读取宿主长期凭据，也默认不能直接访问网络。当插件确实需要访问 GitHub 等外部资源时，由宿主 Broker 在用户授权后签发短期、Session 绑定、可撤销的 Capability Lease，并由 Broker 代为完成外部请求。

## 项目解决的两个核心问题

1. **第三方 Tool Plugin 隔离执行**：插件代码下沉到独立 Docker 容器运行，容器默认无宿主文件、无宿主环境变量、无公网网络、无 Docker Socket、非 root、只读根文件系统，并带 CPU / 内存 / 进程数限制。
2. **无长期凭证暴露的外部能力访问**：插件不直接持有 GitHub 等服务的长期 Token，而是向可信 Broker 提交请求；Broker 校验 Session 绑定的短期 Lease 后，使用宿主保管的凭证代为请求外部 API，并把结果返回给容器。

> 一句话：**插件可以做事，但插件不需要拥有宿主。**

## 架构概览

```text
Agent → DSH Tool Registry → Capsule Adapter (TS, 可信)
       → Python Capsule Runtime (可信)
       → 隔离 Docker Capsule (不可信)
       → Credential/Capability Broker (可信) → External API
```

- **TypeScript Adapter**：只做"贴着 DSH 的部分"——插件生命周期、`ctx.tools.register()`、`ctx.approval`、`ctx.credentials`、stdin/stdout NDJSON RPC 转发。
- **Python Runtime**：承担主要逻辑——Docker 管理、Capsule 生命周期、Lease 服务、Broker、Provider、SQLite 存储、安全检查。
- 两层 IPC：TS ↔ Python 走 `Bidirectional NDJSON JSON-RPC`（stdin/stdout）；Python ↔ 容器走独享的 Unix Domain Socket。

## 信任边界

```text
Trusted:      DSH Core / TS Adapter / Python Runtime / SQLite Lease DB / Provider Adapters
Untrusted:    Capsule Container / Capsule Code / Capsule Dependencies / Capsule Input
Semi-trusted: GitHub API / Docker Engine
```

## 状态

MVP（V0.1~V0.4）按技术规格分 Phase 推进中，遵循规格约定的范围边界：不支持 Windows/macOS 容器、Kubernetes、microVM、eBPF、通用 HTTP Proxy、插件签名等（见技术规格第 5.2 节）。

## 快速开始

> 详见技术规格各 Phase，按要求逐阶段开发与验收，不一次扩大范围。

```text
文档：docs/DSH_Capsule_MVP_Technical_Spec.md（本地保留，不入库）
```

## License

MIT License，详见 [LICENSE](LICENSE)。
