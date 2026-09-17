import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { AuditService } from "../audit/audit-service.js";
import { GuardError } from "../capability/errors.js";
import { LeaseManager } from "../capability/lease-manager.js";
import { MemoryLeaseStore } from "../capability/lease-store.js";
import { PendingRegistry } from "../capability/pending.js";
import { DEFAULT_UNIVERSAL_POLICY, PolicyResolver } from "../capability/policy.js";
import { ScopeResolver } from "../capability/scope-resolver.js";
import type { BrokerOperation, JsonValue, ManagedCapabilityDefinition, ToolRunContext } from "../capability/types.js";
import { UniversalGate } from "../capability/universal-gate.js";
import { CapabilityService } from "../service/capability-service.js";
import { CredentialBroker, findCredentialService, type CredentialServiceLike } from "./broker.js";
import type { ProviderAdapter, ProviderExecuteInput } from "./provider.js";
import { GitHubProvider } from "./providers/github.js";
import { ProviderRegistry } from "./registry.js";
class FakeCredentialService implements CredentialServiceLike {
  // 作用：可控假 credentials 服务——记录每次 resolve 的 ref，验证 per-operation 重新 resolve（规格 23.12）
  readonly resolveCalls: string[] = [];
  constructor(private readonly value: unknown, private readonly fail = false) {}
  async resolve(ref: string): Promise<unknown> {
    this.resolveCalls.push(ref);
    if (this.fail) throw new Error(`resolve failed for ${ref}`);
    return this.value;
  }
}
const echoProvider: ProviderAdapter = {
  id: "echo",
  credentialRef: "echo",
  allowedActions: ["echo.run"],
  execute: async (input) => ({ resource: input.resource, credentialSeen: input.credential.length > 0 }),
};
function makeEchoRegistry(overrides: Partial<ProviderAdapter> = {}): ProviderRegistry {
  // 作用：构造含 echo Provider 的注册表——允许覆盖 execute 以模拟异常/挂起等场景
  const provider = { ...echoProvider, ...overrides } as ProviderAdapter;
  const registry = new ProviderRegistry();
  registry.register(provider);
  return registry;
}
function operationOf(args: { provider?: string; resource?: string; action?: string; input?: unknown } = {}): BrokerOperation {
  // 作用：构造 Broker Operation（缺省与 echo Provider 对齐）
  return {
    provider: args.provider ?? "echo",
    resource: args.resource ?? "repo:a/b",
    action: args.action ?? "echo.run",
    input: (args.input ?? { x: 1 }) as BrokerOperation["input"],
  };
}
async function expectGuardError(promise: Promise<unknown>, code: string) {
  // 作用：断言 promise 以指定错误码的 GuardError 拒绝（Fail Closed 验证）
  await expect(promise).rejects.toMatchObject({ name: "GuardError", code });
}
async function catchGuardError(promise: Promise<unknown>): Promise<GuardError> {
  // 作用：执行 promise 并断言其以 GuardError 拒绝，返回该错误供消息级断言
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(GuardError);
  return caught as GuardError;
}
describe("ProviderRegistry（规格 11/11.2）", () => {
  it("注册后可 get 命中/list 列出，未注册返回 undefined", () => {
    const registry = new ProviderRegistry();
    registry.register(echoProvider);
    expect(registry.get("echo")).toBe(echoProvider);
    expect(registry.get("gitlab")).toBeUndefined();
    expect(registry.list()).toEqual([echoProvider]);
  });
  it("同名重复注册：PROVIDER_ERROR（Fail Closed）", () => {
    const registry = new ProviderRegistry();
    registry.register(echoProvider);
    try {
      registry.register({ ...echoProvider, credentialRef: "echo-2" });
      expect.unreachable("expected GuardError");
    } catch (err) {
      expect(err).toMatchObject({ name: "GuardError", code: "PROVIDER_ERROR" });
    }
  });
  it("Provider 形状非法：PROVIDER_ERROR（Fail Closed）", () => {
    const registry = new ProviderRegistry();
    const invalid: unknown[] = [
      { ...echoProvider, id: "" },
      { ...echoProvider, credentialRef: "" },
      { ...echoProvider, allowedActions: [] },
      { ...echoProvider, allowedActions: ["ok", ""] },
      { ...echoProvider, execute: undefined },
    ];
    for (const provider of invalid) {
      try {
        registry.register(provider as ProviderAdapter);
        expect.unreachable("expected GuardError");
      } catch (err) {
        expect(err).toMatchObject({ name: "GuardError", code: "PROVIDER_ERROR" });
      }
    }
  });
});
describe("findCredentialService（规格 3.2/11.3；2026-09-14 修正为经 ctx.get 解析服务）", () => {
  it("服务缺失 / 形状不符返回 undefined（Fail Closed），含 resolve 函数的服务原样返回", () => {
    expect(findCredentialService({})).toBeUndefined();
    // ctx.get 返回 undefined（服务未注册）或非服务对象
    expect(findCredentialService({ get: () => undefined })).toBeUndefined();
    expect(findCredentialService({ get: () => null })).toBeUndefined();
    expect(findCredentialService({ get: () => ({ resolve: "not-a-function" }) })).toBeUndefined();
    // ctx.get 本身抛错：同样按不可用处理，不向外抛（避免打断执行链）
    expect(
      findCredentialService({
        get: () => {
          throw new Error("cannot get property");
        },
      }),
    ).toBeUndefined();
    const service = new FakeCredentialService("tok");
    expect(findCredentialService({ get: () => service })).toBe(service);
  });
  it("属性访问不再是解析路径：只有在 ctx 上直挂 credentials 而没有 get 时不再被识别", () => {
    // 这是刻意的行为变化——cordis 中未经 inject 的服务属性访问会抛错，
    // 因此 Guard 一律经 ctx.get 解析；旧的最小形状探测在真实 cordis 下会抛错。
    const service = new FakeCredentialService("tok");
    expect(findCredentialService({ credentials: service })).toBeUndefined();
  });
});
describe("CredentialBroker enforcement（规格 11.3/19 Broker Mode/23.9-23.15）", () => {
  it("Provider 未注册：PROVIDER_NOT_FOUND", async () => {
    const broker = new CredentialBroker({ registry: new ProviderRegistry(), getCredentials: () => new FakeCredentialService("tok") });
    await expectGuardError(broker.execute(operationOf({ provider: "missing" })), "PROVIDER_NOT_FOUND");
  });
  it("action 不在 Provider 白名单：ACTION_NOT_ALLOWED", async () => {
    const broker = new CredentialBroker({ registry: makeEchoRegistry(), getCredentials: () => new FakeCredentialService("tok") });
    await expectGuardError(broker.execute(operationOf({ action: "echo.other" })), "ACTION_NOT_ALLOWED");
  });
  it("operation 字段非法：对应错误码（Fail Closed）", async () => {
    const broker = new CredentialBroker({ registry: makeEchoRegistry(), getCredentials: () => new FakeCredentialService("tok") });
    await expectGuardError(broker.execute(operationOf({ provider: "" })), "PROVIDER_NOT_FOUND");
    await expectGuardError(broker.execute(operationOf({ action: "" })), "ACTION_NOT_ALLOWED");
    await expectGuardError(broker.execute(operationOf({ resource: "" })), "CAPABILITY_MISMATCH");
  });
  it("credentials 服务不可用：CREDENTIAL_NOT_CONFIGURED", async () => {
    const broker = new CredentialBroker({ registry: makeEchoRegistry(), getCredentials: () => undefined });
    await expectGuardError(broker.execute(operationOf()), "CREDENTIAL_NOT_CONFIGURED");
  });
  it("resolve 结果不可用（undefined/空串/非字符串 value）：CREDENTIAL_NOT_CONFIGURED，消息只含 ref 名", async () => {
    for (const value of [undefined, "", { value: 123 }, null]) {
      const broker = new CredentialBroker({ registry: makeEchoRegistry(), getCredentials: () => new FakeCredentialService(value) });
      await expectGuardError(broker.execute(operationOf()), "CREDENTIAL_NOT_CONFIGURED");
    }
    const broker = new CredentialBroker({ registry: makeEchoRegistry(), getCredentials: () => new FakeCredentialService({ secret: "leak-me" }) });
    const guard = await catchGuardError(broker.execute(operationOf()));
    expect(guard.message).toContain("echo");
    expect(guard.message).not.toContain("leak-me");
  });
  it("resolve 抛错：CREDENTIAL_NOT_CONFIGURED（Fail Closed，不透传底层异常消息）", async () => {
    const broker = new CredentialBroker({ registry: makeEchoRegistry(), getCredentials: () => new FakeCredentialService("tok", true) });
    await expectGuardError(broker.execute(operationOf()), "CREDENTIAL_NOT_CONFIGURED");
  });
  it("执行成功：Provider 收到 resolve 出的 credential，返回 Provider 结果（规格 23.10）", async () => {
    const credentials = new FakeCredentialService("tok-echo");
    const broker = new CredentialBroker({ registry: makeEchoRegistry(), getCredentials: () => credentials });
    const out = await broker.execute(operationOf({ input: { x: 2 } }));
    expect(out).toEqual({ resource: "repo:a/b", credentialSeen: true });
    expect(credentials.resolveCalls).toEqual(["echo"]);
  });
  it("每个 operation 重新 resolve：两次 execute 触发两次 resolve，无跨 operation 缓存（规格 23.12）", async () => {
    const credentials = new FakeCredentialService({ value: "tok-echo" });
    const broker = new CredentialBroker({ registry: makeEchoRegistry(), getCredentials: () => credentials });
    await broker.execute(operationOf());
    await broker.execute(operationOf());
    expect(credentials.resolveCalls).toEqual(["echo", "echo"]);
  });
  it("Provider 超时：PROVIDER_TIMEOUT（规格 23.11）", async () => {
    const registry = makeEchoRegistry({
      execute: (input: ProviderExecuteInput) =>
        new Promise<JsonValue>((_, reject) => {
          if (input.signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          input.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const broker = new CredentialBroker({ registry, getCredentials: () => new FakeCredentialService("tok"), timeoutMs: 20 });
    await expectGuardError(broker.execute(operationOf()), "PROVIDER_TIMEOUT");
  });
  it("调用方 signal 中止：PROVIDER_ERROR（aborted by caller）", async () => {
    const registry = makeEchoRegistry({
      execute: (input: ProviderExecuteInput) =>
        new Promise<JsonValue>((_, reject) => {
          if (input.signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          input.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const broker = new CredentialBroker({ registry, getCredentials: () => new FakeCredentialService("tok"), timeoutMs: 5_000 });
    const controller = new AbortController();
    const promise = broker.execute(operationOf(), controller.signal);
    controller.abort();
    await expectGuardError(promise, "PROVIDER_ERROR");
  });
  it("Provider 异常消息泄漏 Credential 时出口脱敏为 ***（规格 18/23.13）", async () => {
    const secret = "ghp_leaky_secret";
    const registry = makeEchoRegistry({ execute: async (input) => { throw new Error(`boom token=${input.credential}`); } });
    const broker = new CredentialBroker({ registry, getCredentials: () => new FakeCredentialService(secret) });
    const guard = await catchGuardError(broker.execute(operationOf()));
    expect(guard.code).toBe("PROVIDER_ERROR");
    expect(guard.message).toContain("***");
    expect(guard.message).not.toContain(secret);
  });
  it("Provider 抛 GuardError：保留原错误码且 detail 脱敏后重建", async () => {
    const secret = "ghp_guard_secret";
    const registry = makeEchoRegistry({ execute: async (input) => { throw new GuardError("PROVIDER_ERROR", `failed with ${input.credential}`); } });
    const broker = new CredentialBroker({ registry, getCredentials: () => new FakeCredentialService(secret) });
    const guard = await catchGuardError(broker.execute(operationOf()));
    expect(guard.code).toBe("PROVIDER_ERROR");
    expect(guard.message).toBe("PROVIDER_ERROR: failed with ***");
    expect(guard.message).not.toContain(secret);
  });
  it("并行不同 Resource 的 Broker Call 不串上下文（规格 23.15）", async () => {
    const seen: { resource: string; credential: string }[] = [];
    const registry = new ProviderRegistry();
    registry.register({
      id: "multi",
      credentialRef: "multi",
      allowedActions: ["run"],
      execute: async (input) => {
        seen.push({ resource: input.resource, credential: input.credential });
        await new Promise((resolve) => setTimeout(resolve, input.resource === "repo:a" ? 10 : 1));
        return { resource: input.resource };
      },
    });
    const credentials = new FakeCredentialService({ value: "tok-multi" });
    const broker = new CredentialBroker({ registry, getCredentials: () => credentials, timeoutMs: 5_000 });
    const [first, second] = await Promise.all([
      broker.execute(operationOf({ provider: "multi", action: "run", resource: "repo:a" })),
      broker.execute(operationOf({ provider: "multi", action: "run", resource: "repo:b" })),
    ]);
    expect(first).toEqual({ resource: "repo:a" });
    expect(second).toEqual({ resource: "repo:b" });
    expect(seen).toEqual([
      { resource: "repo:a", credential: "tok-multi" },
      { resource: "repo:b", credential: "tok-multi" },
    ]);
    expect(credentials.resolveCalls).toEqual(["multi", "multi"]);
  });
});
describe("GitHubProvider（规格 12）", () => {
  const token = "ghp_provider_test";
  const baseInput = { credential: token, resource: "repo:owner/name", payload: { issue_number: 7 } as JsonValue, signal: new AbortController().signal };
  function makeFetch(body: unknown, status = 200) {
    // 作用：构造记录调用的 mock fetch——返回指定状态码与 JSON body 的 Response
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status });
    };
    return { calls, fetchImpl };
  }
  it("issues.read 成功：GET 单个 issue，Token 只进请求头，返回白名单字段", async () => {
    const { calls, fetchImpl } = makeFetch({ number: 7, title: "T", state: "open", user: { login: "octocat" }, body: "B", html_url: "https://h" });
    const provider = new GitHubProvider({ fetchImpl });
    const out = await provider.execute({ ...baseInput, action: "issues.read" });
    expect(out).toEqual({ number: 7, title: "T", state: "open", author: "octocat", body: "B", html_url: "https://h" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/owner/name/issues/7");
    expect(calls[0].init?.method).toBe("GET");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${token}`);
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect("Content-Type" in headers).toBe(false);
    expect(JSON.stringify(out)).not.toContain(token);
  });
  it("issues.read 404/非预期状态：PROVIDER_ERROR", async () => {
    const provider = new GitHubProvider({ fetchImpl: makeFetch({}, 404).fetchImpl });
    await expectGuardError(provider.execute({ ...baseInput, action: "issues.read" }), "PROVIDER_ERROR");
    const provider2 = new GitHubProvider({ fetchImpl: makeFetch({}, 403).fetchImpl });
    const guard = await catchGuardError(provider2.execute({ ...baseInput, action: "issues.read" }));
    expect(guard.message).toContain("github status 403");
  });
  it("issues.read 非法 payload：PROVIDER_ERROR（Fail Closed）", async () => {
    const provider = new GitHubProvider({ fetchImpl: makeFetch({}).fetchImpl });
    await expectGuardError(provider.execute({ ...baseInput, action: "issues.read", payload: "nope" }), "PROVIDER_ERROR");
    await expectGuardError(provider.execute({ ...baseInput, action: "issues.read", payload: { issue_number: 0 } }), "PROVIDER_ERROR");
    await expectGuardError(provider.execute({ ...baseInput, action: "issues.read", payload: { issue_number: true } }), "PROVIDER_ERROR");
  });
  it("issues.create 成功：POST 创建 issue，body 只含 title/body，白名单返回", async () => {
    const { calls, fetchImpl } = makeFetch({ number: 8, title: "N", state: "open", user: { login: "u" }, body: null, html_url: "https://h2" }, 201);
    const provider = new GitHubProvider({ fetchImpl });
    const out = await provider.execute({ ...baseInput, action: "issues.create", payload: { title: "N", body: "B" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/owner/name/issues");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ title: "N", body: "B" });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(out).toEqual({ number: 8, title: "N", state: "open", author: "u", body: null, html_url: "https://h2" });
  });
  it("issues.create body 可省略：请求体只含 title", async () => {
    const { calls, fetchImpl } = makeFetch({ number: 9, title: "T2" }, 201);
    const provider = new GitHubProvider({ fetchImpl });
    await provider.execute({ ...baseInput, action: "issues.create", payload: { title: "T2" } });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ title: "T2" });
  });
  it("issues.create 非法 title/404：PROVIDER_ERROR", async () => {
    const provider = new GitHubProvider({ fetchImpl: makeFetch({}).fetchImpl });
    await expectGuardError(provider.execute({ ...baseInput, action: "issues.create", payload: { title: "" } }), "PROVIDER_ERROR");
    const provider2 = new GitHubProvider({ fetchImpl: makeFetch({}, 404).fetchImpl });
    const guard = await catchGuardError(provider2.execute({ ...baseInput, action: "issues.create", payload: { title: "T" } }));
    expect(guard.message).toContain("github repo not found");
  });
  it("resource 非法：CAPABILITY_MISMATCH（请求目标只能来自 Lease Scope）", async () => {
    const provider = new GitHubProvider({ fetchImpl: makeFetch({}).fetchImpl });
    await expectGuardError(provider.execute({ ...baseInput, action: "issues.read", resource: "https://evil" }), "CAPABILITY_MISMATCH");
    await expectGuardError(provider.execute({ ...baseInput, action: "issues.read", resource: "repo:a/b/c" }), "CAPABILITY_MISMATCH");
    await expectGuardError(provider.execute({ ...baseInput, action: "issues.read", resource: "repo:" }), "CAPABILITY_MISMATCH");
  });
  it("action 不支持：ACTION_NOT_ALLOWED；credential 为空：CREDENTIAL_NOT_CONFIGURED", async () => {
    const provider = new GitHubProvider({ fetchImpl: makeFetch({}).fetchImpl });
    await expectGuardError(provider.execute({ ...baseInput, action: "repos.delete" }), "ACTION_NOT_ALLOWED");
    await expectGuardError(provider.execute({ ...baseInput, action: "issues.read", credential: "" }), "CREDENTIAL_NOT_CONFIGURED");
  });
  it("网络错误包装为 PROVIDER_ERROR；非法响应体 Fail Closed；AbortError 原样上抛", async () => {
    const fetchImpl: typeof fetch = async () => { throw new TypeError("connect ECONNREFUSED"); };
    const provider = new GitHubProvider({ fetchImpl });
    const guard = await catchGuardError(provider.execute({ ...baseInput, action: "issues.read" }));
    expect(guard.code).toBe("PROVIDER_ERROR");
    expect(guard.message).toContain("github request failed");
    const badJson: typeof fetch = async () => new Response("not-json", { status: 200 });
    await expectGuardError(new GitHubProvider({ fetchImpl: badJson }).execute({ ...baseInput, action: "issues.read" }), "PROVIDER_ERROR");
    const aborting: typeof fetch = async () => {
      const abort = new Error("aborted");
      abort.name = "AbortError";
      throw abort;
    };
    let caught: unknown;
    try {
      await new GitHubProvider({ fetchImpl: aborting }).execute({ ...baseInput, action: "issues.read" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("AbortError");
    expect(caught).not.toBeInstanceOf(GuardError);
  });
});
describe("端到端：Gate + CapabilityService + CredentialBroker + GitHubProvider（规格 23.10/23.12/23.13/23.14）", () => {
  const githubReadDefinition: ManagedCapabilityDefinition = {
    toolName: "guard_github_read_issue",
    provider: "github",
    action: "issues.read",
    resource: (args: unknown) => `repo:${(args as { repo: string }).repo}`,
    ttlSeconds: 120,
  };
  function runOf(callId: string, args: unknown): ToolRunContext {
    // 作用：构造可信 Tool Runtime 的最小 run 上下文
    return { callId, rootCallId: callId, name: githubReadDefinition.toolName, arguments: args, agent: { id: "s1" } };
  }
  it("managed Tool 全链路：ask → allowed-once 签发 Lease → Broker 执行 GitHub Operation；返回值与审计均无 Secret，且每次执行重新 resolve", async () => {
    const secret = "ghp_e2e_secret";
    const credentials = new FakeCredentialService(secret);
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ number: 7, title: "T", state: "open", user: { login: "octocat" }, body: "B", html_url: "https://h" }), { status: 200 });
    };
    const leases = new LeaseManager(new MemoryLeaseStore());
    const audit = new AuditService();
    const registry = new ProviderRegistry();
    registry.register(new GitHubProvider({ fetchImpl }));
    const broker = new CredentialBroker({ registry, getCredentials: () => credentials });
    const service = new CapabilityService(new Context(), { leases, defaultTtlSeconds: 60, maxTtlSeconds: 1800, executor: broker });
    service.register(githubReadDefinition);
    const gate = new UniversalGate({ policy: new PolicyResolver(DEFAULT_UNIVERSAL_POLICY), scopes: new ScopeResolver(), leases, pending: new PendingRegistry(), audit, managed: service });
    const ask = () => Promise.resolve({ kind: "ask" as const, reason: "need confirm" });
    await gate.handlePreExecute(runOf("c1", { repo: "a/b", issue_number: 7 }), ask);
    await gate.handleApprovalRequest({ callId: "c1" }, async () => "allowed-once");
    const operation: BrokerOperation = { provider: "github", resource: "repo:a/b", action: "issues.read", input: { issue_number: 7 } };
    const result = await service.execute(runOf("c2", { repo: "a/b", issue_number: 7 }), operation);
    expect(result).toEqual({ number: 7, title: "T", state: "open", author: "octocat", body: "B", html_url: "https://h" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(audit.list())).not.toContain(secret);
    expect(credentials.resolveCalls).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/a/b/issues/7");
    const again = await service.execute(runOf("c3", { repo: "a/b", issue_number: 7 }), operation);
    expect(again).toEqual(result);
    expect(credentials.resolveCalls).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});
