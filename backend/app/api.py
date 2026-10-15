# Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
"""ProjectDesk REST API: projects, tasks, notes, sessions, import/export."""
from __future__ import annotations

import csv
import io
import json
import re
import sqlite3
import time
from datetime import date, timedelta, timezone
from typing import Any, Optional

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, Response

from . import SCHEMA_VERSION, __version__
from .db import connect, init_db, utcnow_iso

PRIORITIES = ("low", "medium", "high", "urgent")
STATUSES = ("todo", "in_progress", "done")
SESSION_ACTIONS = ("start", "pause", "resume", "stop")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TAG_MAX = 60
TITLE_MAX = 200

# ---------------------------------------------------------------- helpers


class APIError(Exception):
    def __init__(self, status: int, error: str, message: str, **extra: Any):
        super().__init__(message)
        self.status = status
        self.error = error
        self.message = message
        self.extra = extra


def bad(status: int, error: str, message: str, **extra: Any) -> APIError:
    return APIError(status, error, message, **extra)


def now_s() -> float:
    return time.time()


def clean_tags(raw: Any) -> list[str]:
    """Normalize a tags payload to a validated list of strings.

    Accepts list or JSON-string (export docs store the DB's JSON string
    column, so import must json.loads it before calling this).
    """
    if raw is None:
        return []
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        try:
            raw = json.loads(s)
        except ValueError as e:
            raise bad(422, "validation", f"tags must be a list of strings: {e}") from e
    if not isinstance(raw, list):
        raise bad(422, "validation", "tags must be a list of strings")
    out: list[str] = []
    seen: set[str] = set()
    for t in raw:
        if not isinstance(t, str) or not t.strip():
            raise bad(422, "validation", f"invalid tag entry: {t!r}")
        t = t.strip().lower()
        if len(t) > TAG_MAX:
            raise bad(422, "validation", f"tag too long (> {TAG_MAX}): {t!r}")
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def clean_str(value: Any, field: str, required: bool = False,
             limit: int = TITLE_MAX, default: str = "") -> str:
    if value is None:
        if required:
            raise bad(422, "validation", f"{field} is required")
        return default
    if not isinstance(value, str):
        raise bad(422, "validation", f"{field} must be a string")
    v = value.strip()
    if required and not v:
        raise bad(422, "validation", f"{field} is required")
    if len(v) > limit:
        raise bad(422, "validation", f"{field} too long (> {limit} chars)")
    return v


def clean_int(value: Any, field: str, default: Optional[int] = None,
             minimum: Optional[int] = None, maximum: Optional[int] = None,
             required: bool = False) -> Optional[int]:
    if value is None:
        if required:
            raise bad(422, "validation", f"{field} is required")
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        raise bad(422, "validation", f"{field} must be an integer")
    if minimum is not None and value < minimum:
        raise bad(422, "validation", f"{field} must be >= {minimum}")
    if maximum is not None and value > maximum:
        raise bad(422, "validation", f"{field} must be <= {maximum}")
    return value


def clean_bool(value: Any) -> bool:
    if not isinstance(value, bool):
        raise bad(422, "validation", "expected boolean")
    return value


