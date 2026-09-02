import { afterEach, describe, expect, it } from "vitest";
import { PythonRuntime } from "./rpc-client.js";
describe("PythonRuntime RPC", () => {
  let runtime: PythonRuntime | null = null;
  afterEach(async () => {
    // 作用：每条用例结束后确保子进程被回收，避免泄漏
    await runtime?.dispose();
    runtime = null;
  });
  it("system.ping 健康检查返回 pong", async () => {
    runtime = new PythonRuntime();
    await runtime.start();
    expect(await runtime.call("system.ping")).toEqual({ pong: true });
  });
  it("支持双向 RPC（Python 反向调用宿主方法）", async () => {
    runtime = new PythonRuntime();
    runtime.registerHostMethod("host.echo", (p) => p);
    await runtime.start();
    expect(await runtime.call("system.call_host", { method: "host.echo", params: { a: 1 } })).toEqual({ a: 1 });
  });
  it("未注册的宿主方法返回错误", async () => {
    runtime = new PythonRuntime();
    await runtime.start();
    await expect(runtime.call("system.call_host", { method: "host.nope", params: {} })).rejects.toThrow("method not found");
  });
  it("dispose 后 Python 子进程退出且后续调用失败", async () => {
    runtime = new PythonRuntime();
    await runtime.start();
    await runtime.dispose();
    await expect(runtime.call("system.ping")).rejects.toThrow("not started");
  });
});
