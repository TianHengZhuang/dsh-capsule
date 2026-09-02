import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import * as path from "node:path";
export type HostHandler = (params: any) => any;
type PendingEntry = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
// 作用：管理 Python Capsule Runtime 子进程的完整生命周期与双向 NDJSON JSON-RPC 通信
export class PythonRuntime {
  private proc: ChildProcess | null = null;
  private pending = new Map<string, PendingEntry>();
  private hostHandlers = new Map<string, HostHandler>();
  private idSeq = 0;
  constructor(
    private readonly pythonCmd: string = process.env.DSH_CAPSULE_PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
    private readonly runtimeDir: string = path.resolve(__dirname, "../../runtime"),
  ) {}
  registerHostMethod(method: string, handler: HostHandler): void {
    // 作用：注册宿主侧反向调用方法，供 Python 通过 host.* 请求（如 host.credential.resolve，Phase 4 启用）
    this.hostHandlers.set(method, handler);
  }
  async start(): Promise<void> {
    // 作用：spawn Python Runtime 子进程，绑定流解析与 stderr 日志转发，并用 system.ping 完成健康检查
    if (this.proc) throw new Error("python runtime already started");
    const proc = spawn(this.pythonCmd, ["-m", "dsh_capsule.main"], { cwd: this.runtimeDir, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.on("exit", () => this.failAllPending(new Error("python runtime exited unexpectedly")));
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (chunk: string) => process.stderr.write(`[capsule-runtime] ${chunk}`));
    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on("line", (line) => void this.handleLine(line));
    await this.call("system.ping");
  }
  async call(method: string, params: any = {}, timeoutMs: number = 30_000): Promise<any> {
    // 作用：向 Python Runtime 主动发起 JSON-RPC 请求并等待响应，超时即失败
    const proc = this.proc;
    if (!proc) throw new Error("python runtime not started");
    const id = `ts-${++this.idSeq}`;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  async dispose(): Promise<void> {
    // 作用：优雅终止 Python 子进程：先 SIGTERM，5 秒未退出升级为 SIGKILL，并使所有未完成请求失败
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    await new Promise<void>((resolve) => {
      const killer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
      proc.once("exit", () => {
        clearTimeout(killer);
        resolve();
      });
      proc.kill("SIGTERM");
    });
    this.failAllPending(new Error("python runtime disposed"));
  }
  private async handleLine(line: string): Promise<void> {
    // 作用：分发单行 NDJSON 消息：请求交给已注册 host handler，响应对回 pending Promise
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method) {
      let result: any = null;
      let error: { code: number; message: string } | null = null;
      const handler = this.hostHandlers.get(msg.method);
      if (!handler) {
        error = { code: -32601, message: `method not found: ${msg.method}` };
      } else {
        try {
          result = await handler(msg.params ?? {});
        } catch (err: any) {
          error = { code: -32603, message: String(err?.message ?? err) };
        }
      }
      if (msg.id !== undefined) {
        this.send(error ? { jsonrpc: "2.0", id: msg.id, error } : { jsonrpc: "2.0", id: msg.id, result: result ?? null });
      }
      return;
    }
    const entry = this.pending.get(String(msg.id));
    if (!entry) return;
    this.pending.delete(String(msg.id));
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(`rpc error ${msg.error.code}: ${msg.error.message}`));
    } else {
      entry.resolve(msg.result);
    }
  }
  private send(msg: any): void {
    // 作用：序列化为单行 NDJSON 写入 Python 子进程 stdin
    this.proc?.stdin?.write(JSON.stringify(msg) + "\n");
  }
  private failAllPending(err: Error): void {
    // 作用：进程退出或 dispose 时使所有未完成请求立即失败，不允许悬挂
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
