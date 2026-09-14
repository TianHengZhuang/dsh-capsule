import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AuditDecision } from "../audit/types.js";
import { CONSOLE_HTML } from "./console-html.js";
import type { GovernanceConsole } from "./console-service.js";
import type { ConsoleAuditQuery } from "./types.js";
// 作用：Governance Console 只读 HTTP 查看器（规格第 24 节 Phase 4）——默认绑定 127.0.0.1 的
// loopback 端口，仅响应 GET（HTML 页面 + /api/snapshot + /api/audit），无任何写操作；
// 响应统一 no-store + nosniff + CSP，任何处理异常 Fail Closed 返回 500（细节只写 stderr）。
export interface ConsoleHttpOptions {
  console: GovernanceConsole;
  host?: string;
  port?: number;
}
export interface ConsoleHttpHandle {
  url: string;
  close(): Promise<void>;
}
export const DEFAULT_CONSOLE_HOST = "127.0.0.1";
export const DEFAULT_CONSOLE_PORT = 8787;
const AUDIT_DECISIONS: readonly string[] = ["PASSTHROUGH_ALLOW", "PASSTHROUGH_DENY", "ASK", "LEASE_REUSED", "LEASE_ISSUED", "APPROVAL_REJECTED", "TOOL_SUCCESS", "TOOL_ERROR"];
export function startConsoleServer(options: ConsoleHttpOptions): Promise<ConsoleHttpHandle> {
  // 作用：启动只读 Console 服务器——host/port 配置校验（Fail Closed：port 必须为 [1, 65535] 整数
  // 或 0 表示随机端口）；listen 成功才 resolve（端口占用等启动失败直接 reject）；close 后端口释放
  const govConsole = options.console;
  const host = options.host ?? DEFAULT_CONSOLE_HOST;
  const port = options.port ?? DEFAULT_CONSOLE_PORT;
  if (typeof host !== "string" || host.length === 0) {
    return Promise.reject(new Error("GUARD_CONSOLE_INVALID: host must be a non-empty string"));
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return Promise.reject(new Error("GUARD_CONSOLE_INVALID: port must be an integer in [0, 65535]"));
  }
  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, govConsole);
  });
  return new Promise<ConsoleHttpHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      const displayHost = host.includes(":") ? `[${host}]` : host;
      resolve({
        url: `http://${displayHost}:${actualPort}/`,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
async function handleRequest(req: IncomingMessage, res: ServerResponse, govConsole: GovernanceConsole): Promise<void> {
  // 作用：请求路由——仅 GET：/（HTML 页面）、/api/snapshot（全量快照）、/api/audit（审计过滤查询）；
  // 非 GET 一律 405，未知路径 404，任何异常 Fail Closed 500（不向客户端泄漏内部细节）
  try {
    const url = new URL(req.url ?? "/", "http://console.local");
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      sendHtml(res);
      return;
    }
    if (url.pathname === "/api/snapshot") {
      sendJson(res, 200, await govConsole.snapshot());
      return;
    }
    if (url.pathname === "/api/audit") {
      const query = parseAuditQuery(url.searchParams);
      if (query === undefined) {
        sendJson(res, 400, { error: "INVALID_QUERY" });
        return;
      }
      sendJson(res, 200, govConsole.queryAudit(query));
      return;
    }
    sendJson(res, 404, { error: "NOT_FOUND" });
  } catch (err) {
    process.stderr.write(`[dsh-guard] console request failed: ${String(err)}\n`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "CONSOLE_INTERNAL_ERROR" });
    } else {
      res.end();
    }
  }
}
function parseAuditQuery(params: URLSearchParams): ConsoleAuditQuery | undefined {
  // 作用：解析审计查询参数——sessionId/toolName/decision 精确匹配、limit 正整数；
  // decision 必须为合法枚举、limit 必须为正整数，任何非法值返回 undefined（上层回 400）
  const query: ConsoleAuditQuery = {};
  const sessionId = params.get("sessionId");
  const toolName = params.get("toolName");
  const decision = params.get("decision");
  const limit = params.get("limit");
  if (sessionId) query.sessionId = sessionId;
  if (toolName) query.toolName = toolName;
  if (decision) {
    if (!AUDIT_DECISIONS.includes(decision)) return undefined;
    query.decision = decision as AuditDecision;
  }
  if (limit) {
    const parsed = Number.parseInt(limit, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
    query.limit = parsed;
  }
  return query;
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // 作用：发送 JSON 响应——统一 no-store + nosniff + 严格 CSP（JSON 端点 default-src 'none'）
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(payload);
}
function sendHtml(res: ServerResponse): void {
  // 作用：发送内嵌 Console 页面——CSP 允许内联脚本/样式与同源 fetch，禁其余一切外部资源
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(CONSOLE_HTML);
}
