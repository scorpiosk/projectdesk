# Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
"""ProjectDesk HTTP routes (bound to a live SQLite connection)."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, Response

from . import SCHEMA_VERSION, __version__
from . import sample as sample_data
from .api import (
    APIError, PRIORITIES, STATUSES, active_session, activity_summary,
    apply_deps, bad, clean_bool, clean_due, clean_dep_ids, clean_int,
    clean_str, clean_tags, now_s, project_row, require_if_match,
    session_dict, set_subtasks, subtasks_for, task_deps_for, time_breakdown,
)
from .db import db_path, get_conn as thread_conn, table_counts


class R:
    """Route endpoint holders shared by the router builder."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    # ------------------------------------------------------------ health/state

    def health(self) -> JSONResponse:
        return JSONResponse({
            "status": "ok",
            "version": __version__,
            "schema_version": SCHEMA_VERSION,
            "db": os.path.basename(db_path()),
            "tables": table_counts(self.conn),
        })

    def state(self) -> dict:
        def c(t: str) -> int:
            return self.conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        projects = c("projects")
        tasks = c("tasks")
        notes = c("notes")
        sessions = c("time_sessions")
        row = self.conn.execute(
            "SELECT value FROM meta WHERE key='sample_seeded'").fetchone()
        return {
            "projects": projects, "tasks": tasks, "notes": notes,
            "sessions": sessions,
            "sample_seeded": bool(row and row[0] == "1"),
            "workspace_empty": projects == 0 and tasks == 0 and notes == 0
            and sessions == 0,
        }

    def sample(self) -> dict:
        seeded = sample_data.seed_sample(self.conn)
        return {"seeded": seeded, **self.state()}

    # ------------------------------------------------------------ dashboard

    def task_payload(self, r) -> dict:
        d = {
            "id": r["id"], "project_id": r["project_id"], "title": r["title"],
            "description": r["description"], "priority": r["priority"],
            "status": r["status"], "archived": bool(r["archived"]),
            "due_date": r["due_date"],
            "tags": json.loads(r["tags"]) if r["tags"] else [],
            "estimate_min": r["estimate_min"], "version": r["version"],
            "created_at": r["created_at"], "updated_at": r["updated_at"],
        }
        d["subtasks"] = subtasks_for(self.conn, r["id"])
        d["depends_on"] = task_deps_for(self.conn, r["id"])
        blocked_by = []
        for dep_id in d["depends_on"]:
            dr = self.conn.execute(
                "SELECT id,title,status,archived FROM tasks WHERE id=?",
                (dep_id,)).fetchone()
            if dr and (dr["status"] != "done" or dr["archived"]):
                blocked_by.append({"id": dr["id"], "title": dr["title"],
                                   "status": dr["status"],
                                   "archived": bool(dr["archived"])})
        d["blocked"] = bool(blocked_by)
        d["blocked_by"] = blocked_by
        return d

    def dashboard(self) -> dict:
        conn = self.conn
        rows = conn.execute(
            "SELECT * FROM tasks WHERE archived=0").fetchall()
        today = date.today().isoformat()

        def blocked(row) -> bool:
            for dep_id in task_deps_for(conn, row["id"]):
                dr = conn.execute(
                    "SELECT status,archived FROM tasks WHERE id=?",
                    (dep_id,)).fetchone()
                if dr and (dr["status"] != "done" or dr["archived"]):
                    return True
            return False

        blocked_count = sum(1 for r in rows if blocked(r))
        projects = conn.execute("SELECT archived FROM projects").fetchall()
        time_info = time_breakdown(conn)
        time_info["activity"] = activity_summary(conn)
        return {
            "counts": {
                "tasks_total": len(rows),
                "todo": sum(1 for r in rows if r["status"] == "todo"),
                "in_progress": sum(1 for r in rows if r["status"] == "in_progress"),
                "done": sum(1 for r in rows if r["status"] == "done"),
                "overdue": sum(1 for r in rows
                               if r["due_date"] and r["due_date"] < today
                               and r["status"] != "done"),
                "blocked": blocked_count,
                "projects_active": sum(1 for p in projects if not p["archived"]),
                "projects_archived": sum(1 for p in projects if p["archived"]),
                "notes": conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0],
                "sessions": conn.execute("SELECT COUNT(*) FROM time_sessions").fetchone()[0],
            },
            "time": time_info,
        }

    # ------------------------------------------------------------ projects

    def list_projects(self, archived: Optional[str] = None) -> list[dict]:
        out = []
        rows = self.conn.execute("SELECT * FROM projects ORDER BY name").fetchall()
        for r in rows:
            is_arch = bool(r["archived"])
            if archived is None:
                if is_arch:
                    continue
            elif (archived == "true") != is_arch:
                continue
            p = {"id": r["id"], "name": r["name"], "description": r["description"],
                 "color": r["color"], "archived": bool(r["archived"]),
                 "version": r["version"], "created_at": r["created_at"],
                 "updated_at": r["updated_at"]}
            p["task_count"] = self.conn.execute(
                "SELECT COUNT(*) FROM tasks WHERE project_id=? AND archived=0",
                (r["id"],)).fetchone()[0]
            out.append(p)
        return {"projects": out, "total": len(out)}

    def _project_fields(self, body: dict) -> tuple[str, str, str]:
        if not isinstance(body, dict):
            raise bad(422, "validation", "request body must be a JSON object")
        name = clean_str(body.get("name"), "name", required=True)
        desc = clean_str(body.get("description"), "description", limit=2000)
        color = clean_str(body.get("color"), "color", limit=16, default="#6366f1")
        if not (color.startswith("#") and len(color) == 7
                and all(ch in "0123456789abcdefABCDEF" for ch in color[1:])):
            raise bad(422, "validation", "color must be a #rrggbb hex value")
        return name, desc, color

    def create_project(self, body: Any) -> dict:
        name, desc, color = self._project_fields(body if body else {})
        iso = _iso()
        cur = self.conn.execute(
            "INSERT INTO projects(name,description,color,archived,version,created_at,updated_at) "
            "VALUES(?,?,?,0,1,?,?)", (name, desc, color, iso, iso))
        self.conn.commit()
        self.conn.rollback()
        p = project_row(self.conn, cur.lastrowid)
        self.conn.commit()
        return {"project": p, "version": p["version"]}

    def update_project(self, request: Request, pid: int, body: Any) -> dict:
        conn = self.conn
        p = project_row(conn, pid)
        require_if_match(request, p["version"], "project")
        name, desc, color = self._project_fields(body if body else {})
        iso = _iso()
        conn.execute(
            "UPDATE projects SET name=?,description=?,color=?,version=version+1,updated_at=? WHERE id=?",
            (name, desc, color, iso, pid))
        conn.commit()
        return {"project": project_row(conn, pid)}

    def set_archived(self, pid: int, archived: bool) -> dict:
        conn = self.conn
        p = project_row(conn, pid)
        iso = _iso()
        conn.execute(
            "UPDATE projects SET archived=?,version=version+1,updated_at=? WHERE id=?",
            (int(archived), iso, pid))
        conn.commit()
        return {"project": project_row(conn, pid)}

    def delete_project(self, pid: int) -> dict:
        conn = self.conn
        p = project_row(conn, pid)
        task_ids = [r["id"] for r in conn.execute(
            "SELECT id FROM tasks WHERE project_id=?", (pid,)).fetchall()]
        conn.execute("DELETE FROM projects WHERE id=?", (pid,))
        # FK ON DELETE CASCADE removes tasks/notes/sessions when the pragma is on;
        # delete explicitly too so the result is deterministic either way.
        for tid in task_ids:
            conn.execute("DELETE FROM time_sessions WHERE task_id=?", (tid,))
            conn.execute("DELETE FROM subtasks WHERE task_id=?", (tid,))
            conn.execute("DELETE FROM task_deps WHERE task_id=? OR depends_on=?", (tid, tid))
        conn.execute("DELETE FROM tasks WHERE project_id=?", (pid,))
        conn.execute("DELETE FROM notes WHERE project_id=?", (pid,))
        conn.commit()
        return {"deleted": pid, "tasks_removed": len(task_ids)}

    # ------------------------------------------------------------ tasks

    def filtered_rows(self, q, project_id, status, priority, tag, overdue, archived):
        conn = self.conn
        out = []
        today = date.today().isoformat()
        want_archived = (archived == "true")
        rows = conn.execute("SELECT * FROM tasks").fetchall()
        for r in rows:
            if bool(r["archived"]) != want_archived:
                continue
            if project_id is not None and r["project_id"] != project_id:
                continue
            if status and r["status"] != status:
                continue
            if priority and r["priority"] != priority:
                continue
            if tag and not all(t in json.loads(r["tags"] or "[]") for t in tag):
                continue
            if overdue == "true":
                if not (r["due_date"] and r["due_date"] < today
                        and r["status"] != "done"):
                    continue
            if q:
                qq = q.lower()
                if (qq not in r["title"].lower()
                        and qq not in r["description"].lower()):
                    note = conn.execute(
                        "SELECT 1 FROM notes n WHERE n.project_id=? AND "
                        "(lower(n.title) LIKE ? OR lower(n.body) LIKE ?) LIMIT 1",
                        (r["project_id"], f"%{q}%", f"%{q}%")).fetchone()
                    if not note:
                        continue
            out.append(r)
        out.sort(key=lambda r: (0 if r["due_date"] else 1, r["due_date"] or "9999", -r["id"]))
        return out

    def list_tasks(self, q: Optional[str] = None,
                   project_id: Optional[int] = None,
                   status: Optional[str] = None,
                   priority: Optional[str] = None,
                   tag: Optional[list[str]] = Query(default=None),
                   overdue: Optional[str] = None,
                   archived: Optional[str] = None) -> dict:
        rows = self.filtered_rows(q, project_id, status, priority, tag, overdue, archived)
        tasks = [self.task_payload(r) for r in rows]
        return {"tasks": tasks, "total": len(tasks)}

    def get_task(self, tid: int) -> dict:
        r = self.conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        if not r:
            raise bad(404, "not_found", f"Task {tid} not found")
        return {"task": self.task_payload(r)}

    def _task_fields(self, body: dict, for_update: bool = False):
        title = clean_str(body.get("title"), "title", required=True)
        desc = clean_str(body.get("description"), "description", limit=5000)
        prio = body.get("priority", "medium")
        if prio not in PRIORITIES:
            raise bad(422, "validation",
                      f"priority must be one of {list(PRIORITIES)}")
        status = body.get("status", "todo")
        if status not in STATUSES:
            raise bad(422, "validation", f"status must be one of {list(STATUSES)}")
        due = clean_due(body.get("due_date"))
        try:
            tags = clean_tags(body.get("tags", []))
        except APIError as e:
            raise e
        est = clean_int(body.get("estimate_min"), "estimate_min",
                        minimum=1, maximum=100000)
        if not for_update or "project_id" in body:
            check_project_id(body.get("project_id") if not for_update else body.get("project_id"))
        return title, desc, prio, status, due, tags, est

    def create_task(self, body: Any) -> dict:
        conn = self.conn
        if not isinstance(body, dict):
            raise bad(422, "validation", "request body must be a JSON object")
        title = clean_str(body.get("title"), "title", required=True)
        desc = clean_str(body.get("description"), "description", limit=5000)
        prio = body.get("priority", "medium")
        if prio not in PRIORITIES:
            raise bad(422, "validation", f"priority must be one of {list(PRIORITIES)}")
        status = body.get("status", "todo")
        if status not in STATUSES:
            raise bad(422, "validation", f"status must be one of {list(STATUSES)}")
        due = clean_due(body.get("due_date"))
        try:
            tags = clean_tags(body.get("tags", []))
        except APIError:
            raise
        est = clean_int(body.get("estimate_min"), "estimate_min", minimum=1, maximum=100000)
        pid = body.get("project_id")
        check_project_id(pid)
        deps = clean_dep_ids(body.get("depends_on"))
        iso = _iso()
        cur = conn.execute(
            "INSERT INTO tasks(project_id,title,description,priority,status,"
            "archived,due_date,tags,estimate_min,version,created_at,updated_at) "
            "VALUES(?,?,?,?,?,0,?,?,?,1,?,?)",
            (pid, title, desc, prio, status, due, json.dumps(tags), est, iso, iso))
        tid = cur.lastrowid
        try:
            apply_deps(conn, tid, deps)
            subtasks = None if "subtasks" not in body else body.get("subtasks")
            set_subtasks(conn, tid, subtasks)
            conn.commit()
        except APIError:
            conn.rollback()
            raise
        r = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        return {"task": self.task_payload(r), "version": r["version"]}

    def update_task(self, request: Request, tid: int, body: Any) -> dict:
        conn = self.conn
        r = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        if not r:
            raise bad(404, "not_found", f"Task {tid} not found")
        require_if_match(request, r["version"], "task")
        if not isinstance(body, dict):
            raise bad(422, "validation", "request body must be a JSON object")
        title = clean_str(body.get("title"), "title", required=True)
        desc = clean_str(body.get("description"), "description", limit=5000)
        prio = body.get("priority", r["priority"])
        if prio not in PRIORITIES:
            raise bad(422, "validation", f"priority must be one of {list(PRIORITIES)}")
        status = body.get("status", r["status"])
        if status not in STATUSES:
            raise bad(422, "validation", f"status must be one of {list(STATUSES)}")
        due = clean_due(body.get("due_date") if "due_date" in body else r["due_date"])
        try:
            tags = clean_tags(body.get("tags") if "tags" in body else
                              json.loads(r["tags"] or "[]"))
        except APIError:
            raise
        est = clean_int(body.get("estimate_min") if "estimate_min" in body else r["estimate_min"],
                        "estimate_min", minimum=1, maximum=100000)
        pid = body.get("project_id", r["project_id"])
        if pid != r["project_id"]:
            check_project_id(pid)
        iso = _iso()
        try:
            conn.execute(
                "UPDATE tasks SET title=?,description=?,priority=?,status=?,"
                "due_date=?,tags=?,estimate_min=?,version=version+1,updated_at=? WHERE id=?",
                (title, desc, prio, status, due, json.dumps(tags), est, iso, tid))
            if "depends_on" in body:
                apply_deps(conn, tid, clean_dep_ids(body.get("depends_on")))
            if "subtasks" in body:
                set_subtasks(conn, tid, body.get("subtasks"))
            conn.commit()
        except APIError:
            conn.rollback()
            raise
        nr = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        return {"task": self.task_payload(nr), "version": nr["version"]}

    def set_task_archived(self, tid: int, archived: bool) -> dict:
        conn = self.conn
        r = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        if not r:
            raise bad(404, "not_found", f"Task {tid} not found")
        iso = _iso()
        conn.execute(
            "UPDATE tasks SET archived=?,version=version+1,updated_at=? WHERE id=?",
            (int(archived), iso, tid))
        conn.commit()
        nr = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        return {"task": self.task_payload(nr), "version": nr["version"]}

    def replace_subtasks(self, tid: int, body: Any) -> dict:
        conn = self.conn
        r = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        if not r:
            raise bad(404, "not_found", f"Task {tid} not found")
        if not isinstance(body, dict) or not isinstance(body.get("subtasks"), list):
            raise bad(422, "validation", 'body must be {"subtasks": [...]}')
        try:
            subs = set_subtasks(conn, tid, body["subtasks"])
            iso = _iso()
            conn.execute(
                "UPDATE tasks SET version=version+1,updated_at=? WHERE id=?", (iso, tid))
            conn.commit()
        except APIError:
            conn.rollback()
            raise
        nr = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        return {"subtasks": subs, "version": nr["version"]}

    # ------------------------------------------------------------ sessions

    def get_session(self) -> dict:
        conn = self.conn
        r = active_session(conn)
        if r:
            return {"session": session_dict(conn, r), "last": None}
        last = conn.execute(
            "SELECT * FROM time_sessions WHERE status='stopped' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return {"session": None,
                "last": session_dict(conn, last) if last else None}

    def session_action(self, action: str, body: Any) -> tuple[int, dict]:
        conn = self.conn
        r = active_session(conn)
        body = body if isinstance(body, dict) else {}
        if action == "start":
            if r:
                raise bad(409, "active_session",
                          f"A work session is already active (id {r['id']}). "
                          "Pause, resume, or stop it before starting another.",
                          active_session_id=r["id"])
            tid = clean_int(body.get("task_id"), "task_id", required=True)
            tr = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
            if not tr:
                raise bad(404, "not_found", f"Task {tid} not found")
            started = now_s()
            cur = conn.execute(
                "INSERT INTO time_sessions(task_id,project_id,started_at,total_paused_ms,status) "
                "VALUES(?,?,?,0,'running')", (tid, tr["project_id"], started))
            conn.commit()
            row = conn.execute("SELECT * FROM time_sessions WHERE id=?", (cur.lastrowid,)).fetchone()
            return 201, {"session": session_dict(conn, row)}
        if r is None:
            raise bad(404, "no_session", "No active work session to "
                     f"{action} — start one first")
        t = now_s()
        try:
            if action == "pause":
                if r["status"] != "running":
                    raise bad(409, "invalid_state", "Session is already paused")
                conn.execute(
                    "UPDATE time_sessions SET paused_at=?,status='paused' WHERE id=?",
                    (t, r["id"]))
            elif action == "resume":
                if r["status"] != "paused":
                    raise bad(409, "invalid_state", "Session is not paused")
                add_ms = int((t - r["paused_at"]) * 1000)
                conn.execute(
                    "UPDATE time_sessions SET status='running',paused_at=NULL,"
                    "total_paused_ms=total_paused_ms+? WHERE id=?", (add_ms, r["id"]))
            elif action == "stop":
                conn.execute(
                    "UPDATE time_sessions SET status='stopped',stopped_at=? WHERE id=?",
                    (t, r["id"]))
            else:
                raise bad(404, "not_found", f"Unknown session action: {action}")
            conn.commit()
        except APIError:
            conn.rollback()
            raise
        row = conn.execute("SELECT * FROM time_sessions WHERE id=?", (r["id"],)).fetchone()
        return 200, {"session": session_dict(conn, row)}

    # ------------------------------------------------------------ notes

    def list_notes(self, q: Optional[str] = None,
                   project_id: Optional[int] = None) -> dict:
        conn = self.conn
        rows = conn.execute("SELECT * FROM notes").fetchall()
        out = []
        for r in rows:
            if project_id is not None and r["project_id"] != project_id:
                continue
            if q and (q.lower() not in r["title"].lower()
                      and q.lower() not in r["body"].lower()):
                continue
            out.append(self._note_dict(r))
        out.sort(key=lambda n: n["id"], reverse=True)
        return {"notes": out, "total": len(out)}

    def _note_dict(self, r) -> dict:
        return {"id": r["id"], "project_id": r["project_id"], "title": r["title"],
                "body": r["body"], "version": r["version"],
                "created_at": r["created_at"], "updated_at": r["updated_at"]}

    def create_note(self, body: Any) -> dict:
        conn = self.conn
        if not isinstance(body, dict):
            raise bad(422, "validation", "request body must be a JSON object")
        pid = body.get("project_id")
        check_project_id(pid)
        title = clean_str(body.get("title"), "title", required=True)
        text = clean_str(body.get("body"), "body", limit=200000, default="")
        iso = _iso()
        cur = conn.execute(
            "INSERT INTO notes(project_id,title,body,version,created_at,updated_at) "
            "VALUES(?,?,?,1,?,?)", (pid, title, text, iso, iso))
        conn.commit()
        r = conn.execute("SELECT * FROM notes WHERE id=?", (cur.lastrowid,)).fetchone()
        return {"note": self._note_dict(r), "version": r["version"]}

    def update_note(self, request: Request, nid: int, body: Any) -> dict:
        conn = self.conn
        r = conn.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
        if not r:
            raise bad(404, "not_found", f"Note {nid} not found")
        require_if_match(request, r["version"], "note")
        if not isinstance(body, dict):
            raise bad(422, "validation", "request body must be a JSON object")
        title = clean_str(body.get("title", r["title"]), "title", required=True)
        text = clean_str(body.get("body", r["body"]), "body", limit=200000)
        iso = _iso()
        conn.execute(
            "UPDATE notes SET title=?,body=?,version=version+1,updated_at=? WHERE id=?",
            (title, text, iso, nid))
        conn.commit()
        nr = conn.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
        return {"note": self._note_dict(nr), "version": nr["version"]}

    def delete_note(self, nid: int) -> dict:
        r = self.conn.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
        if not r:
            raise bad(404, "not_found", f"Note {nid} not found")
        self.conn.execute("DELETE FROM notes WHERE id=?", (nid,))
        self.conn.commit()
        return {"deleted": nid}

    # ------------------------------------------------------------ time

    def time_report(self) -> dict:
        return time_breakdown(self.conn)


