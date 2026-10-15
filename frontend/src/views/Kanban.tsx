// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import { useState } from "react";
import { api } from "../api";
import { useStore } from "../state";
import { PRIORITY_LABEL, STATUSES, STATUS_LABEL, type Status, type Task } from "../types";

function KanbanCard({ task, onMove }: { task: Task; onMove: (t: Task, to: Status) => void }) {
  const store = useStore();
  const idx = STATUSES.indexOf(task.status);
  const subsDone = task.subtasks.filter((s) => s.done).length;
  return (
    <div className="kanban-card" draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/task-id", String(task.id)); e.dataTransfer.effectAllowed = "move"; }}
      role="listitem"
      aria-label={`${task.title}, ${PRIORITY_LABEL[task.priority]} priority, ${STATUS_LABEL[task.status]}`}>
      <div className="kanban-card-top">
        <strong>{task.title}</strong>
        <span className={`pri pri-${task.priority}`} title={PRIORITY_LABEL[task.priority]} aria-hidden>▮</span>
      </div>
      {task.blocked && <span className="pill pill-block">blocked by {task.blocked_by.length}</span>}
      {task.tags.length > 0 && <span className="tags">{task.tags.map((t) => <em key={t}>#{t}</em>)}</span>}
      {task.subtasks.length > 0 && <span className="muted small">☑ {subsDone}/{task.subtasks.length}</span>}
      <div className="row kanban-actions">
        <button className="icon-btn" disabled={idx === 0}
          aria-label="Move to previous column"
          onClick={() => onMove(task, STATUSES[idx - 1])}>←</button>
        <button className="icon-btn" disabled={idx === STATUSES.length - 1}
          aria-label="Move to next column"
          onClick={() => onMove(task, STATUSES[idx + 1])}>→</button>
        <button className="icon-btn" aria-label="Edit task"
          onClick={() => store.set({ taskEditor: { taskId: task.id, preset: {} } })}>✎</button>
      </div>
    </div>
  );
}

export function Kanban() {
  const store = useStore();
  const [dragOver, setDragOver] = useState<Status | null>(null);

  const move = (t: Task, to: Status) => {
    void api.updateTask(t.id, { ...t, status: to }, t.version)
      .then((r) => { store.upsertTask(r.task); store.toast("ok", `${t.title} → ${STATUS_LABEL[to]}`); void store.refreshDashboard(); })
      .catch((e) => store.toast("err", e instanceof Error ? e.message : "Move failed"));
  };

  const inFilters = (t: Task) => {
    const f = store.filters;
    if (f.project_id && String(t.project_id) !== f.project_id) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.q && !(t.title + " " + t.description + " " + t.tags.join(" ")).toLowerCase().includes(f.q.toLowerCase())) return false;
    if (f.tag && !t.tags.includes(f.tag.replace(/^#/, ""))) return false;
    if (f.overdue === "true" && !(t.due_date && t.status !== "done" && t.due_date < new Date().toISOString().slice(0, 10))) return false;
    if (f.archived === "true" && !t.archived) return false;
    if (f.archived !== "true" && t.archived) return false;
    return true;
  };

  return (
    <div className="kanban" role="list" aria-label="Kanban board">
      {STATUSES.map((st) => {
        const cards = store.tasks.filter((t) => t.status === st && inFilters(t));
        return (
          <section key={st}
            className={dragOver === st ? "kanban-col over" : "kanban-col"}
            onDragOver={(e) => { e.preventDefault(); setDragOver(st); }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(null);
              const id = Number(e.dataTransfer.getData("text/task-id"));
              const t = store.tasks.find((x) => x.id === id);
              if (t && t.status !== st) move(t, st);
            }}>
            <header className="kanban-head">
              <h3>{STATUS_LABEL[st]}</h3>
              <span className="count">{cards.length}</span>
            </header>
            {cards.map((t) => <KanbanCard key={t.id} task={t} onMove={move} />)}
            {cards.length === 0 && <p className="muted small kanban-empty">drop tasks here</p>}
          </section>
        );
      })}
    </div>
  );
}
