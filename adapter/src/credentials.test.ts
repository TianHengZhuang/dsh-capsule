import { describe, expect, it } from "vitest";
import { createCredentialResolveHandler, getCredentialService, type DshCredentialService } from "./credentials.js";
const SECRET = "ghp_super_secret_value";
function credentialsReturning(result: unknown): DshCredentialService {
  // 作用：构造返回固定结果的假 DSH credentials 服务
  return { resolve: async (_ref: string) => result };
}
describe("createCredentialResolveHandler", () => {
  it("字符串结果包装为 {value} 返回", async () => {
    await expect(createCredentialResolveHandler(() => credentialsReturning(SECRET))({ ref: "GITHUB_TOKEN" })).resolves.toEqual({ value: SECRET });
  });
  it("对象形 {value} 结果同样支持（规则 15：以实际 DSH 返回形状为准）", async () => {
    await expect(createCredentialResolveHandler(() => credentialsReturning({ value: SECRET }))({ ref: "GITHUB_TOKEN" })).resolves.toEqual({ value: SECRET });
  });
  it("凭据服务不可用即抛 CREDENTIAL_NOT_CONFIGURED（Fail Closed）", async () => {
    await expect(createCredentialResolveHandler(() => undefined)({ ref: "GITHUB_TOKEN" })).rejects.toThrow("CREDENTIAL_NOT_CONFIGURED");
  });
  it("空值/缺失值/非字符串值均拒绝且错误信息不含 Secret", async () => {
    for (const result of ["", undefined, null, 123, {}]) {
      const err = await createCredentialResolveHandler(() => credentialsReturning(result))({ ref: "GITHUB_TOKEN" }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("CREDENTIAL_NOT_CONFIGURED");
      expect(err.message).not.toContain(SECRET);
    }
  });
  it("ref 缺失或非法即拒绝", async () => {
    const handler = createCredentialResolveHandler(() => credentialsReturning(SECRET));
    await expect(handler({})).rejects.toThrow("CREDENTIAL_NOT_CONFIGURED");
    await expect(handler({ ref: "" })).rejects.toThrow("CREDENTIAL_NOT_CONFIGURED");
    await expect(handler(null)).rejects.toThrow("CREDENTIAL_NOT_CONFIGURED");
  });
});
describe("getCredentialService", () => {
  it("从 ctx 定位 credentials 服务", () => {
    expect(getCredentialService({ credentials: { resolve: async () => SECRET } })).toBeDefined();
  });
  it("形状不符或缺失时返回 undefined（Fail Closed）", () => {
    expect(getCredentialService({})).toBeUndefined();
    expect(getCredentialService({ credentials: {} })).toBeUndefined();
    expect(getCredentialService({ credentials: 42 })).toBeUndefined();
  });
});