def _iso() -> str:
    from .db import utcnow_iso
    return utcnow_iso()


def check_project_id(pid: Any) -> None:
    if isinstance(pid, bool) or not isinstance(pid, int) or pid < 1:
        raise bad(422, "validation", "project_id must be a positive integer")


# ---------------------------------------------------------------- import/export


def _existing_map(conn) -> tuple[list[dict], list[dict]]:
    projects = [dict(r) for r in conn.execute("SELECT * FROM projects").fetchall()]
    tasks = [dict(r) for r in conn.execute("SELECT * FROM tasks").fetchall()]
    return projects, tasks


def validate_import_doc(doc: Any) -> tuple[list[dict], dict]:
    """Full schema validation. Returns (errors, data-or-empty)."""
    errors: list[dict] = []

    def err(path: str, message: str):
        errors.append({"path": path, "message": message})

    if not isinstance(doc, dict):
        err("$", "import document must be a JSON object")
        return errors, {}
    for key in ("app", "version", "exported_at"):
        if not isinstance(doc.get(key), str) or not doc.get(key):
            err(key, "missing or not a non-empty string")
    data = doc.get("data")
    if not isinstance(data, dict):
        err("data", "missing 'data' object")
        return errors, data or {}
    for coll in ("projects", "tasks", "subtasks", "task_deps", "notes", "time_sessions"):
        if not isinstance(data.get(coll, []), list):
            err(f"data.{coll}", "must be a list")
    for key in ("schema_version",):
        if not isinstance(doc.get(key), int):
            err(key, "must be an integer")
    if errors:
        return errors, data

    projects = data["projects"]
    tasks = data["tasks"]
    for i, p in enumerate(projects):
        if not isinstance(p, dict):
            err(f"data.projects[{i}]", "must be an object")
            continue
        if not isinstance(p.get("name"), str) or not p["name"].strip():
            err(f"data.projects[{i}].name", "must be a non-empty string")
        if not isinstance(p.get("id"), int):
            err(f"data.projects[{i}].id", "must be an integer")
    task_ids = set()
    for i, t in enumerate(tasks):
        if not isinstance(t, dict):
            err(f"data.tasks[{i}]", "must be an object")
            continue
        if not isinstance(t.get("id"), int):
            err(f"data.tasks[{i}].id", "must be an integer")
        else:
            task_ids.add(t["id"])
        if not isinstance(t.get("title"), str) or not t["title"].strip():
            err(f"data.tasks[{i}].title", "must be a non-empty string")
        pid = t.get("project_id")
        if isinstance(pid, int) and pid not in {p.get("id") for p in projects if isinstance(p, dict)}:
            err(f"data.tasks[{i}].project_id", f"{pid} not present in projects")
        if t.get("priority", "medium") not in PRIORITIES:
            err(f"data.tasks[{i}].priority", f"must be one of {list(PRIORITIES)}")
        if t.get("status", "todo") not in STATUSES:
            err(f"data.tasks[{i}].status", f"must be one of {list(STATUSES)}")
        due = t.get("due_date")
        if due is not None:
            try:
                clean_due(due)
            except APIError as e:
                err(f"data.tasks[{i}].due_date", e.message)
        try:
            clean_tags(t.get("tags", []))
        except APIError as e:
            err(f"data.tasks[{i}].tags", e.message)
        est = t.get("estimate_min")
        if est is not None and (isinstance(est, bool) or not isinstance(est, int) or est < 1):
            err(f"data.tasks[{i}].estimate_min", "must be a positive integer or null")
    for i, d in enumerate(data["task_deps"]):
        if not isinstance(d, dict):
            err(f"data.task_deps[{i}]", "must be an object with task_id/depends_on")
            continue
        a, b = d.get("task_id"), d.get("depends_on")
        if a not in task_ids or b not in task_ids:
            err(f"data.task_deps[{i}]", f"both task ids must exist in tasks")
        if a == b:
            err(f"data.task_deps[{i}]", "task cannot depend on itself")
    for i, s in enumerate(data["subtasks"]):
        if not isinstance(s, dict):
            err(f"data.subtasks[{i}]", "must be an object")
            continue
        if s.get("task_id") not in task_ids:
            err(f"data.subtasks[{i}].task_id", "must reference a task in this import")
        if not isinstance(s.get("title"), str) or not s["title"].strip():
            err(f"data.subtasks[{i}].title", "must be a non-empty string")
    project_ids = {p.get("id") for p in projects if isinstance(p, dict)}
    for i, n in enumerate(data["notes"]):
        if not isinstance(n, dict):
            err(f"data.notes[{i}]", "must be an object")
            continue
        if n.get("project_id") not in project_ids:
            err(f"data.notes[{i}].project_id", "must reference a project in this import")
        if not isinstance(n.get("title"), str) or not n["title"].strip():
            err(f"data.notes[{i}].title", "must be a non-empty string")
    for i, s in enumerate(data["time_sessions"]):
        if not isinstance(s, dict):
            err(f"data.time_sessions[{i}]", "must be an object")
            continue
        if s.get("task_id") not in task_ids or s.get("project_id") not in project_ids:
            err(f"data.time_sessions[{i}]", "task_id and project_id must reference imported records")
        if s.get("status") not in ("running", "paused", "stopped"):
            err(f"data.time_sessions[{i}].status", "must be running, paused, or stopped")
    return errors, data


