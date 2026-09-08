import type { HostHandler } from "./rpc-client.js";
// 作用：DSH Approval 集成（规格第 33 节）——宿主 one-shot Approval 批准的是"签发一张明确 Scope、明确 TTL 的 Lease"，
// 仅接受 allowed-once，其余结果（rejected/cancelled/unavailable）一律拒绝（Fail Closed）。
export interface LeaseApprovalRequest {
  capsuleId: string;
  provider: string;
  resource: string;
  action: string;
  ttlSeconds: number;
  toolName?: string;
}
export interface DshApprovalService {
  // TODO(Phase 4, 规则 15)：DSH ctx.approval 的确切形状以当前安装版本官方 TypeScript 类型定义与官方文档为准，
  // 本接口仅按技术规格第 33 节声明 request({ agent, toolName, callId, reason })；接入真实 DSH 时需逐字段核对。
  request(req: { agent?: unknown; toolName?: string; callId?: unknown; reason?: string }): Promise<unknown>;
}
export function getApprovalService(ctx: Record<string, unknown>): DshApprovalService | undefined {
  // 作用：从 DSH ctx 上定位 approval 服务；形状不符（无 request 方法）即视为不可用（Fail Closed）
  const approval = ctx["approval"];
  if (typeof approval === "object" && approval !== null && typeof (approval as any).request === "function") {
    return approval as DshApprovalService;
  }
  return undefined;
}
export function createLeaseApprovalHandler(getApproval: () => DshApprovalService | undefined): HostHandler {
  // 作用：生成 host.approval.request_lease 宿主方法——把 Python 的 Lease 签发请求转成 DSH ctx.approval 请求；
  // 仅 allowed-once 放行并回 {"decision":"allowed-once"}，其余任何结果或异常都失败（→ Python 侧 LEASE_REJECTED）
  return async (params: any) => {
    const req = parseLeaseApprovalRequest(params);
    const approval = getApproval();
    if (!approval) throw new Error("LEASE_REJECTED: ctx.approval unavailable");
    const reason = `Capsule ${req.capsuleId} requests ${req.action} on ${req.provider} ${req.resource} for ${req.ttlSeconds}s`;
    const result = await approval.request({ toolName: req.toolName, reason });
    const decision = typeof result === "string" ? result : (result as any)?.decision;
    if (decision !== "allowed-once") throw new Error(`LEASE_REJECTED: decision=${String(decision)}`);
    return { decision: "allowed-once" };
  };
}
function parseLeaseApprovalRequest(params: any): LeaseApprovalRequest {
  // 作用：参数校验（Fail Closed）——必填字段缺失或类型非法直接抛错，绝不"尽量执行"
  if (typeof params !== "object" || params === null) throw new Error("LEASE_REJECTED: invalid params");
  const { capsuleId, provider, resource, action, ttlSeconds } = params;
  for (const [key, value] of Object.entries({ capsuleId, provider, resource, action })) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`LEASE_REJECTED: invalid param ${key}`);
  }
  if (!Number.isInteger(ttlSeconds) || (ttlSeconds as number) <= 0) throw new Error("LEASE_REJECTED: invalid param ttlSeconds");
  const toolName = params["toolName"];
  if (toolName !== undefined && typeof toolName !== "string") throw new Error("LEASE_REJECTED: invalid param toolName");
  return { capsuleId, provider, resource, action, ttlSeconds, toolName };
}
