import { GuardError } from "../capability/errors.js";
import type { JsonValue } from "../capability/types.js";
import { createCredentialResolveHandler, getCredentialService } from "../legacy/credentials.js";
import { createLeaseApprovalHandler, getApprovalService } from "../legacy/approval.js";
import { PythonRuntime, type HostHandler } from "../legacy/rpc-client.js";
import { parseToolSchemas, type CapsuleToolSchema } from "../legacy/tool-loader.js";
// 作用：Optional Isolated Runtime（重构规格第 24 节 Phase 5 / 第 3.3 节 runtime.mode = isolated）——
// 把冻结的 Legacy Python Runtime + Docker Capsule 作为可选后端接回 Guard：仅当用户显式配置
// runtime.mode = "isolated" 时才 spawn Python 子进程（默认 native 纯 TS 路径完全不触碰本模块），
// 为不可信第三方代码提供容器强隔离（read-only / network none / cap-drop ALL / no-new-privileges /
// tmpfs noexec / 非 root，规格第 12 节）。宿主反向方法复用 legacy 冻结实现：approval 仅 allowed-once
// 放行（其余 LEASE_REJECTED）、credential per-operation resolve 且错误不携带 Secret（Fail Closed）。
export const DEFAULT_ISOLATED_INVOKE_TIMEOUT_MS = 30_000;
const RPC_GRACE_MS = 5_000;
// 作用：隔离后端可透传的结构化错误码白名单——规格第 18 节 V1/V2 统一码 + Legacy Python 层
// 自有码（LEASE_REJECTED / LEASE_CAPSULE_MISMATCH / CAPSULE_* / LEASE_STORE_ERROR）；
// legacy rpc-client 丢弃了 error.data.code，故按 Python 侧 "CODE: detail" 消息前缀提取。
const ISOLATED_ERROR_CODES = new Set([
  "LEASE_REQUIRED", "LEASE_EXPIRED", "LEASE_REVOKED", "LEASE_SESSION_MISMATCH", "LEASE_SCOPE_MISMATCH", "LEASE_NOT_FOUND",
  "CAPABILITY_NOT_REGISTERED", "CAPABILITY_MISMATCH", "CAPABILITY_DENIED",
  "PROVIDER_NOT_FOUND", "ACTION_NOT_ALLOWED", "CREDENTIAL_NOT_CONFIGURED", "PROVIDER_TIMEOUT", "PROVIDER_ERROR",
  "LEASE_REJECTED", "LEASE_CAPSULE_MISMATCH", "LEASE_STORE_ERROR",
  "CAPSULE_NOT_FOUND", "CAPSULE_START_FAILED", "CAPSULE_UNAVAILABLE", "CAPSULE_TIMEOUT", "CAPSULE_PROTOCOL_ERROR", "CAPSULE_OUTPUT_TOO_LARGE",
]);
export interface IsolatedRuntimeConfig {
  mode: "isolated";
  /** Python 解释器命令（缺省 DSH_CAPSULE_PYTHON 环境变量 / 平台默认 python|python3） */
  pythonCmd?: string;
  /** Python Runtime 目录（缺省仓库 runtime/，含 dsh_capsule 包） */
  runtimeDir?: string;
  /** 单次 Capsule 工具调用超时（毫秒，默认 30000） */
  invokeTimeoutMs?: number;
}
// 作用：PythonRuntime 最小接口抽象——生产用 legacy PythonRuntime，测试注入 Fake，冻结层零修改。
export interface PythonRuntimeLike {
  registerHostMethod(method: string, handler: HostHandler): void;
  start(): Promise<void>;
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  dispose(): Promise<void>;
}
export interface IsolatedRuntimeDeps extends Omit<IsolatedRuntimeConfig, "mode"> {
  /** DSH 宿主上下文——用于定位 ctx.approval / ctx.credentials（形状不符即 Fail Closed 拒绝） */
  ctx?: Record<string, unknown>;
  /** 测试注入的 Python Runtime 替身；缺省创建真实 legacy PythonRuntime（start 时才 spawn 子进程） */
  runtime?: PythonRuntimeLike;
}
export class IsolatedRuntimeManager {
  private readonly runtime: PythonRuntimeLike;
  private readonly ctx: Record<string, unknown>;
  private readonly invokeTimeoutMs: number;
  private started = false;
  private disposed = false;
  constructor(deps: IsolatedRuntimeDeps) {
    // 作用：组装隔离后端——超时非法即拒绝（Fail Closed，禁止静默 clamp）；复用 legacy 冻结的
    // approval/credential host handler（只读复用，不修改冻结层），真实 PythonRuntime 仅在此处
    // 实例化但 start() 之前绝不 spawn 子进程。
    this.invokeTimeoutMs = deps.invokeTimeoutMs ?? DEFAULT_ISOLATED_INVOKE_TIMEOUT_MS;
    if (!Number.isInteger(this.invokeTimeoutMs) || this.invokeTimeoutMs <= 0) {
      throw new GuardError("ISOLATED_RUNTIME_FAILED", "invokeTimeoutMs must be a positive integer");
    }
    this.ctx = deps.ctx ?? {};
    this.runtime = deps.runtime ?? new PythonRuntime(deps.pythonCmd, deps.runtimeDir);
    this.runtime.registerHostMethod("host.approval.request_lease", createLeaseApprovalHandler(() => getApprovalService(this.ctx)));
    this.runtime.registerHostMethod("host.credential.resolve", createCredentialResolveHandler(() => getCredentialService(this.ctx)));
  }
  async start(): Promise<void> {
    // 作用：启动隔离后端（显式 opt-in 才到达此处）——spawn Python 子进程并完成 system.ping 健康检查；
    // 任何失败（python 缺失 / ping 超时 / 协议异常）先回收半死子进程再抛 ISOLATED_RUNTIME_FAILED
    //（Fail Closed：绝不静默降级回纯 TS 路径，让用户误以为获得了容器隔离保证）。
    if (this.disposed) throw new GuardError("ISOLATED_RUNTIME_FAILED", "isolated runtime already disposed");
    if (this.started) throw new GuardError("ISOLATED_RUNTIME_FAILED", "isolated runtime already started");
    try {
      await this.runtime.start();
    } catch (err) {
      await this.disposeRuntimeQuietly();
      throw new GuardError("ISOLATED_RUNTIME_FAILED", `isolated runtime failed to start: ${errorMessage(err)}`);
    }
    this.started = true;
  }
  async listTools(): Promise<readonly CapsuleToolSchema[]> {
    // 作用：枚举全部 Docker Capsule 暴露的工具 Schema（capsule.list_tools）——复用 legacy
    // parseToolSchemas 做形状校验与内部字段剥离（capsule_id 等不透出给模型）。
    this.assertUsable("capsule.list_tools");
    let result: unknown;
    try {
      result = await this.runtime.call("capsule.list_tools", {}, this.invokeTimeoutMs);
    } catch (err) {
      throw this.wrapCallError("capsule.list_tools", err);
    }
    return parseToolSchemas(result);
  }
  async invoke(tool: string, args: JsonValue | undefined, sessionId: string): Promise<JsonValue> {
    // 作用：在 Docker Capsule 内执行一次工具调用（capsule.invoke）——参数显式校验（Fail Closed）：
    // tool/sessionId 必须非空字符串（Lease 绑定 Session，禁止匿名调用），args 缺省补 {}；
    // 容器内超时按秒下发（Python 侧语义），RPC 层额外留 5s 管道开销余量；返回值原样透传
    //（结果由容器内 SDK 产生，2MB 上限与协议校验由 Python 侧 Fail Closed 把关）。
    this.assertUsable("capsule.invoke");
    if (typeof tool !== "string" || tool.length === 0) {
      throw new GuardError("ISOLATED_RUNTIME_FAILED", "tool must be a non-empty string");
    }
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new GuardError("ISOLATED_RUNTIME_FAILED", "sessionId must be a non-empty string (isolated lease binds session)");
    }
    const params = { tool, args: args ?? {}, timeout: this.invokeTimeoutMs / 1000, sessionId };
    let result: unknown;
    try {
      result = await this.runtime.call("capsule.invoke", params, this.invokeTimeoutMs + RPC_GRACE_MS);
    } catch (err) {
      throw this.wrapCallError(`capsule.invoke ${tool}`, err);
    }
    return result as JsonValue;
  }
  async dispose(): Promise<void> {
    // 作用：销毁隔离后端——优雅终止 Python 子进程（SIGTERM→SIGKILL），Python 退出时自动回收
    // 全部 Docker 容器与 Broker；幂等可重入，dispose 后任何调用一律 Fail Closed。
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    try {
      await this.runtime.dispose();
    } catch (err) {
      throw new GuardError("ISOLATED_RUNTIME_FAILED", `isolated runtime failed to dispose: ${errorMessage(err)}`);
    }
  }
  private assertUsable(operation: string): void {
    // 作用：调用前置状态校验（Fail Closed）——未启动或已销毁一律拒绝，绝不"顺手拉起"
    if (this.disposed) throw new GuardError("ISOLATED_RUNTIME_FAILED", `isolated runtime disposed, ${operation} rejected`);
    if (!this.started) throw new GuardError("ISOLATED_RUNTIME_FAILED", `isolated runtime not started, ${operation} rejected`);
  }
  private wrapCallError(operation: string, err: unknown): GuardError {
    // 作用：把 legacy RPC 错误包装为 Guard 结构化错误——消息前缀命中白名单码（如 LEASE_REQUIRED、
    // CAPSULE_TIMEOUT）即透传该码（保持 Python 侧 Fail Closed 语义），否则统一 ISOLATED_RUNTIME_FAILED
    const message = errorMessage(err);
    const code = extractIsolatedErrorCode(message);
    if (code) return new GuardError(code, `${operation} failed: ${message}`);
    return new GuardError("ISOLATED_RUNTIME_FAILED", `${operation} failed: ${message}`);
  }
  private async disposeRuntimeQuietly(): Promise<void> {
    // 作用：启动失败路径的兜底回收——尽力终止半死子进程，回收自身失败不掩盖原始启动错误
    try {
      await this.runtime.dispose();
    } catch {
      // 回收失败忽略：原始 start 错误优先暴露
    }
  }
}
function errorMessage(err: unknown): string {
  // 作用：统一错误消息提取（Error.message / String 兜底），不含任何 Secret（legacy 层已保证脱敏）
  return err instanceof Error ? err.message : String(err);
}
export function extractIsolatedErrorCode(message: string): string | undefined {
  // 作用：从 legacy rpc-client 的 "rpc error <code>: <GUARD_CODE>: detail" 消息中提取结构化错误码，
  // 仅接受白名单内的码（防字符串巧合伪造），未命中返回 undefined
  const match = /^rpc error -?\d+: ([A-Z][A-Z0-9_]+):/.exec(message);
  const code = match?.[1];
  return code !== undefined && ISOLATED_ERROR_CODES.has(code) ? code : undefined;
}