def clean_due(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise bad(422, "validation", "due_date must be a 'YYYY-MM-DD' string")
    v = value.strip()
    if not DATE_RE.match(v):
        raise bad(422, "validation", "due_date must be 'YYYY-MM-DD'")
    try:
        date.fromisoformat(v)
    except ValueError:
        raise bad(422, "validation", "due_date is not a valid calendar date") from None
    return v


def clean_dep_ids(raw: Any) -> list[int]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise bad(422, "validation", "depends_on must be a list of task ids")
    out = []
    for d in raw:
        if isinstance(d, bool) or not isinstance(d, int) or d < 1:
            raise bad(422, "validation", f"invalid dependency id: {d!r}")
        if d not in out:
            out.append(d)
    return out


def project_row(conn, project_id: int) -> dict:
    r = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if r is None:
        raise bad(404, "not_found", f"Project {project_id} not found")
    return {
        "id": r["id"], "name": r["name"], "description": r["description"],
        "color": r["color"], "archived": bool(r["archived"]),
        "version": r["version"], "created_at": r["created_at"],
        "updated_at": r["updated_at"],
    }


def task_row(conn, task_id: int) -> dict:
    r = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if r is None:
        raise bad(404, "not_found", f"Task {task_id} not found")
    return _task_to_dict(r)


def _task_to_dict(r) -> dict:
    return {
        "id": r["id"],
        "project_id": r["project_id"],
        "title": r["title"],
        "description": r["description"],
        "priority": r["priority"],
        "status": r["status"],
        "archived": bool(r["archived"]),
        "due_date": r["due_date"],
        "tags": json.loads(r["tags"]) if r["tags"] else [],
        "estimate_min": r["estimate_min"],
        "version": r["version"],
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
    }


def check_project_exists(conn, project_id: Any) -> None:
    if not isinstance(project_id, int) or isinstance(project_id, bool) or project_id < 1:
        raise bad(422, "validation", "project_id must be a positive integer")
    if conn.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone() is None:
        raise bad(404, "not_found", f"Project {project_id} not found")


def require_if_match(request: Request, current: int, resource: str) -> None:
    raw = request.headers.get("if-match")
    if raw is None:
        raise bad(412, "precondition_required",
                 f"If-Match header required for {resource} updates (send the current version)")
    try:
        supplied = int(raw.strip())
    except ValueError:
        raise bad(412, "precondition_required", "If-Match must be an integer version") from None
    if supplied != current:
        raise bad(409, "conflict",
                 f"{resource} changed elsewhere (you sent version {supplied}, server has {current}); "
                 f"re-fetch and retry",
                 current_version=current)


def adjacency(conn) -> dict[int, list[int]]:
    adj: dict[int, list[int]] = {}
    for r in conn.execute("SELECT task_id, depends_on FROM task_deps ORDER BY depends_on"):
        adj.setdefault(r["task_id"], []).append(r["depends_on"])
    return adj


def find_cycle(conn, task_id: int, deps: list[int]) -> Optional[list[int]]:
    """Return cycle path (first and last node = task_id) if adding deps creates one."""
    if not deps:
        return None
    adj = adjacency(conn)
    adj[task_id] = list(dict.fromkeys(adj.get(task_id, []) + deps))
    deps_uniq = list(dict.fromkeys(deps))
    for d in deps_uniq:
        path = [task_id, d]
        stack = [(d, iter(adj.get(d, [])))]
        seen = {task_id, d}
        while stack:
            node, it = stack[-1]
            advanced = False
            for nxt in it:
                if nxt == task_id:
                    return path + [task_id]
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append((nxt, iter(adj.get(nxt, []))))
                    path.append(nxt)
                    advanced = True
                    break
            if not advanced:
                stack.pop()
                if len(path) > 1:
                    path.pop()
    return None


def apply_deps(conn, task_id: int, deps: list[int]) -> None:
    """Replace task's outgoing dependency edges; enforces existence + cycles."""
    existing = {r["id"] for r in conn.execute("SELECT id FROM tasks")}
    ids = list(dict.fromkeys(deps))
    for d in ids:
        if d not in existing:
            raise bad(404, "not_found", f"Dependency task {d} not found")
    if task_id in ids:
        raise bad(422, "cycle", "Task cannot depend on itself", cycle=[task_id, task_id])
    cycle = find_cycle(conn, task_id, ids)
    if cycle:
        raise bad(409, "cycle",
                  f"Dependency cycle detected: {' -> '.join(str(i) for i in cycle)}",
                  cycle=cycle)
    conn.execute("DELETE FROM task_deps WHERE task_id=?", (task_id,))
    for d in ids:
        conn.execute("INSERT INTO task_deps(task_id, depends_on) VALUES(?,?)", (task_id, d))


def task_deps_for(conn, task_id: int) -> list[int]:
    return [r["depends_on"] for r in
            conn.execute("SELECT depends_on FROM task_deps WHERE task_id=? ORDER BY depends_on",
                         (task_id,))]


def subtasks_for(conn, task_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT id,title,done,position FROM subtasks WHERE task_id=? ORDER BY position,id",
        (task_id,)).fetchall()
    return [{"id": r["id"], "title": r["title"],
             "done": bool(r["done"]), "position": r["position"]} for r in rows]


def set_subtasks(conn, task_id: int, raw: Any) -> list[dict]:
    if raw is None:
        return subtasks_for(conn, task_id)
    if not isinstance(raw, list):
        raise bad(422, "validation", "subtasks must be a list")
    keep: list[tuple[Optional[int], str, bool, int]] = []
    for i, s in enumerate(raw):
        if not isinstance(s, dict):
            raise bad(422, "validation", f"subtasks[{i}] must be an object")
        sid = clean_int(s.get("id"), f"subtasks[{i}].id")
        title = clean_str(s.get("title"), f"subtasks[{i}].title", required=True)
        done = clean_bool(s.get("done", False))
        if sid is not None:
            row = conn.execute("SELECT id FROM subtasks WHERE id=? AND task_id=?", (sid, task_id)).fetchone()
            if row is None:
                raise bad(404, "not_found", f"subtask {sid} not found on task {task_id}")
        keep.append((sid, title, done, int(s.get("position", i)) if isinstance(s.get("position", i), int) else i))
    for sid, title, done, pos in keep:
        if sid is None:
            conn.execute("INSERT INTO subtasks(task_id,title,done,position) VALUES(?,?,?,?)",
                         (task_id, title, int(done), pos))
        else:
            conn.execute("UPDATE subtasks SET title=?,done=?,position=? WHERE id=?",
                         (title, int(done), pos, sid))
    ids = [k[0] for k in keep if k[0] is not None]
    if ids:
        q = ",".join("?" * len(ids))
        conn.execute(f"DELETE FROM subtasks WHERE task_id=? AND id NOT IN ({q})",
                     [task_id, *ids])
    return subtasks_for(conn, task_id)


def note_row_to_dict(r) -> dict:
    return {
        "id": r["id"], "project_id": r["project_id"], "title": r["title"],
        "body": r["body"], "version": r["version"],
        "created_at": r["created_at"], "updated_at": r["updated_at"],
    }


def active_session(conn) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM time_sessions WHERE status IN ('running','paused') "
        "ORDER BY id DESC LIMIT 1").fetchone()


