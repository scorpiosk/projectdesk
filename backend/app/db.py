# Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
"""SQLite connection helper and schema for ProjectDesk."""
from __future__ import annotations

import os
import sqlite3
import threading
import time
from typing import Optional

SCHEMA_VERSION = 1

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT '#6366f1',
  archived   INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  priority      TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low','medium','high','urgent')),
  status        TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo','in_progress','done')),
  archived      INTEGER NOT NULL DEFAULT 0,
  due_date      TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',
  estimate_min  INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_deps (
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE IF NOT EXISTS subtasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS time_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  started_at      REAL NOT NULL,
  paused_at       REAL,
  total_paused_ms INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','paused','stopped')),
  stopped_at      REAL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON time_sessions(task_id);
"""


def utcnow_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def db_path() -> str:
    """Absolute SQLite file location (env-overridable, default <root>/data/projectdesk.db)."""
    override = os.environ.get("PROJECTDESK_DB")
    if override:
        return os.path.abspath(override)
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.abspath(os.path.join(backend_dir, os.pardir, "data", "projectdesk.db"))


def connect(path: Optional[str] = None) -> sqlite3.Connection:
    p = os.path.abspath(path) if path else db_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    conn = sqlite3.connect(p, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


_tls = threading.local()


def get_conn(path: Optional[str] = None) -> sqlite3.Connection:
    """Per-thread connection to the database file.

    sqlite3 Connections must never be used concurrently from multiple threads
    (that raises ``InterfaceError: bad parameter or other API misuse``), so
    each worker thread gets its own connection. Concurrent access to the file
    itself is safe: WAL journaling + file-level locking with a 10s timeout.
    """
    p = path or db_path()
    conns = getattr(_tls, "conns", None)
    if conns is None:
        conns = _tls.conns = {}
    conn = conns.get(p)
    if conn is None:
        conn = connect(p)
        init_db(conn)
        conns[p] = conn
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    exists = conn.execute(
        "SELECT 1 FROM meta WHERE key='schema_version'"
    ).fetchone()
    if not exists:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
    conn.commit()


def table_counts(conn: sqlite3.Connection) -> dict:
    out = {}
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    for r in rows:
        name = r[0] if isinstance(r, (list, tuple)) else r["name"]
        count = conn.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
        out[name] = count
    return out
