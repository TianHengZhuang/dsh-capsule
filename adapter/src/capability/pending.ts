import type { PendingExecution } from "./types.js";
// 作用：PendingExecution 注册表（重构规格第 6.1/6.5 节）——按 callId 关联每个进行中的 Tool 调用，
// 天然 request-scoped，支持并行调用互不串上下文（禁止 global currentSession/currentTool）；
// 同时管理 AbortSignal 监听与超龄兜底 GC，异常中断的 callId 不会永久留在内存。
export const MAX_PENDING_AGE_MS = 10 * 60 * 1000;
export class PendingRegistry {
  private entries = new Map<string, PendingExecution>();
  private abortCleanups = new Map<string, () => void>();
  set(entry: PendingExecution, signal?: AbortSignal): void {
    // 作用：登记一条 pending（同 callId 覆盖旧记录）——若携带 AbortSignal 则监听 abort 并在触发时清理
    this.delete(entry.callId);
    this.entries.set(entry.callId, entry);
    if (signal) {
      const onAbort = () => this.delete(entry.callId);
      signal.addEventListener("abort", onAbort, { once: true });
      this.abortCleanups.set(entry.callId, () => signal.removeEventListener("abort", onAbort));
    }
  }
  get(callId: string): PendingExecution | undefined {
    return this.entries.get(callId);
  }
  delete(callId: string): void {
    // 作用：清理一条 pending——同时移除对应的 abort 监听，防止 listener 泄漏
    this.abortCleanups.get(callId)?.();
    this.abortCleanups.delete(callId);
    this.entries.delete(callId);
  }
  size(): number {
    return this.entries.size;
  }
  gc(now: number = Date.now(), maxAgeMs: number = MAX_PENDING_AGE_MS): number {
    // 作用：兜底 GC（规格 6.5 MAX_PENDING_AGE_MS=10min）——清理异常中断（无 tools/result 且未 abort）的 pending
    let removed = 0;
    for (const entry of this.entries.values()) {
      if (entry.startedAt + maxAgeMs <= now) {
        this.delete(entry.callId);
        removed += 1;
      }
    }
    return removed;
  }
  clear(): void {
    // 作用：dispose 时全量清空
    for (const callId of [...this.entries.keys()]) this.delete(callId);
  }
}