def session_dict(conn, r) -> dict:
    n = now_s()
    if r["status"] == "running":
        elapsed = (n - r["started_at"]) * 1000.0 - r["total_paused_ms"]
    elif r["status"] == "paused":
        elapsed = (r["paused_at"] - r["started_at"]) * 1000.0 - r["total_paused_ms"]
    else:
        elapsed = (r["stopped_at"] - r["started_at"]) * 1000.0 - r["total_paused_ms"]
    t = conn.execute("SELECT id,title,status,archived FROM tasks WHERE id=?", (r["task_id"],)).fetchone()
    p = conn.execute("SELECT id,name FROM projects WHERE id=?", (r["project_id"],)).fetchone()
    return {
        "id": r["id"],
        "task_id": r["task_id"],
        "project_id": r["project_id"],
        "task_title": t["title"] if t else f"task:{r['task_id']}",
        "project_name": p["name"] if p else f"project:{r['project_id']}",
        "status": r["status"],
        "started_at": r["started_at"],
        "paused_at": r["paused_at"],
        "total_paused_ms": r["total_paused_ms"],
        "stopped_at": r["stopped_at"],
        "elapsed_ms": max(0.0, elapsed),
    }


# ---------------------------------------------------------------- sessions


def session_elapsed(r) -> float:
    """Seconds worked by a session row at call time (timestamp-based)."""
    n = now_s()
    if r["status"] == "running":
        end = n
    elif r["status"] == "paused":
        end = r["paused_at"]
    else:
        end = r["stopped_at"]
    return max(0.0, (end - r["started_at"]) - r["total_paused_ms"] / 1000.0)


def time_breakdown(conn) -> dict:
    n = now_s()
    def sess_seconds(r) -> float:
        if r["status"] == "running":
            end = n
        elif r["status"] == "paused":
            end = r["paused_at"]
        else:
            end = r["stopped_at"]
        return max(0.0, (end - r["started_at"]) - r["total_paused_ms"] / 1000.0)

    by_task: dict[int, float] = {}
    by_project: dict[int, float] = {}
    for r in conn.execute("SELECT * FROM time_sessions"):
        s = sess_seconds(r)
        by_task[r["task_id"]] = by_task.get(r["task_id"], 0.0) + s
        by_project[r["project_id"]] = by_project.get(r["project_id"], 0.0) + s
    out_t = []
    for tid, secs in sorted(by_task.items()):
        row = conn.execute(
            "SELECT t.title, t.project_id, p.name FROM tasks t "
            "LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?", (tid,)).fetchone()
        out_t.append({"task_id": tid,
                      "task_title": row["title"] if row else f"task:{tid}",
                      "project_id": row["project_id"] if row else None,
                      "project_name": row["name"] if row else None,
                      "seconds": round(secs, 1)})
    out_p = []
    for pid, secs in sorted(by_project.items()):
        row = conn.execute("SELECT name FROM projects WHERE id=?", (pid,)).fetchone()
        out_p.append({"project_id": pid,
                      "project_name": row["name"] if row else f"project:{pid}",
                      "seconds": round(secs, 1)})
    return {"by_task": out_t, "by_project": out_p}


def activity_summary(conn) -> list[dict]:
    """Work per day for the last 7 days (session windows apportioned by day)."""
    n = now_s()
    day_ms = 86400.0
    buckets: dict[str, float] = {}
    for r in conn.execute("SELECT * FROM time_sessions"):
        start = r["started_at"]
        if r["status"] == "running":
            end = n
        elif r["status"] == "paused":
            end = r["paused_at"]
        else:
            end = r["stopped_at"]
        total = max(1e-9, end - start)
        paused_frac = min(1.0, r["total_paused_ms"] / 1000.0 / total)
        work = total * (1.0 - paused_frac)
        day0 = start - start % 86400
        for d in range(8):
            day_lo = day0 + d * 86400
            day_hi = day_lo + 86400.0
            lo = max(start, day_lo)
            hi = min(end, day_hi)
            if hi > lo:
                key = time.strftime("%Y-%m-%d", time.gmtime(day_lo))
                buckets[key] = buckets.get(key, 0.0) + work * (hi - lo) / total
    out = []
    base = n - n % 86400
    for i in range(6, -1, -1):
        day_start = base - i * 86400
        key = time.strftime("%Y-%m-%d", time.gmtime(day_start))
        sec = buckets.get(key, 0.0)
        out.append({"date": key, "seconds": round(sec, 1), "active": sec > 0})
    return out
