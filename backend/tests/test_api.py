# Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
"""ProjectDesk backend tests.

Run from backend/:  <workspace>/.venv/bin/python -m pytest tests/ -q
"""
from __future__ import annotations

import csv
import io
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

# ---------------------------------------------------------------- fixtures


@pytest.fixture
def db_path(tmp_path) -> str:
    return str(tmp_path / "test.db")


@pytest.fixture
def client(db_path):
    app = create_app(db_path)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def project(client) -> dict:
    r = client.post("/api/projects", json={"name": "Test Project"})
    assert r.status_code == 201
    return r.json()["project"]


def make_task(client, project_id, title="Task", **kw) -> dict:
    body = {"title": title, "project_id": project_id, **kw}
    r = client.post("/api/tasks", json=body)
    assert r.status_code == 201, r.text
    return r.json()["task"]


# ---------------------------------------------------------------- health


def test_health_endpoint(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["schema_version"] == 1
    assert body["tables"].get("tasks") == 0
    assert body["db"].endswith(".db")


# ---------------------------------------------------------------- cycles


def test_self_dependency_rejected_422(client, project):
    t = make_task(client, project["id"], "Selfy")
    r = client.put(f"/api/tasks/{t['id']}",
                   json={"title": "Selfy", "project_id": project["id"],
                         "depends_on": [t["id"]]},
                   headers={"If-Match": "1"})
    assert r.status_code == 422
    body = r.json()
    assert body["error"] == "cycle"
    assert body["cycle"] == [t["id"], t["id"]]


def test_indirect_dependency_cycle_rejected_409(client, project):
    a = make_task(client, project["id"], "A")
    b = make_task(client, project["id"], "B", depends_on=[a["id"]])
    c = make_task(client, project["id"], "C", depends_on=[b["id"]])
    # C already depends directly/indirectly on A; now A depends on C -> A->C->B->A
    r = client.put(f"/api/tasks/{a['id']}",
                   json={"title": "A", "project_id": project["id"],
                         "depends_on": [c["id"]]},
                   headers={"If-Match": "1"})
    assert r.status_code == 409
    body = r.json()
    assert body["error"] == "cycle"
    cyc = body["cycle"]
    assert cyc[0] == a["id"] and cyc[-1] == a["id"]
    assert set(cyc) == {a["id"], b["id"], c["id"]}


def test_blockers_reflected(client, project):
    a = make_task(client, project["id"], "Blocker")
    b = make_task(client, project["id"], "Blocked", depends_on=[a["id"]])
    assert b["blocked"] is True
    assert [x["id"] for x in b["blocked_by"]] == [a["id"]]
    # complete the blocker -> no longer blocked
    client.put(f"/api/tasks/{a['id']}",
               json={"title": "Blocker", "project_id": project["id"],
                     "status": "done"},
               headers={"If-Match": str(a["version"])})
    r = client.get(f"/api/tasks/{b['id']}")
    assert r.json()["task"]["blocked"] is False


# ---------------------------------------------------------------- filters


def test_combined_filters_and_overdue_boundaries(client, project):
    from datetime import date, timedelta
    today = date.today().isoformat()
    yest = (date.today() - timedelta(days=1)).isoformat()
    tom = (date.today() + timedelta(days=1)).isoformat()

    make_task(client, project["id"], "Overdue one", priority="high",
              tags=["a", "b"], due_date=yest)
    make_task(client, project["id"], "Due today", priority="high",
              tags=["a"], due_date=today)
    make_task(client, project["id"], "Due tomorrow", priority="low",
              tags=["b"], due_date=tom)
    make_task(client, project["id"], "Done overdue", priority="high",
              tags=["a"], due_date=yest, status="done")
    other = client.post("/api/projects", json={"name": "Other"}).json()["project"]
    make_task(client, other["id"], "Elsewhere", priority="high",
              tags=["a"], due_date=yest)

    def titles(resp):
        return {t["title"] for t in resp.json()["tasks"]}

    # combined: project + priority + tag
    r = client.get("/api/tasks", params={
        "project_id": project["id"], "priority": "high", "tag": ["a"]})
    assert r.status_code == 200
    assert titles(r) == {"Overdue one", "Due today", "Done overdue"}

    # combined + overdue (strict: due before today, not done)
    r = client.get("/api/tasks", params={
        "project_id": project["id"], "priority": "high", "tag": ["a"],
        "overdue": "true"})
    assert titles(r) == {"Overdue one"}
    assert "Due today" not in titles(r)
    assert "Done overdue" not in titles(r)

    # tag AND semantics + boundary: due tomorrow not overdue
    r = client.get("/api/tasks", params={"priority": "high", "tag": ["a", "b"]})
    assert titles(r) == {"Overdue one"}


# ---------------------------------------------------------------- sessions


def test_session_lifecycle_and_restart_recovery(db_path):
    app1 = create_app(db_path)
    with TestClient(app1) as c1:
        p = c1.post("/api/projects", json={"name": "P"}).json()["project"]
        t = make_task(c1, p["id"], "Work")

        # no session
        r = c1.get("/api/session")
        assert r.json()["session"] is None

        # start
        r = c1.post("/api/session/start", json={"task_id": t["id"]})
        assert r.status_code == 201
        session = r.json()["session"]
        assert session["task_id"] == t["id"]
        sid = session["id"]
        assert session["status"] == "running"
        assert session["elapsed_ms"] >= 0

        # only one active timer
        r = c1.post("/api/session/start", json={"task_id": t["id"]})
        assert r.status_code == 409
        assert r.json()["error"] == "active_session"

        # pause
        time.sleep(1.1)
        r = c1.post("/api/session/pause")
        assert r.status_code == 200
        paused_elapsed = r.json()["session"]["elapsed_ms"]
        assert paused_elapsed >= 1000
        assert r.json()["session"]["status"] == "paused"
        p2 = c1.post("/api/session/pause")
        assert p2.status_code == 409

        # pause holds elapsed
        time.sleep(0.8)
        r = c1.get("/api/session")
        held = r.json()["session"]["elapsed_ms"]
        assert abs(held - paused_elapsed) < 250

        # resume counts again
        r = c1.post("/api/session/resume")
        assert r.status_code == 200
        time.sleep(1.1)
        el = c1.get("/api/session").json()["session"]["elapsed_ms"]
        assert el >= held + 900

    # ---- "restart": brand-new app instance over the same SQLite file ----
    app2 = create_app(db_path)
    with TestClient(app2) as c2:
        r = c2.get("/api/session")
        s = r.json()["session"]
        assert s is not None
        assert s["id"] == sid
        assert s["status"] == "running"
        assert s["elapsed_ms"] >= 1000
        # stop works after restart too
        r = c2.post("/api/session/stop")
        assert r.status_code == 200
        assert r.json()["session"]["status"] == "stopped"
        assert r.json()["session"]["stopped_at"] > 0
        assert c2.get("/api/session").json()["session"] is None


# ---------------------------------------------------------------- conflicts


def test_conflicting_updates_two_clients(db_path):
    app = create_app(db_path)
    cA = TestClient(app)
    cB = TestClient(app)
    with cA, cB:
        p = cA.post("/api/projects", json={"name": "Shared"}).json()["project"]
        t = make_task(cA, p["id"], "Contested")
        v1 = t["version"]

        # B updates first (v1 -> v2)
        r = cB.put(f"/api/tasks/{t['id']}",
                   json={"title": "B version", "project_id": p["id"]},
                   headers={"If-Match": str(v1)})
        assert r.status_code == 200
        v2 = r.json()["version"]
        assert v2 == v1 + 1

        # A, still on v1, must get a conflict — not a silent overwrite
        r = cA.put(f"/api/tasks/{t['id']}",
                   json={"title": "A version", "project_id": p["id"]},
                   headers={"If-Match": str(v1)})
        assert r.status_code == 409
        assert r.json()["error"] == "conflict"
        assert r.json()["current_version"] == v2
        assert cA.get(f"/api/tasks/{t['id']}").json()["task"]["title"] == "B version"

        # A re-reads, then updates successfully
        fresh = cA.get(t["id"] and f"/api/tasks/{t['id']}").json()["task"]
        assert cA.put(f"/api/tasks/{t['id']}",
                      json={"title": "A version v2", "project_id": p["id"]},
                      headers={"If-Match": str(fresh["version"])}).status_code == 200
        assert cB.get(f"/api/tasks/{t['id']}").json()["task"]["title"] == "A version v2"

        # missing If-Match is rejected, not guessed
        r = cB.put(f"/api/tasks/{t['id']}",
                   json={"title": "no header", "project_id": p["id"]})
        assert r.status_code == 412


def test_note_conflict(client, project):
    r = client.post("/api/notes",
                    json={"project_id": project["id"], "title": "N", "body": "v1"})
    n = r.json()["note"]
    client.put(f"/api/notes/{n['id']}", json={"title": "N", "body": "v2"},
               headers={"If-Match": "1"})
    r = client.put(f"/api/notes/{n['id']}", json={"title": "N", "body": "v1 again?"},
                   headers={"If-Match": "1"})
    assert r.status_code == 409
    assert client.get(f"/api/notes").json()["notes"][0]["body"] == "v2"


# ---------------------------------------------------------------- archive


def test_archive_and_restore_preserve_data(client, project):
    t = make_task(client, project["id"], "Temp work")
    assert client.get("/api/tasks",
                      params={"q": "Temp"}).json()["total"] == 1
    r = client.post(f"/api/tasks/{t['id']}/archive")
    assert r.status_code == 200
    assert client.get("/api/tasks").json()["total"] == 0
    archived = client.get("/api/tasks", params={"archived": "true"}).json()
    assert archived["total"] == 1
    assert archived["tasks"][0]["id"] == t["id"]
    assert archived["tasks"][0]["archived"] is True
    r = client.post(f"/api/tasks/{t['id']}/restore")
    assert r.status_code == 200
    assert client.get("/api/tasks").json()["total"] == 1

    # project archive likewise
    t2 = make_task(client, project["id"], "Kept")
    assert client.post(f"/api/projects/{project['id']}/archive").status_code == 200
    assert client.get("/api/projects").json()["total"] == 0
    assert client.get("/api/projects", params={"archived": "true"}).json()["total"] == 1
    assert client.post(f"/api/projects/{project['id']}/restore").status_code == 200
    assert make_task(client, project["id"], "Still fine")["id"] > 0


def test_concurrent_requests_do_not_500(db_path):
    """Regression: one shared sqlite3 Connection served from several worker
    threads raised ``InterfaceError`` (dashboard 500s under concurrent load).
    Per-thread connections must keep every request green."""
    import asyncio

    import httpx
    from app.main import create_app

    app = create_app(db_path)
    with TestClient(app) as c:
        p = c.post("/api/projects", json={"name": "P"}).json()["project"]
        make_task(c, p["id"], "T")

    async def load() -> list[int]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as ac:
            tasks = [ac.get("/api/dashboard") for _ in range(16)]
            tasks += [ac.get("/api/tasks") for _ in range(16)]
            resp = await asyncio.gather(*tasks)
        return [r.status_code for r in resp]

    codes = asyncio.run(load())
    assert len(codes) == 32
    assert all(s == 200 for s in codes), codes


# ---------------------------------------------------------------- dashboard


def test_activity_summary_buckets_by_day(client, project, db_path):
    """Work must land in the day the session actually happened (regression:
    the apportion loop once bucketed sessions into the days *before* start)."""
    import sqlite3
    from datetime import date, timedelta

    t = make_task(client, project["id"], "Timed")
    assert client.post("/api/session/start", json={"task_id": t["id"]}).status_code == 201
    time.sleep(1.1)
    assert client.post("/api/session/stop").status_code == 200

    dash = client.get("/api/dashboard").json()
    assert len(dash["time"]["activity"]) == 7
    act = {row["date"]: row["seconds"] for row in dash["time"]["activity"]}
    today = date.today().strftime("%Y-%m-%d")
    assert act.get(today, 0.0) >= 1.0, act

    # a 2-hour session that ran 3 days ago must land on that day's bucket
    conn = sqlite3.connect(db_path)
    try:
        start = time.time() - 3 * 86400 - 3600  # 1h into that day
        conn.execute(
            "INSERT INTO time_sessions(task_id,project_id,started_at,paused_at,"
            "total_paused_ms,status,stopped_at) VALUES(?,?,?,NULL,0,'stopped',?)",
            (t["id"], project["id"], start, start + 7200))
        conn.commit()
    finally:
        conn.close()

    dash = client.get("/api/dashboard").json()
    act = {row["date"]: row["seconds"] for row in dash["time"]["activity"]}
    day3 = (date.today() - timedelta(days=3)).strftime("%Y-%m-%d")
    assert abs(act.get(day3, 0.0) - 7200.0) < 5.0, act
    assert act.get(today, 0.0) >= 1.0, act  # earlier work still present


# ---------------------------------------------------------------- import/export


def _workspace_doc(client) -> dict:
    r = client.get("/api/export")
    assert r.status_code == 200
    return r.json()


def test_export_import_roundtrip_preserves(db_path):
    app1 = create_app(db_path)
    with TestClient(app1) as c1:
        p1 = c1.post("/api/projects",
                     json={"name": "Alpha", "description": "d1",
                           "color": "#112233"}).json()["project"]
        p2 = c1.post("/api/projects", json={"name": "Beta"}).json()["project"]
        t1 = make_task(c1, p1["id"], "T1", priority="urgent", tags=["x", "y"],
                       estimate_min=45, description="d1")
        t2 = make_task(c1, p2["id"], "T2", depends_on=[t1["id"]],
                       status="in_progress")
        c1.put(f"/api/tasks/{t2['id']}/subtasks",
               json={"subtasks": [{"title": "s1", "done": True},
                                  {"title": "s2", "done": False}]})
        c1.post("/api/notes",
                json={"project_id": p2["id"], "title": "Note",
                      "body": "# hi\n\n- [ ] todo"})
        assert c1.post("/api/session/start",
                       json={"task_id": t1["id"]}).status_code == 201
        time.sleep(0.3)

        doc = _workspace_doc(c1)

    db2 = db_path + ".2"
    app2 = create_app(db2)
    with TestClient(app2) as c2:
        assert c2.get("/api/tasks").json()["total"] == 0
        r = c2.post("/api/import/preview", json=doc)
        assert r.status_code == 200
        pre = r.json()
        assert pre["valid"] is True
        assert pre["will_replace_whole_workspace"] is True

        r = c2.post("/api/import", json=doc)
        assert r.status_code == 200, r.text

        projects = c2.get("/api/projects").json()["projects"]
        assert {p["name"]: p["color"] for p in projects} == {
            "Alpha": "#112233", "Beta": "#6366f1"}

        tasks = {t["title"]: t for t in c2.get("/api/tasks").json()["tasks"]}
        assert tasks["T1"]["tags"] == ["x", "y"]
        assert tasks["T1"]["estimate_min"] == 45
        assert tasks["T1"]["priority"] == "urgent"
        assert tasks["T2"]["depends_on"] == [1]
        subs = tasks["T2"]["subtasks"]
        assert [s["title"] for s in subs] == ["s1", "s2"]
        assert subs[0]["done"] is True and subs[1]["done"] is False

        notes = c2.get("/api/notes").json()["notes"]
        assert len(notes) == 1 and notes[0]["body"].startswith("# hi")
        assert c2.get("/api/notes", params={"q": "todo"}).json()["total"] == 1

        s = c2.get("/api/session").json()["session"]
        assert s is not None and s["status"] == "running"
        assert s["elapsed_ms"] >= 100

        # still usable: new task ids continue after imported max
        nt = make_task(c2, projects[0]["id"], "Fresh")
        assert nt["id"] > 2


def test_import_rollback_on_invalid_record(client):
    # baseline workspace
    p = client.post("/api/projects", json={"name": "Keep"}).json()["project"]
    t = make_task(client, p["id"], "Keep me")
    baseline_tasks = {x["title"] for x in client.get("/api/tasks").json()["tasks"]}
    baseline_proj = {x["name"] for x in client.get("/api/projects").json()["projects"]}

    doc = _workspace_doc(client)
    # break one record: invalid priority on the second task position
    doc["data"]["tasks"][0]["priority"] = "critical"
    r = client.post("/api/import/preview", json=doc)
    assert r.status_code == 200
    assert r.json()["valid"] is False
    assert r.json()["errors"] and r.json()["errors"][0]["path"].startswith("data.tasks[0]")

    r = client.post("/api/import", json=doc)
    assert r.status_code == 422
    assert r.json()["error"] == "import_failed"
    assert len(r.json()["errors"]) >= 1

    # nothing changed — transaction rolled back completely
    assert {x["title"] for x in client.get("/api/tasks").json()["tasks"]} == baseline_tasks
    assert {x["name"] for x in client.get("/api/projects").json()["projects"]} == baseline_proj
    assert client.get(f"/api/tasks/{t['id']}").status_code == 200


def test_import_duplicate_detection(client, project):
    t = make_task(client, project["id"], "Dup target")
    doc = _workspace_doc(client)
    r = client.post("/api/import/preview", json=doc)
    assert r.status_code == 200
    pre = r.json()
    assert pre["valid"] is True
    kinds = {(d["kind"], d["title"]) for d in pre["duplicates"]}
    assert ("project", project["name"]) in kinds
    assert ("task", "Dup target") in kinds
    assert pre["summary"]["incoming"]["tasks"] == 1


def test_sample_data_only_flag(client):
    r = client.get("/api/state")
    assert r.json()["sample_seeded"] is False
    r = client.post("/api/sample-data")
    assert r.status_code == 200
    s = r.json()
    assert s["sample_seeded"] is True
    assert s["tasks"] == 7 and s["projects"] == 3 and s["notes"] == 3
    # sample data is coherent: blocked task has a real blocker
    tasks = {t["title"]: t for t in client.get("/api/tasks").json()["tasks"]}
    assert tasks["Design hero section"]["blocked"] is False
    assert tasks["Build design tokens"]["blocked"] is True
    assert tasks["Write journal post"]["blocked"] is False
    assert client.get("/api/session").json()["session"];  # one active timer
    # state reflects seeding
    assert client.get("/api/state").json()["workspace_empty"] is False


# ---------------------------------------------------------------- CSV


def test_csv_export_escaping(client, project):
    weird = make_task(
        client, project["id"], 'Title, with "quotes" and, commas',
        description='line one\nline "two"\nwith, commas')
    simple = make_task(client, project["id"], "Plain")
    r = client.get("/api/tasks/export.csv")
    assert r.status_code == 200
    assert "text/csv" in r.headers["content-type"]
    rows = list(csv.reader(io.StringIO(r.text)))
    header, data = rows[0], rows[1:]
    assert header[:4] == ["id", "title", "description", "project"]
    by_id = {int(row[0]): row for row in data}
    assert by_id[weird["id"]][1] == 'Title, with "quotes" and, commas'
    assert by_id[weird["id"]][2] == 'line one\nline "two"\nwith, commas'
    assert by_id[weird["id"]][3] == "Test Project"
    assert by_id[simple["id"]][1] == "Plain"
    # tags joined without breaking quoting
    assert by_id[weird["id"]][7] == ""
    make_task(client, project["id"], "Tagged, one")
    r2 = client.get("/api/tasks/export.csv", params={"q": "Tagged"})
    rows2 = list(csv.reader(io.StringIO(r2.text)))
    assert len(rows2) == 2
