import { describe, expect, it } from "vitest";
import { apply, type CapsuleHostContext } from "./index.js";
function makeCtx(): CapsuleHostContext {
  // 作用：构造最小 DSH 宿主上下文——on 注册三个 Guard hook 并返回 disposer（模拟 DSH 事件总线）
  const disposers: Array<() => void> = [];
  return {
    on: (event: string, handler: (...args: any[]) => any, options?: { prepend?: boolean }) => {
      void event;
      void handler;
      void options;
      const disposer = () => {};
      disposers.push(disposer);
      return disposer;
    },
  };
}
describe("Guard 插件入口（Phase 5 默认路径）", () => {
  it("无 runtime 配置：不启动 isolated runtime，正常挂载/清理 ctx.capabilities（默认不 spawn Python）", async () => {
    const ctx = makeCtx();
    const dispose = await apply(ctx);
    const capabilities = (ctx as { capabilities?: unknown }).capabilities as { register: unknown; execute: unknown; listCapabilities: unknown };
    expect(typeof capabilities?.register).toBe("function");
    expect(typeof capabilities?.execute).toBe("function");
    expect(typeof capabilities?.listCapabilities).toBe("function");
    await dispose();
    expect((ctx as { capabilities?: unknown }).capabilities).toBeUndefined();
  });
  it("带策略配置且无 runtime 配置：默认路径正常组装，不触碰 isolated runtime", async () => {
    const ctx = makeCtx();
    const dispose = await apply(ctx, { defaultTtlSeconds: 120 });
    expect((ctx as { capabilities?: unknown }).capabilities).toBeDefined();
    await dispose();
    expect((ctx as { capabilities?: unknown }).capabilities).toBeUndefined();
  });
});