def import_preview(conn, doc: Any) -> dict:
    errors, data = validate_import_doc(doc)
    summary: dict[str, Any] = {
        "incoming": {k: len(data.get(k, [])) for k in
                     ("projects", "tasks", "subtasks", "task_deps", "notes", "time_sessions")}
        if isinstance(data, dict) else {},
        "existing": {
            "projects": conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0],
            "tasks": conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0],
            "notes": conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0],
        },
    }
    duplicates: list[dict] = []
    if isinstance(data, dict):
        existing_projects = {p["name"].lower(): p["id"] for p in
                             _existing_project_rows(conn)}
        for p in data.get("projects", []):
            if not isinstance(p, dict):
                continue
            name = p.get("name")
            if isinstance(name, str) and name.lower() in existing_projects:
                duplicates.append({"kind": "project", "title": name, "incoming_id": p.get("id"),
                                   "existing_id": existing_projects[name.lower()]})
        existing_tasks = {(t["title"].lower(), t["project_id"]): t["id"]
                          for t in _existing_task_rows(conn)}
        incoming_pname: dict[int, str] = {p["id"]: p.get("name") for p in
                                          data.get("projects", []) if isinstance(p, dict)}
        name_to_incoming = {n.lower(): i for i, n in incoming_pname.items() if isinstance(n, str)}
        for t in data.get("tasks", []):
            if not isinstance(t, dict):
                continue
            title = t.get("title")
            pid = t.get("project_id")
            if isinstance(title, str):
                existing_key = next(
                    (k for k in existing_tasks
                     if k[0] == title.lower()
                     and (k[1] == pid or
                          _project_name(conn, k[1]) == incoming_pname.get(pid))),
                    None)
                if existing_key is not None:
                    duplicates.append({"kind": "task", "title": title,
                                       "incoming_id": t.get("id"),
                                       "existing_id": existing_tasks[existing_key]})
    return {"valid": not errors, "errors": errors, "summary": summary,
            "duplicates": duplicates, "will_replace_whole_workspace": True}


