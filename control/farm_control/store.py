"""Durable control state: sessions (so the ACU budget and session mapping survive restarts)
and the evidence_id -> rig_id index used to republish evidence."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("CREATE TABLE IF NOT EXISTS sessions (farm_id TEXT PRIMARY KEY, created_at REAL, data TEXT)")
        self._db.execute("CREATE TABLE IF NOT EXISTS evidence (evidence_id TEXT PRIMARY KEY, rig_id TEXT)")

    def save_session(self, farm_id: str, created_at: float, data: dict[str, Any]) -> None:
        self._db.execute("INSERT INTO sessions (farm_id, created_at, data) VALUES (?, ?, ?) "
                         "ON CONFLICT(farm_id) DO UPDATE SET data = excluded.data",
                         (farm_id, created_at, json.dumps(data)))

    def load_sessions(self) -> list[dict[str, Any]]:
        rows = self._db.execute("SELECT data FROM sessions ORDER BY created_at").fetchall()
        return [json.loads(r[0]) for r in rows]

    def index_evidence(self, evidence_id: str, rig_id: str) -> None:
        self._db.execute("INSERT OR REPLACE INTO evidence (evidence_id, rig_id) VALUES (?, ?)", (evidence_id, rig_id))

    def evidence_rig(self, evidence_id: str) -> str | None:
        row = self._db.execute("SELECT rig_id FROM evidence WHERE evidence_id = ?", (evidence_id,)).fetchone()
        return row[0] if row else None

    def close(self) -> None:
        self._db.close()
