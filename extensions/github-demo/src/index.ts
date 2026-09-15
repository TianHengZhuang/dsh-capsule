import { defineCapability, isGuardError, type BrokerOperation, type GuardCapabilities, type GuardErrorLike, type JsonValue, type ToolRunContext } from "@dsh-capsule/extension-sdk";
// 作用：Managed Extension 示例（规格第 13.1 节 github-demo）——注册两个走 Broker 的 GitHub 工具：
// guard_github_read_issue（issues.read）与 guard_github_create_issue（issues.create，TTL 更短）。
// 扩展自身不解析 Credential：tool execute 只把语义 Operation 交给 ctx.capabilities.execute，
// 由 Guard 双重校验 + Lease 验证 + Broker 调用 GitHubProvider；repo 一律从 args 确定性计算，
// 与定义的 resource(args) 同源，保证双重校验（规格 10.5）一致通过。
export const name = "guard-github-demo";
export const inject = ["capabilities"];
// 作用：DSH defineTool 的最小 mock 形状（规格第 34 节校验基线未接入前的占位基线，与 adapter 同标准；
// 规则 4：接入真实 DSH 时以当前安装版本 TypeScript 类型定义为准逐字段核对）
export interface DemoToolDefinition {
  name: string;
  description: string;
  parameters: JsonValue;
  execute(run: ToolRunContext): Promise<JsonValue>;
}
// 作用：DSH 宿主上下文的扩展侧 mock 形状——tools.register 注册 Tool，capabilities 为 Guard 挂载
export interface DemoHostContext {
  tools: { register(tool: DemoToolDefinition): () => void };
  capabilities: GuardCapabilities;
}
const REPO_ARGS_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const readIssueDefinition = defineCapability({ toolName: "guard_github_read_issue", provider: "github", action: "issues.read", resource: repoResourceFromArgs });
const createIssueDefinition = defineCapability({ toolName: "guard_github_create_issue", provider: "github", action: "issues.create", resource: repoResourceFromArgs, ttlSeconds: 300 });
export function apply(ctx: DemoHostContext): () => void {
  // 作用：插件入口——注册两条 managed 能力定义 + 两个 DSH Tool；返回 disposer 注销全部注册。
  // 任何一步 Guard 侧校验失败（defineCapability 抛 SDK_INVALID_CAPABILITY / register 抛
  // CAPABILITY_NOT_REGISTERED）都会在启动期抛出（Fail Closed，不静默降级）；闭包经参数 ctx
  // 访问 capabilities，dispose 后 definition 已注销，再 execute 会抛 CAPABILITY_NOT_REGISTERED
  const disposers: Array<() => void> = [];
  disposers.push(ctx.capabilities.register(readIssueDefinition));
  disposers.push(ctx.capabilities.register(createIssueDefinition));
  disposers.push(ctx.tools.register({
    name: "guard_github_read_issue",
    description: "读取指定仓库的单个 Issue（经 DSH Capability Guard Broker 授权执行）",
    parameters: { type: "object", properties: { repo: { type: "string", description: "owner/repo" }, issue_number: { type: "number" } }, required: ["repo", "issue_number"] },
    execute: async (run) => await executeGuarded(ctx, run, "issues.read", issueReadInput),
  }));
  disposers.push(ctx.tools.register({
    name: "guard_github_create_issue",
    description: "在指定仓库创建 Issue（经 DSH Capability Guard Broker 授权执行，默认 TTL 300s）",
    parameters: { type: "object", properties: { repo: { type: "string", description: "owner/repo" }, title: { type: "string" }, body: { type: "string" } }, required: ["repo", "title"] },
    execute: async (run) => await executeGuarded(ctx, run, "issues.create", issueCreateInput),
  }));
  return () => {
    for (const dispose of disposers) dispose();
  };
}
async function executeGuarded(ctx: DemoHostContext, run: ToolRunContext, action: string, toInput: (args: Record<string, unknown>) => JsonValue): Promise<JsonValue> {
  // 作用：Tool execute 统一走 Guard——resource 与注册定义同源（repoResourceFromArgs），input 由
  // args 白名单映射；Guard 抛出的领域错误（LEASE_REQUIRED 等）原样上抛给 DSH / Agent 呈现
  const operation: BrokerOperation = { provider: "github", resource: repoResourceFromArgs(run.arguments), action, input: toInput(requireArgsObject(run.arguments)) };
  return await ctx.capabilities.execute(run, operation);
}
function requireArgsObject(args: unknown): Record<string, unknown> {
  // 作用：校验 args 必须是 JSON object——非法直接抛错（Fail Closed）
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw Object.assign(new Error("github-demo: tool arguments must be an object"), { code: "PROVIDER_INPUT_INVALID" });
  }
  return args as Record<string, unknown>;
}
function repoResourceFromArgs(args: unknown): string {
  // 作用：从 args.repo 计算语义资源标识 repo:owner/repo——必须严格匹配 owner/repo 白名单
  //（阻止注入），非法抛错时 Guard 会 Fail Closed 保持原 ask、不签发 Lease（规格 10.4）
  const repo = requireArgsObject(args)["repo"];
  if (typeof repo !== "string" || !REPO_ARGS_PATTERN.test(repo)) {
    throw Object.assign(new Error("github-demo: args.repo must be owner/repo"), { code: "PROVIDER_INPUT_INVALID" });
  }
  return `repo:${repo}`;
}
function issueReadInput(args: Record<string, unknown>): JsonValue {
  // 作用：issues.read 的 payload 白名单映射——只透传 issue_number
  return { issue_number: jsonField(args["issue_number"]) };
}
function issueCreateInput(args: Record<string, unknown>): JsonValue {
  // 作用：issues.create 的 payload 白名单映射——只透传 title/body
  return { title: jsonField(args["title"]), body: jsonField(args["body"]) };
}
function jsonField(value: unknown): JsonValue {
  // 作用：把 args 白名单字段窄化为 JSON 值——非 JSON 兼容类型（function/symbol/bigint/undefined）置 null，
  // 字段形状校验由 Provider 端兜底（如 issue_number 必须正整数，非法即 PROVIDER_ERROR Fail Closed）
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return null;
  return value as JsonValue;
}
export function isGuardErrorLike(err: unknown): err is GuardErrorLike {
  // 作用：示例中暴露 SDK 判别器——演示扩展如何按规格第 18 节错误码分支处理 Guard 领域错误
  return isGuardError(err);
}