def _existing_project_rows(conn) -> list[dict]:
    return [dict(r) for r in conn.execute("SELECT * FROM projects").fetchall()]


def _existing_task_rows(conn) -> list[dict]:
    return [dict(r) for r in conn.execute("SELECT * FROM tasks").fetchall()]


def _project_name(conn, pid: Any) -> Optional[str]:
    r = conn.execute("SELECT name FROM projects WHERE id=?", (pid,)).fetchone()
    return r["name"] if r else None


def apply_import(conn, doc: Any) -> dict:
    errors, data = validate_import_doc(doc)
    if errors:
        raise bad(422, "import_failed",
                  "Import was not applied (validation failed). Fix the listed records and retry.",
                  errors=errors)
    projects = data["projects"]
    tasks = data["tasks"]
    conn.execute("BEGIN IMMEDIATE")
    try:
        for table in ("subtasks", "task_deps", "notes", "time_sessions", "tasks", "projects"):
            conn.execute(f"DELETE FROM {table}")
        def _b(v):
            return 1 if v else 0
        for p in projects:
            conn.execute(
                "INSERT INTO projects(id,name,description,color,archived,version,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (p["id"], p["name"], p.get("description", ""), p.get("color", "#6366f1"),
                 _b(p.get("archived")), int(p.get("version", 1)),
                 p.get("created_at") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                 p.get("updated_at") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
        for t in tasks:
            tags = t.get("tags", [])
            if isinstance(tags, str):
                try:
                    tags = json.loads(tags or "[]")
                except ValueError:
                    tags = []
            iso_default = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            conn.execute(
                "INSERT INTO tasks(id,project_id,title,description,priority,status,"
                "archived,due_date,tags,estimate_min,version,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (t["id"], t["project_id"], t["title"], t.get("description", ""),
                 t.get("priority", "medium"), t.get("status", "todo"),
                 _b(t.get("archived")), t.get("due_date"), json.dumps(tags),
                 t.get("estimate_min"), int(t.get("version", 1)),
                 t.get("created_at") or iso_default, t.get("updated_at") or iso_default))
        for d in data["task_deps"]:
            conn.execute("INSERT INTO task_deps(task_id,depends_on) VALUES(?,?)",
                         (d["task_id"], d["depends_on"]))
        for s in data["subtasks"]:
            conn.execute(
                "INSERT INTO subtasks(id,task_id,title,done,position) VALUES(?,?,?,?,?)",
                (s.get("id"), s["task_id"], s["title"],
                 1 if s.get("done") else 0, int(s.get("position", 0))))
        for n in data["notes"]:
            iso_default = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            conn.execute(
                "INSERT INTO notes(id,project_id,title,body,version,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (n["id"], n["project_id"], n["title"], n.get("body", ""),
                 int(n.get("version", 1)),
                 n.get("created_at") or iso_default,
                 n.get("updated_at") or iso_default))
        for s in data["time_sessions"]:
            conn.execute(
                "INSERT INTO time_sessions(id,task_id,project_id,started_at,paused_at,"
                "total_paused_ms,status,stopped_at) VALUES(?,?,?,?,?,?,?,?)",
                (s.get("id"), s["task_id"], s["project_id"],
                 float(s["started_at"]), s.get("paused_at"),
                 int(s.get("total_paused_ms", 0)), s.get("status", "stopped"),
                 s.get("stopped_at")))
        for table, colmax in (("projects", "MAX(id)"), ("tasks", "MAX(id)"),
                              ("notes", "MAX(id)"), ("subtasks", "MAX(id)"),
                              ("time_sessions", "MAX(id)")):
            conn.execute(
                f"UPDATE sqlite_sequence SET seq=COALESCE((SELECT {colmax} FROM {table}),0) "
                f"WHERE name=?", (table,))
        iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        conn.execute(
            "INSERT OR REPLACE INTO meta(key,value) VALUES('sample_seeded','1')")
        conn.execute(
            "INSERT OR REPLACE INTO meta(key,value) VALUES('last_import',?)", (iso,))
        conn.execute("ANALYZE")
        conn.commit()
    except APIError as e:
        conn.rollback()
        raise
    except sqlite3.Error as e:
        conn.rollback()
        raise bad(409, "db_error", f"Import failed and was rolled back: {e}") from e
    return {"imported": {
        "projects": len(projects), "tasks": len(tasks),
        "subtasks": len(data["subtasks"]), "task_deps": len(data["task_deps"]),
        "notes": len(data["notes"]), "time_sessions": len(data["time_sessions"]),
    }}


