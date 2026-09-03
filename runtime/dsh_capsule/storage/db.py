import json
import time
import uuid
import aiosqlite
from dsh_capsule.lease.models import CapabilityLease
SCHEMA = """
CREATE TABLE IF NOT EXISTS leases (
    id TEXT PRIMARY KEY,
    capsule_id TEXT NOT NULL,
    capsule_instance_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    resource TEXT NOT NULL,
    actions_json TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    revoked_at INTEGER,
    revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_leases_session ON leases(session_id);
CREATE INDEX IF NOT EXISTS idx_leases_capsule ON leases(capsule_id);
CREATE INDEX IF NOT EXISTS idx_leases_status ON leases(status);
"""
class LeaseStore:
    def __init__(self, db_path: str = "leases.db"):
        # 作用：Lease 持久化层——只管 SQLite 读写，不懂校验策略；所有时间均为 Unix 秒
        self._db_path = db_path
        self._conn: aiosqlite.Connection | None = None
    async def connect(self) -> None:
        # 作用：建立连接并确保表结构存在（幂等）
        self._conn = await aiosqlite.connect(self._db_path)
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.executescript(SCHEMA)
        await self._conn.commit()
    async def close(self) -> None:
        # 作用：关闭连接
        if self._conn is not None:
            await self._conn.close()
            self._conn = None
    def _require_conn(self) -> aiosqlite.Connection:
        # 作用：Fail Closed——未连接即抛错，绝不静默跳过持久化
        if self._conn is None:
            raise RuntimeError("LEASE_STORE_ERROR: storage not connected")
        return self._conn
    @staticmethod
    def _row_to_lease(row) -> CapabilityLease:
        # 作用：把数据库行还原为 Lease 模型
        return CapabilityLease(
            id=row[0], capsule_id=row[1], capsule_instance_id=row[2], session_id=row[3],
            provider=row[4], resource=row[5], actions=set(json.loads(row[6])),
            issued_at=row[7], expires_at=row[8], status=row[9],
            revoked_at=row[10], revoke_reason=row[11],
        )
    async def insert(self, lease: CapabilityLease) -> None:
        # 作用：写入新 Lease（签发路径专用）
        await self._require_conn().execute(
            "INSERT INTO leases (id, capsule_id, capsule_instance_id, session_id, provider, resource, actions_json, issued_at, expires_at, status, revoked_at, revoke_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (lease.id, lease.capsule_id, lease.capsule_instance_id, lease.session_id, lease.provider, lease.resource, json.dumps(sorted(lease.actions)), lease.issued_at, lease.expires_at, lease.status, lease.revoked_at, lease.revoke_reason),
        )
        await self._conn.commit()
    async def get(self, lease_id: str) -> CapabilityLease | None:
        # 作用：按 id 读取单个 Lease
        async with self._require_conn().execute("SELECT * FROM leases WHERE id = ?", (lease_id,)) as cur:
            row = await cur.fetchone()
            return self._row_to_lease(row) if row else None
    async def find_matching(self, capsule_instance_id: str, session_id: str, provider: str, resource: str) -> CapabilityLease | None:
        # 作用：查找同实例+同会话+同资源+同 Provider 的最新一条 Lease（复用路径的完整键匹配）
        async with self._require_conn().execute(
            "SELECT * FROM leases WHERE capsule_instance_id = ? AND session_id = ? AND provider = ? AND resource = ? ORDER BY issued_at DESC LIMIT 1",
            (capsule_instance_id, session_id, provider, resource),
        ) as cur:
            row = await cur.fetchone()
            return self._row_to_lease(row) if row else None
    async def find_for_resource(self, provider: str, resource: str) -> CapabilityLease | None:
        # 作用：按 Provider+资源查找最新 Lease（不限定实例与会话，由服务层做绑定校验）
        async with self._require_conn().execute(
            "SELECT * FROM leases WHERE provider = ? AND resource = ? ORDER BY issued_at DESC LIMIT 1",
            (provider, resource),
        ) as cur:
            row = await cur.fetchone()
            return self._row_to_lease(row) if row else None
    async def update_status(self, lease_id: str, status: str, revoke_reason: str | None = None) -> None:
        # 作用：更新 Lease 状态（EXPIRED/REVOKED），记录撤销原因与时间
        await self._require_conn().execute(
            "UPDATE leases SET status = ?, revoked_at = ?, revoke_reason = ? WHERE id = ?",
            (status, time.time(), revoke_reason, lease_id),
        )
        await self._conn.commit()
    async def revoke_by_session(self, session_id: str) -> int:
        # 作用：撤销某 Session 的全部 ACTIVE Lease，返回撤销数量
        cur = await self._require_conn().execute(
            "UPDATE leases SET status = 'REVOKED', revoked_at = ?, revoke_reason = ? WHERE session_id = ? AND status = 'ACTIVE'",
            (time.time(), "session revoked", session_id),
        )
        await self._conn.commit()
        return cur.rowcount
    async def revoke_by_capsule(self, capsule_id: str) -> int:
        # 作用：撤销某 Capsule 的全部 ACTIVE Lease，返回撤销数量
        cur = await self._require_conn().execute(
            "UPDATE leases SET status = 'REVOKED', revoked_at = ?, revoke_reason = ? WHERE capsule_id = ? AND status = 'ACTIVE'",
            (time.time(), "capsule revoked", capsule_id),
        )
        await self._conn.commit()
        return cur.rowcount
    async def list_all(self) -> list[CapabilityLease]:
        # 作用：列出全部 Lease（capsulectl 与调试用）
        async with self._require_conn().execute("SELECT * FROM leases ORDER BY issued_at DESC") as cur:
            return [self._row_to_lease(row) for row in await cur.fetchall()]
def new_lease_id() -> str:
    # 作用：生成全局唯一 Lease ID
    return f"L{uuid.uuid4().hex[:12]}"
