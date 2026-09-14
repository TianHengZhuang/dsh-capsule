import type { JsonValue } from "../../capability/types.js";
import { GuardError } from "../errors.js";
import type { ProviderAdapter, ProviderExecuteInput } from "../provider.js";
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_ALLOWED_ACTIONS: readonly string[] = ["issues.read", "issues.create"];
const REPO_RESOURCE_PATTERN = /^repo:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
// 作用：GitHub Provider（重构规格第 12 节，语义参考旧 runtime/dsh_capsule/broker/github.py）——
// V2 最小 Action 集：issues.read（GET /repos/{owner}/{repo}/issues/{n}）与 issues.create
//（POST /repos/{owner}/{repo}/issues）；repo 一律从已通过 Lease 校验的语义 resource（repo:owner/repo）
// 解析而不是信任 payload，保证请求目标被 Lease Scope 绑定；Token 只进请求头，
// 绝不进入日志/审计/异常信息/返回值（规格第 18 节）。
export class GitHubProvider implements ProviderAdapter {
  readonly id = "github";
  readonly credentialRef: string;
  readonly allowedActions: readonly string[] = GITHUB_ALLOWED_ACTIONS;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  constructor(options: { apiBase?: string; credentialRef?: string; fetchImpl?: typeof fetch } = {}) {
    // 作用：apiBase/credentialRef 可配置；fetchImpl 仅供测试注入 mock，生产缺省走全局 fetch
    this.apiBase = (options.apiBase ?? GITHUB_API_BASE).replace(/\/+$/, "");
    this.credentialRef = options.credentialRef ?? "github";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async execute(input: ProviderExecuteInput): Promise<JsonValue> {
    // 作用：执行受控 GitHub 请求——先做 credential/resource/action 形状校验（Fail Closed），
    // 再按 action 分派到 readIssue/createIssue；响应只提取白名单字段（规格第 12 节）
    if (typeof input?.credential !== "string" || input.credential.length === 0) {
      throw new GuardError("CREDENTIAL_NOT_CONFIGURED", "github provider requires a resolved credential");
    }
    const repo = parseRepoResource(input.resource);
    if (input.action === "issues.read") return await this.readIssue(input, repo);
    if (input.action === "issues.create") return await this.createIssue(input, repo);
    throw new GuardError("ACTION_NOT_ALLOWED", `github provider does not allow action: ${input.action}`);
  }
  private async readIssue(input: ProviderExecuteInput, repo: { owner: string; name: string }): Promise<JsonValue> {
    // 作用：issues.read——payload 必须是对象且 issue_number 为正整数，GET 单个 issue 后按状态码校验
    const payload = requirePayloadObject(input.payload, "issues.read");
    const issueNumber = payload["issue_number"];
    if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber < 1) {
      throw new GuardError("PROVIDER_ERROR", "github issues.read payload.issue_number must be a positive integer");
    }
    const resp = await this.request(input, `${this.apiBase}/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`, { method: "GET" });
    if (resp.status === 404) throw new GuardError("PROVIDER_ERROR", "github issue not found");
    if (resp.status !== 200) throw new GuardError("PROVIDER_ERROR", `github status ${resp.status}`);
    return extractIssue(await parseJsonBody(resp));
  }
  private async createIssue(input: ProviderExecuteInput, repo: { owner: string; name: string }): Promise<JsonValue> {
    // 作用：issues.create——payload.title 必须非空字符串、body 可选字符串，POST 创建 issue 后按状态码校验
    const payload = requirePayloadObject(input.payload, "issues.create");
    const title = payload["title"];
    if (typeof title !== "string" || title.length === 0) {
      throw new GuardError("PROVIDER_ERROR", "github issues.create payload.title must be a non-empty string");
    }
    const body = payload["body"];
    if (body !== undefined && typeof body !== "string") {
      throw new GuardError("PROVIDER_ERROR", "github issues.create payload.body must be a string when provided");
    }
    const resp = await this.request(input, `${this.apiBase}/repos/${repo.owner}/${repo.name}/issues`, { method: "POST", body: JSON.stringify({ title, body }) });
    if (resp.status === 404) throw new GuardError("PROVIDER_ERROR", "github repo not found");
    if (resp.status !== 201) throw new GuardError("PROVIDER_ERROR", `github status ${resp.status}`);
    return extractIssue(await parseJsonBody(resp));
  }
  private async request(input: ProviderExecuteInput, url: string, init: { method: string; body?: string }): Promise<Response> {
    // 作用：发起受控 GitHub HTTP 请求——Token 仅用于构造 Authorization 头；网络层错误包装为
    // PROVIDER_ERROR（消息不含 Token），AbortError 原样上抛由 CredentialBroker 区分超时/外部中止
    const headers: Record<string, string> = {
      Authorization: `Bearer ${input.credential}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await this.fetchImpl(url, { method: init.method, headers, body: init.body, signal: input.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      throw new GuardError("PROVIDER_ERROR", `github request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
function parseRepoResource(resource: string): { owner: string; name: string } {
  // 作用：从语义 resource 解析 owner/repo——必须严格匹配 repo:owner/repo 字符白名单（阻止 URL
  // 注入与 path traversal），不匹配一律 CAPABILITY_MISMATCH（Fail Closed：请求目标只能来自 Lease Scope）
  const match = REPO_RESOURCE_PATTERN.exec(resource ?? "");
  if (!match) throw new GuardError("CAPABILITY_MISMATCH", "github resource must be repo:owner/repo");
  return { owner: match[1], name: match[2] };
}
function requirePayloadObject(payload: JsonValue, action: string): Record<string, unknown> {
  // 作用：校验 payload 必须是 JSON object——数组/标量/null 一律拒绝（Fail Closed）
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new GuardError("PROVIDER_ERROR", `github ${action} payload must be an object`);
  }
  return payload;
}
async function parseJsonBody(resp: Response): Promise<Record<string, unknown>> {
  // 作用：解析并校验响应体为 JSON object——非法体直接 PROVIDER_ERROR（Fail Closed）
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    throw new GuardError("PROVIDER_ERROR", "invalid github response body");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new GuardError("PROVIDER_ERROR", "invalid github response body");
  }
  return data as Record<string, unknown>;
}
function extractIssue(data: Record<string, unknown>): JsonValue {
  // 作用：白名单提取 issue 业务字段——只返回 number/title/state/author/body/html_url，
  // 类型不符的字段置 null，保证返回值是纯 JSON 且不可能携带 Credential
  const user = data["user"];
  const author = typeof user === "object" && user !== null && !Array.isArray(user) ? (user as Record<string, unknown>)["login"] : undefined;
  return {
    number: typeof data["number"] === "number" ? data["number"] : null,
    title: typeof data["title"] === "string" ? data["title"] : null,
    state: typeof data["state"] === "string" ? data["state"] : null,
    author: typeof author === "string" ? author : null,
    body: typeof data["body"] === "string" ? data["body"] : null,
    html_url: typeof data["html_url"] === "string" ? data["html_url"] : null,
  };
}
