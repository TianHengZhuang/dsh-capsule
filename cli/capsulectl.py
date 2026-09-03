import argparse
import asyncio
import sys
from dsh_capsule.lease.service import LeaseService
from dsh_capsule.lease.models import LeaseError
from dsh_capsule.storage.db import LeaseStore
def _build_service(db_path: str) -> tuple[LeaseService, LeaseStore]:
    # 作用：构造连接指定 SQLite 文件的 LeaseService 与其存储句柄
    store = LeaseStore(db_path)
    asyncio.run(store.connect())
    return LeaseService(store), store
def cmd_leases(db_path: str) -> None:
    # 作用：列出全部 Lease 及其状态
    service, store = _build_service(db_path)
    try:
        leases = asyncio.run(service.list_leases())
        if not leases:
            print("no leases")
            return
        for l in leases:
            print(f"{l.id}  capsule={l.capsule_id}  session={l.session_id}  {l.provider} {l.resource}  actions={','.join(sorted(l.actions))}  status={l.status}  expires={int(l.expires_at)}")
    finally:
        asyncio.run(store.close())
def _revoke_and_report(coro_name: str, db_path: str, target: str) -> None:
    # 作用：执行撤销命令并汇报结果；失败时打印统一错误码
    service, store = _build_service(db_path)
    try:
        if coro_name == "revoke":
            asyncio.run(service.revoke(target))
            print(f"revoked {target}")
        elif coro_name == "revoke_session":
            n = asyncio.run(service.revoke_session(target))
            print(f"revoked {n} lease(s) of session {target}")
        else:
            n = asyncio.run(service.revoke_capsule(target))
            print(f"revoked {n} lease(s) of capsule {target}")
    except LeaseError as exc:
        print(f"error: {exc.code}", file=sys.stderr)
        sys.exit(1)
    finally:
        asyncio.run(store.close())
def main() -> None:
    # 作用：capsulectl 入口——leases / revoke / revoke-session / revoke-capsule（规格第 20 节）
    parser = argparse.ArgumentParser(prog="capsulectl")
    parser.add_argument("--db", default="leases.db", help="path to lease sqlite db")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("leases")
    p_revoke = sub.add_parser("revoke"); p_revoke.add_argument("lease_id")
    p_rs = sub.add_parser("revoke-session"); p_rs.add_argument("session_id")
    p_rc = sub.add_parser("revoke-capsule"); p_rc.add_argument("capsule_id")
    args = parser.parse_args()
    if args.cmd == "leases":
        cmd_leases(args.db)
    elif args.cmd == "revoke":
        _revoke_and_report("revoke", args.db, args.lease_id)
    elif args.cmd == "revoke-session":
        _revoke_and_report("revoke_session", args.db, args.session_id)
    else:
        _revoke_and_report("revoke_capsule", args.db, args.capsule_id)
if __name__ == "__main__":
    main()
