import { PythonRuntime } from "./rpc-client.js";
import { createLeaseApprovalHandler, getApprovalService } from "./approval.js";
import { createCredentialResolveHandler, getCredentialService } from "./credentials.js";
export type CapsuleHostContext = Record<string, unknown>;
export type DisposeHook = () => void | Promise<void>;
export { PythonRuntime };
// 作用：DSH 插件入口——spawn Python Runtime + ping 健康检查 + 注册宿主反向调用方法（host.approval.request_lease /
// host.credential.resolve，规格第 33 节）；ctx.tools.register 的具体属性名待以当前安装版本官方 TypeScript 类型核对后再接入
// （规则 15，禁止凭猜测硬编码）。
export async function apply(ctx: CapsuleHostContext): Promise<DisposeHook> {
  const runtime = new PythonRuntime();
  runtime.registerHostMethod("host.approval.request_lease", createLeaseApprovalHandler(() => getApprovalService(ctx)));
  runtime.registerHostMethod("host.credential.resolve", createCredentialResolveHandler(() => getCredentialService(ctx)));
  await runtime.start();
  const disposeHooks: DisposeHook[] = [];
  const registerDispose = (hook: DisposeHook) => disposeHooks.push(hook);
  void registerDispose;
  // TODO(Phase 1): 读取 capsule.list_tools 并调用 ctx.tools.register 注册 Capsule Tools
  return async () => {
    for (const hook of disposeHooks) {
      await hook();
    }
    await runtime.dispose();
  };
}