def export_doc(conn) -> dict:
    from .db import db_path
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return {
        "app": "projectdesk",
        "version": __version__,
        "schema_version": SCHEMA_VERSION,
        "exported_at": now,
        "data": {
            "projects": [dict(r) for r in conn.execute("SELECT * FROM projects ORDER BY id").fetchall()],
            "tasks": [dict(r) for r in conn.execute("SELECT * FROM tasks ORDER BY id").fetchall()],
            "task_deps": [dict(r) for r in conn.execute(
                "SELECT * FROM task_deps ORDER BY task_id, depends_on").fetchall()],
            "subtasks": [dict(r) for r in conn.execute(
                "SELECT * FROM subtasks ORDER BY id").fetchall()],
            "notes": [dict(r) for r in conn.execute("SELECT * FROM notes ORDER BY id").fetchall()],
            "time_sessions": [dict(r) for r in conn.execute(
                "SELECT * FROM time_sessions ORDER BY id").fetchall()],
        },
    }


def render_tasks_csv(conn, rows) -> Response:
    import csv as _csv
    import io as _io
    buf = _io.StringIO()
    w = _csv.writer(buf, lineterminator="\n")
    w.writerow(["id", "title", "description", "project", "priority", "status",
                "due_date", "tags", "estimate_min", "blocked",
                "created_at", "updated_at"])
    for r in rows:
        proj = conn.execute("SELECT name FROM projects WHERE id=?",
                            (r["project_id"],)).fetchone()
        blocked = any(
            (lambda dr: dr and (dr["status"] != "done" or dr["archived"]))(
                conn.execute("SELECT status,archived FROM tasks WHERE id=?",
                             (dep,)).fetchone())
            for dep in task_deps_for(conn, r["id"]))
        w.writerow([
            r["id"], r["title"], r["description"],
            proj["name"] if proj else "",
            r["priority"], r["status"], r["due_date"] or "",
            "; ".join(json.loads(r["tags"] or "[]")),
            r["estimate_min"] if r["estimate_min"] is not None else "",
            "yes" if blocked else "no",
            r["created_at"], r["updated_at"],
        ])
    return Response(
        buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="projectdesk-tasks.csv"'},
    )


