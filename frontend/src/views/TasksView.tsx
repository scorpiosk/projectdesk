// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import { useState } from "react";
import { api, ApiClientError } from "../api";
import { useStore } from "../state";
import {
  DEFAULT_FILTERS, PRIORITY_LABEL, PRIORITIES, STATUS_LABEL, STATUSES,
  fmtDate, type Task,
} from "../types";

function TaskRow({ task }: { task: Task }) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const proj = store.projects.find((p) => p.id === task.project_id)
    ?? store.archivedProjects.find((p) => p.id === task.project_id);
  const subsDone = task.subtasks.filter((s) => s.done).length;

  const quickStatus = (status: Task["status"]) => {
    void api.updateTask(task.id, { ...task, status }, task.version)
      .then((r) => { store.upsertTask(r.task); store.toast("ok", `Moved to ${STATUS_LABEL[status]}`); })
      .catch((e) => store.toast("err", e instanceof Error ? e.message : "Update failed"));
  };

  const toggleSub = (sub: { id: number; title: string; done: boolean }) => {
    const subtasks = task.subtasks.map((s) => (s.id === sub.id ? { ...s, done: !s.done } : s));
    void api.setSubtasks(task.id, subtasks)
      .then((r) => { store.upsertTask(r.task); })
      .catch((e) => store.toast("err", e instanceof Error ? e.message : "Subtask update failed"));
  };

  return (
    <li className={task.status === "done" ? "task-row done" : "task-row"}>
      <div className="task-main" role="button" tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}>
        <span className={`pri pri-${task.priority}`} title={`${PRIORITY_LABEL[task.priority]} priority`} aria-hidden>▮</span>
        <span className="task-title">{task.title}</span>
        {task.blocked && <span className="pill pill-block">blocked</span>}
        {task.due_date && task.status !== "done" && (
          <span className="due">{fmtDate(task.due_date)}</span>
        )}
        {task.tags.length > 0 && (
          <span className="tags">{task.tags.slice(0, 3).map((t) => <em key={t}>#{t}</em>)}</span>
        )}
        {task.subtasks.length > 0 && (
          <span className="muted small">☑ {subsDone}/{task.subtasks.length}</span>
        )}
        <span className="task-proj" style={{ color: proj?.color }}>{proj?.name}</span>
        <span className="row status-switch" onClick={(e) => e.stopPropagation()}>
          {STATUSES.map((st) => (
            <button key={st}
              className={task.status === st ? "seg active" : "seg"}
              aria-pressed={task.status === st}
              onClick={() => quickStatus(st)}>{STATUS_LABEL[st]}</button>
          ))}
        </span>
      </div>
      {open && (
        <div className="task-detail">
          {task.description && <p className="muted">{task.description}</p>}
          {task.subtasks.length > 0 && (
            <ul className="subs">
              {task.subtasks.map((s) => (
                <li key={s.id}>
                  <label>
                    <input type="checkbox" checked={s.done} onChange={() => toggleSub(s)} />
                    <span className={s.done ? "sub-done" : ""}>{s.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="row detail-actions">
            <button className="btn small" onClick={() => { store.set({ taskEditor: { taskId: task.id, preset: {} } }); setOpen(false); }}>
              Edit details
            </button>
            <button className="btn small ghost" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </li>
  );
}

export function TasksView() {
  const store = useStore();
  const f = store.filters;
  const setF = store.setFilters;
  const active = f.q || f.project_id || f.status || f.priority || f.tag || f.overdue || f.archived;

  return (
    <div className="list-view">
      <div className="filterbar" role="region" aria-label="Task filters">
        <select aria-label="Filter by project" value={f.project_id}
          onChange={(e) => void setF({ project_id: e.target.value })}>
          <option value="">All projects</option>
          {store.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select aria-label="Filter by status" value={f.status}
          onChange={(e) => void setF({ status: e.target.value })}>
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select aria-label="Filter by priority" value={f.priority}
          onChange={(e) => void setF({ priority: e.target.value })}>
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>
        <label className="chk">
          <input type="checkbox" checked={f.overdue === "true"}
            onChange={(e) => void setF({ overdue: e.target.checked ? "true" : "" })} />
          overdue
        </label>
        <label className="chk">
          <input type="checkbox" checked={f.archived === "true"}
            onChange={(e) => void setF({ archived: e.target.checked ? "true" : "" })} />
          archived
        </label>
        <select aria-label="Sort order" value={f.sort}
          onChange={(e) => void setF({ sort: e.target.value })}>
          <option value="updated">Recently updated</option>
          <option value="due">Due date</option>
          <option value="priority">Priority</option>
          <option value="created">Newest</option>
        </select>
        {active && (
          <button className="btn small ghost"
            onClick={() => void setF({ ...DEFAULT_FILTERS })}>Clear filters</button>
        )}
        <span className="spacer" />
        <span className="muted small">{store.tasks.length} shown</span>
        <button className="btn primary" onClick={() => store.set({ taskEditor: { taskId: null, preset: {} } })}>
          + Task
        </button>
      </div>

      {store.tasks.length === 0 ? (
        <div className="card empty">
          <p className="muted">
            {active ? "No tasks match the current filters." : "No tasks yet — create one, or load the sample workspace from the Data menu."}
          </p>
        </div>
      ) : (
        <ul className="task-list">
          {store.tasks.map((t) => <TaskRow key={t.id} task={t} />)}
        </ul>
      )}
    </div>
  );
}

export { ApiClientError };
