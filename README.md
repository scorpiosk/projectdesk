<!-- Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT -->

# ProjectDesk

Created and maintained by **Sandip Kumar** · [scorpiosk@gmail.com](mailto:scorpiosk@gmail.com)
· [MIT license](LICENSE)

A local productivity workspace with projects, tasks, a Kanban board, Markdown notes and
a focus timer. React/TypeScript provides the interface; FastAPI and SQLite store the data.

Features include priorities, tags, due dates, subtasks, dependency-cycle checks, project
filters, archived work, optimistic concurrency, note autosave/conflict recovery, a
single active timer across tabs, dashboard activity, JSON import/export and CSV export.

## Run locally

Use Python 3.12 and Node.js 22 LTS (22.12 or later) with npm. The requirements pin
the tested release runtime; frontend dependencies are locked in package-lock.json.

```sh
git clone https://github.com/scorpiosk/projectdesk.git
cd projectdesk
python3.12 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
cd frontend
npm ci
npm run build
cd ../backend
../.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8321
```

Open http://127.0.0.1:8321. On Windows, use `.venv\Scripts\python` in place of
`.venv/bin/python` (and adjust the relative path after changing directories).

SQLite data is created locally at `data/projectdesk.db`. Set `PROJECTDESK_DB` to choose
another file. Existing personal databases, logs, model settings and environments are not
distributed. Use the built-in export before replacing a workspace. Sample-data loading and
workspace import can replace contents; use an empty database when exploring demonstrations.

For frontend development, run `npm run dev` in frontend while the backend runs on 8321.
Vite listens on 127.0.0.1:5173 and proxies `/api` to the backend.

## Verify

```sh
.venv/bin/python -m pip install -r backend/requirements-dev.txt
cd backend
PROJECTDESK_DB="$(mktemp -d)/projectdesk.db" ../.venv/bin/python -m pytest tests -q
cd ../frontend
npm test
npm run build
```

Backend tests use disposable SQLite fixtures. Frontend tests include the Markdown checks
and independent React regressions for filtering, shared note controllers, serialized saves,
StrictMode remounts, conflicts and deletion recovery. See [CONTRIBUTING.md](CONTRIBUTING.md).

This is a local application prototype. It has no authentication and currently uses
permissive CORS; keep it on loopback for a trusted local environment. See [SECURITY.md](SECURITY.md).
