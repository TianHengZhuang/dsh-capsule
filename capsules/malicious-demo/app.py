import os
import socket
from dsh_capsule_sdk.tool import CapsuleApp
app = CapsuleApp()
@app.tool("probe_host_file")
async def probe_host_file(args: dict, ctx) -> dict:
    # 作用：尝试读取宿主路径文件——隔离生效时应只见容器自身文件系统
    path = args.get("path", "/etc/passwd")
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return {"ok": True, "path": path, "content": f.read()[:4096]}
    except OSError as exc:
        return {"ok": False, "path": path, "error": str(exc)}
@app.tool("probe_env")
async def probe_env(args: dict, ctx) -> dict:
    # 作用：导出容器内全部环境变量——应只见 Runtime 注入的非敏感变量
    return {"env": dict(os.environ)}
@app.tool("probe_network")
async def probe_network(args: dict, ctx) -> dict:
    # 作用：尝试直接对外建立 TCP 连接——network none 下应失败
    host = args.get("host", "1.1.1.1")
    port = int(args.get("port", 443))
    try:
        with socket.create_connection((host, port), timeout=5):
            return {"ok": True, "host": host, "port": port}
    except OSError as exc:
        return {"ok": False, "host": host, "port": port, "error": str(exc)}
@app.tool("probe_docker_sock")
async def probe_docker_sock(args: dict, ctx) -> dict:
    # 作用：尝试连接 Docker Socket 实现逃逸——未挂载下应失败
    for path in ("/var/run/docker.sock", "/run/docker.sock"):
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(3)
            s.connect(path)
            s.close()
            return {"ok": True, "path": path}
        except OSError:
            continue
    return {"ok": False, "error": "docker.sock unreachable"}
@app.tool("probe_write_file")
async def probe_write_file(args: dict, ctx) -> dict:
    # 作用：尝试向只读位置写入文件——read-only 根文件系统下应失败
    last_error = ""
    for path in ("/app", "/etc", "/usr", "/var"):
        try:
            with open(f"{path}/pwned", "w") as f:
                f.write("pwned")
            return {"ok": True, "path": f"{path}/pwned"}
        except OSError as exc:
            last_error = str(exc)
    return {"ok": False, "error": last_error}
@app.tool("attack_huge_output")
async def attack_huge_output(args: dict, ctx) -> dict:
    # 作用：返回超过 2MB 上限的载荷——验证响应上限拦截
    return {"payload": "x" * (4 * 1024 * 1024)}
@app.tool("attack_dead_loop")
async def attack_dead_loop(args: dict, ctx) -> dict:
    # 作用：死循环占用 CPU——验证调用超时矩阵
    while True:
        pass
@app.tool("attack_crash")
async def attack_crash(args: dict, ctx) -> dict:
    # 作用：进程自杀——验证容器崩溃被隔离且实例可自动重建
    os._exit(137)
if __name__ == "__main__":
    app.run()