# ---------------------------------------------------------------- router

def build_router() -> APIRouter:
    """Bind routes at app creation; conn is provided via app.state."""
    router = APIRouter()

    def conn_of(request: Request) -> sqlite3.Connection:
        # per-thread connection (a shared Connection used across threads
        # raises sqlite3.InterfaceError under concurrent requests)
        return thread_conn(getattr(request.app.state, "db_path", None))

    def _R(request: Request) -> R:
        return R(conn_of(request))

    @router.get("/api/health")
    def health(request: Request):
        return _R(request).health()

    @router.get("/api/state")
    def state(request: Request):
        return _R(request).state()

    @router.post("/api/sample-data")
    def sample(request: Request):
        return _R(request).sample()

    @router.get("/api/dashboard")
    def dashboard(request: Request):
        return _R(request).dashboard()

    # projects
    @router.get("/api/projects")
    def list_projects(request: Request,
                      archived: Optional[str] = None):
        return _R(request).list_projects(archived)

    @router.post("/api/projects", status_code=201)
    async def create_project(request: Request):
        body = await request.json()
        return _R(request).create_project(body)

    @router.put("/api/projects/{pid}")
    async def update_project(request: Request, pid: int):
        body = await request.json()
        return _R(request).update_project(request, pid, body)

    @router.post("/api/projects/{pid}/archive")
    def archive_project(request: Request, pid: int):
        return _R(request).set_archived(pid, True)

    @router.post("/api/projects/{pid}/restore")
    def restore_project(request: Request, pid: int):
        return _R(request).set_archived(pid, False)

    @router.delete("/api/projects/{pid}")
    def delete_project(request: Request, pid: int):
        return _R(request).delete_project(pid)

    # tasks
    @router.get("/api/tasks")
    def list_tasks(request: Request,
                   q: Optional[str] = None,
                   project_id: Optional[int] = None,
                   status: Optional[str] = None,
                   priority: Optional[str] = None,
                   tag: Optional[list[str]] = Query(default=None),
                   overdue: Optional[str] = None,
                   archived: Optional[str] = None):
        return _R(request).list_tasks(q, project_id, status, priority,
                                      tag, overdue, archived)

    @router.get("/api/tasks/export.csv")
    def export_csv(request: Request,
                   q: Optional[str] = None,
                   project_id: Optional[int] = None,
                   status: Optional[str] = None,
                   priority: Optional[str] = None,
                   tag: Optional[list[str]] = Query(default=None),
                   overdue: Optional[str] = None,
                   archived: Optional[str] = None):
        r = _R(request)
        rows = r.filtered_rows(q, project_id, status, priority, tag, overdue, archived)
        return render_tasks_csv(r.conn, rows)

    @router.post("/api/tasks", status_code=201)
    async def create_task(request: Request):
        body = await request.json()
        return _R(request).create_task(body)

    @router.get("/api/tasks/{tid}")
    def get_task(request: Request, tid: int):
        return _R(request).get_task(tid)

    @router.put("/api/tasks/{tid}")
    async def update_task(request: Request, tid: int):
        body = await request.json()
        return _R(request).update_task(request, tid, body)

    @router.post("/api/tasks/{tid}/archive")
    def archive_task(request: Request, tid: int):
        return _R(request).set_task_archived(tid, True)

    @router.post("/api/tasks/{tid}/restore")
    def restore_task(request: Request, tid: int):
        return _R(request).set_task_archived(tid, False)

    @router.put("/api/tasks/{tid}/subtasks")
    async def replace_subtasks(request: Request, tid: int):
        body = await request.json()
        return _R(request).replace_subtasks(tid, body)

    # sessions
    @router.get("/api/session")
    def get_session(request: Request):
        return _R(request).get_session()

    # compatibility alias: older clients poll /api/timer
    @router.get("/api/timer")
    def get_timer(request: Request):
        return _R(request).get_session()

    @router.post("/api/session/{action}")
    async def session_action(request: Request, action: str):
        try:
            body = await request.json()
        except Exception:
            body = {}
        status_code, payload = _R(request).session_action(action, body)
        return JSONResponse(payload, status_code=status_code)

    # notes
    @router.get("/api/notes")
    def list_notes(request: Request,
                   q: Optional[str] = None,
                   project_id: Optional[int] = None):
        return _R(request).list_notes(q, project_id)

    @router.post("/api/notes", status_code=201)
    async def create_note(request: Request):
        body = await request.json()
        return _R(request).create_note(body)

    @router.put("/api/notes/{nid}")
    async def update_note(request: Request, nid: int):
        body = await request.json()
        return _R(request).update_note(request, nid, body)

    @router.delete("/api/notes/{nid}")
    def delete_note(request: Request, nid: int):
        return _R(request).delete_note(nid)

    # import/export
    @router.get("/api/export")
    def export(request: Request):
        return export_doc(req_conn(request))

    @router.post("/api/import/preview", status_code=200)
    async def import_preview_route(request: Request):
        doc = await request.json()
        return import_preview(req_conn(request), doc)

    @router.post("/api/import")
    async def import_route(request: Request):
        doc = await request.json()
        return apply_import(req_conn(request), doc)

    return router


def req_conn(request: Request) -> sqlite3.Connection:
    return thread_conn(getattr(request.app.state, "db_path", None))
