// TODO(Phase 1): 解析 capsule.yaml，聚合 tool schema 供 ctx.tools.register 注册
export interface CapsuleToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export function parseToolSchemas(_manifest: unknown): CapsuleToolSchema[] {
  // 作用：预留的 tool schema 解析入口（Phase 1 实现，配合 CapsuleManager 的 manifest 加载）
  return [];
}
