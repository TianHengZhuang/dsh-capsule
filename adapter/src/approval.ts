// TODO(Phase 4): 集成 DSH ctx.approval，仅接受 allowed-once，其余结果一律拒绝（Fail Closed）
export interface LeaseApprovalRequest {
  capsuleId: string;
  provider: string;
  resource: string;
  action: string;
  ttlSeconds: number;
}
export async function requestLeaseApproval(_req: LeaseApprovalRequest): Promise<"allowed-once"> {
  // 作用：预留的 Lease 签发授权入口（Phase 4 实现）
  throw new Error("not implemented until Phase 4");
}
