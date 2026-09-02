import { PythonRuntime } from "./rpc-client.js";
export type CapsuleHostContext = Record<string, unknown>;
export type DisposeHook = () => void | Promise<void>;
export { PythonRuntime };
// 作用：DSH 插件入口——Phase 0 只做"spawn Python Runtime + ping 健康检查"；
// ctx.tools.register / ctx.approval / ctx.credentials 的具体属性名待 Phase 1+ 以当前安装版本
// 的官方 TypeScript 类型定义核对后再接入，禁止凭猜测硬编码。
export async function apply(ctx: CapsuleHostContext): Promise<DisposeHook> {
  const runtime = new PythonRuntime();
  await runtime.start();
  const disposeHooks: DisposeHook[] = [];
  const registerDispose = (hook: DisposeHook) => disposeHooks.push(hook);
  void ctx;
  void registerDispose;
  // TODO(Phase 1): 读取 capsule.list_tools 并调用 ctx.tools.register 注册 Capsule Tools
  // TODO(Phase 4): registerHostMethod("host.approval.request_lease", ...) 与 host.credential.resolve
  return async () => {
    for (const hook of disposeHooks) {
      await hook();
    }
    await runtime.dispose();
  };
}
