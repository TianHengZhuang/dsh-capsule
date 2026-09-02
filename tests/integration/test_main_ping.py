import json
import os
import subprocess
import sys
RUNTIME_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "runtime")
def test_main_ping_subprocess():
    # 作用：以真实子进程模式验证 main.py 对 system.ping 的 NDJSON 响应
    proc = subprocess.Popen(
        [sys.executable, "-m", "dsh_capsule.main"],
        cwd=RUNTIME_DIR,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    try:
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": "1", "method": "system.ping", "params": {}}) + "\n")
        proc.stdin.flush()
        msg = json.loads(proc.stdout.readline())
        assert msg["id"] == "1"
        assert msg["result"] == {"pong": True}
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
def test_main_ignores_garbage_line():
    # 作用：验证协议容错：非法 JSON 行返回 parse error 而不崩溃
    proc = subprocess.Popen(
        [sys.executable, "-m", "dsh_capsule.main"],
        cwd=RUNTIME_DIR,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    try:
        proc.stdin.write("not a json line\n")
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": "2", "method": "system.ping", "params": {}}) + "\n")
        proc.stdin.flush()
        err = json.loads(proc.stdout.readline())
        assert err["error"]["code"] == -32700
        msg = json.loads(proc.stdout.readline())
        assert msg["id"] == "2"
        assert msg["result"] == {"pong": True}
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
