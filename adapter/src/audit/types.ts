// 作用：审计事件类型（重构规格第 9 节）——类型层面即禁止记录完整 Tool Arguments、
// Credential、Authorization Header、Token、Cookie、Password；Args 只允许 scope hash + 脱敏 display。
export type AuditDecision =
  | "PASSTHROUGH_ALLOW"
  | "PASSTHROUGH_DENY"
  | "ASK"
  | "LEASE_REUSED"
  | "LEASE_ISSUED"
  | "APPROVAL_REJECTED"
  | "TOOL_SUCCESS"
  | "TOOL_ERROR";
export interface ToolAuditEvent {
  id: string;
  timestamp: number;
  sessionId?: string;
  callId: string;
  rootCallId: string;
  toolName: string;
  scopeKey?: string;
  scopeDisplay?: string;
  leaseId?: string;
  decision: AuditDecision;
}
