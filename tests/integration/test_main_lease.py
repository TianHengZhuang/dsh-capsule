import json
import os
import subprocess
import sys
RUNTIME_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "runtime")
LEASE_PARAMS = {
    "capsuleId": "github-reader", "capsuleInstanceId": "inst-1", "sessionId": "S100",
    "provider": "github", "resource": "repo:foo/bar", "action": "issues.read", "ttlSeconds": 600,
}
def _spawn(tmp_path) -> subprocess.Popen:
    # 作用：以真实子进程启动 Runtime，Lease 数据库指向临时目录避免污染仓库
    env = {**os.environ, "DSH_CAPSULE_LEASES_DB": str(tmp_path / "leases.db")}
    return subprocess.Popen(
        [sys.executable, "-m", "dsh_capsule.main"],
        cwd=RUNTIME_DIR, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1, env=env,
    )
def _send(proc: subprocess.Popen, msg: dict) -> None:
    # 作用：向 Runtime stdin 写入一行 NDJSON 请求
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
def _read(proc: subprocess.Popen) -> dict:
    # 作用：从 Runtime stdout 读取一行 NDJSON 消息
    return json.loads(proc.stdout.readline())
def _request_lease(proc: subprocess.Popen, msg_id: str, approval_decision: str | None) -> dict:
    # 作用：发起一次 lease.request 并扮演宿主响应反向 Approval；approval_decision 为 None 表示不应触发 Approval
    _send(proc, {"jsonrpc": "2.0", "id": msg_id, "method": "lease.request", "params": LEASE_PARAMS})
    if approval_decision is not None:
        approval = _read(proc)
        assert approval["method"] == "host.approval.request_lease"
        assert approval["params"]["capsuleId"] == "github-reader"
        assert approval["params"]["resource"] == "repo:foo/bar"
        _send(proc, {"jsonrpc": "2.0", "id": approval["id"], "result": {"decision": approval_decision}})
    return _read(proc)
def test_lease_request_full_approval_loop(tmp_path):
    # 作用：完整签发链路（规格第 18/33 节）：首次请求触发反向 host.approval.request_lease → 宿主回 allowed-once →
    # 签发 ACTIVE Lease 返回；第二次同参数请求直接复用，不再触发 Approval（规格第 19 节）
    proc = _spawn(tmp_path)
    try:
        first = _request_lease(proc, "ts-1", approval_decision="allowed-once")
        assert first["id"] == "ts-1"
        assert first["result"]["status"] == "ACTIVE"
        assert first["result"]["actions"] == ["issues.read"]
        assert first["result"]["resource"] == "repo:foo/bar"
        second = _request_lease(proc, "ts-2", approval_decision=None)
        assert second["id"] == "ts-2"
        assert second["result"]["leaseId"] == first["result"]["leaseId"]
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
def test_lease_request_rejected_returns_structured_error(tmp_path):
    # 作用：宿主拒绝时 lease.request 返回 RPC error，error.data.code 为统一错误码 LEASE_REJECTED（规格第 28 节）
    proc = _spawn(tmp_path)
    try:
        resp = _request_lease(proc, "ts-1", approval_decision="rejected")
        assert resp["id"] == "ts-1"
        assert resp["error"]["data"]["code"] == "LEASE_REJECTED"
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
def test_lease_request_invalid_params(tmp_path):
    # 作用：参数缺失/类型非法返回 JSON-RPC invalid params（-32602），不发起授权（Fail Closed）
    proc = _spawn(tmp_path)
    try:
        _send(proc, {"jsonrpc": "2.0", "id": "ts-1", "method": "lease.request", "params": {"capsuleId": "github-reader"}})
        resp = _read(proc)
        assert resp["error"]["code"] == -32602
        _send(proc, {"jsonrpc": "2.0", "id": "ts-2", "method": "lease.request", "params": {**LEASE_PARAMS, "ttlSeconds": "600"}})
        resp = _read(proc)
        assert resp["error"]["code"] == -32602
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
