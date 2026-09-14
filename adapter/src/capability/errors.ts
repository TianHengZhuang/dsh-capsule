// 作用：Guard 统一错误（重构规格第 18 节）——所有关键失败路径携带结构化错误码，
// message 形如 "CODE: detail"，禁止用杂乱字符串替代错误码。
export class GuardError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "GuardError";
    this.code = code;
  }
}
