import re
from dsh_capsule_sdk import CapsuleApp
app = CapsuleApp()
REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
@app.tool("github_get_issue")
async def github_get_issue(args: dict, ctx) -> dict:
    # 作用：读取单个 GitHub Issue（规格第 26 节）——校验 repo 格式后经宿主 Broker 转发，Token 永不进入容器
    repo = args.get("repo")
    issue_number = args.get("issue_number")
    if not isinstance(repo, str) or not REPO_PATTERN.match(repo):
        raise RuntimeError("CAPSULE_PROTOCOL_ERROR: repo must be owner/repo")
    if not isinstance(issue_number, int) or issue_number < 1:
        raise RuntimeError("CAPSULE_PROTOCOL_ERROR: issue_number must be a positive integer")
    return await ctx.broker.call(provider="github", action="issues.read", resource=f"repo:{repo}", payload={"repo": repo, "issue_number": issue_number})
app.run()
