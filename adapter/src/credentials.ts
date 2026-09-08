import type { HostHandler } from "./rpc-client.js";
// 作用：DSH Credentials 集成（规格第 23/33 节）——真实 Secret 只在可信侧解析后经 RPC 返回 Python Runtime，
// 禁止打印、记录或写入任何持久化介质；Python 侧每次 operation 重新 resolve，不跨 operation 缓存。
export interface DshCredentialService {
  // TODO(Phase 4, 规则 15)：DSH ctx.credentials 的确切形状以当前安装版本官方 TypeScript 类型定义与官方文档为准，
  // 本接口仅按技术规格第 33 节声明 resolve(ref)；接入真实 DSH 时需核对其返回值结构。
  resolve(ref: string): Promise<unknown>;
}
export function getCredentialService(ctx: Record<string, unknown>): DshCredentialService | undefined {
  // 作用：从 DSH ctx 上定位 credentials 服务；形状不符（无 resolve 方法）即视为不可用（Fail Closed）
  const credentials = ctx["credentials"];
  if (typeof credentials === "object" && credentials !== null && typeof (credentials as any).resolve === "function") {
    return credentials as DshCredentialService;
  }
  return undefined;
}
export function createCredentialResolveHandler(getCredentials: () => DshCredentialService | undefined): HostHandler {
  // 作用：生成 host.credential.resolve 宿主方法——在可信侧调用 ctx.credentials 解析真实凭据并仅回传 {"value"}；
  // 任何失败路径的错误信息只包含 ref 名，绝不包含 Secret 值
  return async (params: any) => {
    const ref = parseCredentialRef(params);
    const credentials = getCredentials();
    if (!credentials) throw new Error("CREDENTIAL_NOT_CONFIGURED: ctx.credentials unavailable");
    const resolved = await credentials.resolve(ref);
    const value = typeof resolved === "string" ? resolved : typeof resolved === "object" && resolved !== null ? (resolved as any)["value"] : undefined;
    if (typeof value !== "string" || value.length === 0) throw new Error(`CREDENTIAL_NOT_CONFIGURED: cannot resolve ${ref}`);
    return { value };
  };
}
function parseCredentialRef(params: any): string {
  // 作用：参数校验（Fail Closed）——ref 必须是非空字符串
  if (typeof params !== "object" || params === null || typeof params["ref"] !== "string" || params["ref"].length === 0) {
    throw new Error("CREDENTIAL_NOT_CONFIGURED: invalid params");
  }
  return params["ref"];
}
