// TODO(Phase 4): 集成 DSH ctx.credentials，在可信侧解析真实凭据，禁止进入容器与日志
export async function resolveCredential(_ref: string): Promise<string> {
  // 作用：预留的凭据解析入口（Phase 4 实现；每次 operation 重新 resolve，不跨 operation 缓存）
  throw new Error("not implemented until Phase 4");
}
