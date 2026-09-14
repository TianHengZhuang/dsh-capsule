// 作用：Broker 域错误（重构规格第 18 节）——统一复用 GuardError 结构化错误码，集中声明
// Broker 允许使用的错误码；用户可见错误不得包含 Credential 值、Authorization Header 或原始 Secret。
export { GuardError } from "../capability/errors.js";
export const BROKER_ERROR_CODES = ["PROVIDER_NOT_FOUND", "ACTION_NOT_ALLOWED", "CREDENTIAL_NOT_CONFIGURED", "PROVIDER_TIMEOUT", "PROVIDER_ERROR"] as const;
export type BrokerErrorCode = (typeof BROKER_ERROR_CODES)[number];
