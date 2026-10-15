# Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
"""Optional sample workspace — full replace, single flag, never repeated."""
from __future__ import annotations

import json
import sqlite3
import time
from datetime import date, timedelta


def _iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def seed_sample(conn: sqlite3.Connection) -> int:
    now = time.time()
    D = 86400.0
    today = date.today()
    yesterday = (today - timedelta(days=1)).isoformat()
    tomorrow = (today + timedelta(days=1)).isoformat()
    in_4 = (today - timedelta(days=4)).isoformat()

    conn.execute("BEGIN IMMEDIATE")
    try:
        for table in ("subtasks", "task_deps", "notes", "time_sessions",
                      "tasks", "projects"):
            conn.execute(f"DELETE FROM {table}")

        projects = [
            (1, "Website Redesign", "Marketing site refresh: copy, design, build.", "#6366f1"),
            (2, "API Platform", "Internal API modernisation and docs.", "#10b981"),
            (3, "Personal", "Reading, writing, life admin.", "#f59e0b"),
        ]
        for pid, name, desc, color in projects:
            conn.execute(
                "INSERT INTO projects(id,name,description,color,archived,version,created_at,updated_at) "
                "VALUES(?,?,?,?,0,1,?,?)",
                (pid, name, desc, color, _iso(now - 30 * D), _iso(now - 2 * D)))

        tasks = [
            # id, project, title, desc, priority, status, due, tags, est, deps
            (1, 1, "Draft homepage copy",
             "Hero, feature, and CTA copy for the redesigned site.",
             "medium", "done", in_4, ["content"], 120, []),
            (2, 1, "Design hero section",
             "Responsive hero with gradient and product screenshot.",
             "high", "in_progress", today.isoformat(), ["design", "frontend"], 240, [1]),
            (3, 2, "Build design tokens",
             "Shared colour and type scale for all services.",
             "high", "todo", None, ["design"], 180, [4]),
            (4, 2, "Audit existing endpoints",
             "Inventory endpoints, flag duplicates and deprecated routes.",
             "medium", "in_progress", None, ["backend"], 300, [5]),
            (5, 2, "Spin up staging env",
             "One-command local staging stack.",
             "low", "done", None, ["infra"], 90, []),
            (6, 3, "Plan reading list",
             "Q4 picks across systems, design, and finance.",
             "low", "todo", yesterday, ["reading"], 30, []),
            (7, 3, "Write journal post",
             "Weekly reflection, published to the notes site.",
             "medium", "todo", tomorrow, ["writing"], 45, [1]),
        ]
        for (tid, pid, title, desc, prio, status, due, tags, est, deps) in tasks:
            created = _iso(now - 20 * D + tid * 600)
            updated = _iso(now - ((tid % 7) + 1) * D)
            conn.execute(
                "INSERT INTO tasks(id,project_id,title,description,priority,status,"
                "archived,due_date,tags,estimate_min,version,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (tid, pid, title, desc, prio, status, 0, due, json.dumps(tags),
                 est, 2, created, updated))
        for (tid, pid, title, desc, prio, status, due, tags, est, deps) in tasks:
            for dep in deps:
                conn.execute("INSERT INTO task_deps(task_id,depends_on) VALUES(?,?)",
                             (tid, dep))

        subtasks = [
            (100, 2, "Wire hero copy", 1, 0),
            (101, 2, "Animate gradient", 0, 1),
            (200, 4, "Document endpoints", 1, 0),
        ]
        for sub_id, tid, title, done, pos in subtasks:
            conn.execute(
                "INSERT INTO subtasks(id,task_id,title,done,position) VALUES(?,?,?,?,?)",
                (sub_id, tid, title, done, pos))

        notes = [
            (1, 1, "Homepage direction",
             "# Hero direction\n\nLead with the **outcome**, not the feature list.\n\n"
             "- One clear CTA\n- Product screenshot, right side\n"
             "- Short trust bar below\n\n> Copy review: Friday, no exceptions."),
            (2, 2, "Endpoint audit notes",
             "## Findings\n\n1. Three routes duplicated between v1 and v2\n"
             "2. `pricing` endpoint slow (P95 800ms)\n\n"
             "```bash\ncurl -H 'X-Org: acme' /v2/orders | jq '.items | length'\n```\n\n"
             "- [x] Flag duplicates\n- [ ] Propose deprecation schedule"),
            (3, 3, "Q4 reading shortlist",
             "- *The Design of Everyday Things* (re-read)\n"
             "- Systems thinking primer\n- Personal finance, second edition\n\n"
             "**Rule:** 20 pages before a new pick."),
        ]
        for nid, pid, title, body in notes:
            conn.execute(
                "INSERT INTO notes(id,project_id,title,body,version,created_at,updated_at) "
                "VALUES(?,?,?,?,1,?,?)",
                (nid, pid, title, body, _iso(now - 9 * D), _iso(now - (nid % 5 + 1) * D)))

        sessions = [
            # id, task, project, start, paused_at, total_paused_ms, status, stopped_at
            (1, 1, 1, now - 6 * D, None, 600.0, "stopped", now - 6 * D + 2400),
            (2, 1, 1, now - 3 * D, None, 0.0, "stopped", now - 3 * D + 1800),
            (3, 4, 2, now - 5 * D, None, 300.0, "stopped", now - 5 * D + 5400),
            (4, 5, 2, now - 8 * D, None, 0.0, "stopped", now - 8 * D + 3000),
            (5, 7, 3, now - 3600, None, 0.0, "stopped", now - 3000),
            (6, 2, 1, now - 900.0, None, 0.0, "running", None),
        ]
        for sid, tid, pid, started, paused_at, paused_ms, status, stopped_at in sessions:
            conn.execute(
                "INSERT INTO time_sessions(id,task_id,project_id,started_at,paused_at,"
                "total_paused_ms,status,stopped_at) VALUES(?,?,?,?,?,?,?,?)",
                (sid, tid, pid, started, paused_at, paused_ms, status, stopped_at))

        for table, colmax in (("projects", "MAX(id)"), ("tasks", "MAX(id)"),
                              ("notes", "MAX(id)"), ("subtasks", "MAX(id)"),
                              ("time_sessions", "MAX(id)")):
            conn.execute(
                f"UPDATE sqlite_sequence SET seq=COALESCE((SELECT {colmax} FROM {table}),0) "
                f"WHERE name=?", (table,))
        iso = _iso(now)
        conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('sample_seeded','1')")
        conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('sample_seeded_at',?)",
                     (iso,))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
