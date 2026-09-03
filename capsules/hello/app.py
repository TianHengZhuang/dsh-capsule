from dsh_capsule_sdk import CapsuleApp
app = CapsuleApp()
@app.tool("hello_capsule")
async def hello_capsule(args: dict, ctx) -> dict:
    # 作用：Phase 1 验收工具——证明调用真实发生在隔离容器内部
    return {"message": f"hello, {args.get('name', 'capsule')}!"}
app.run()
