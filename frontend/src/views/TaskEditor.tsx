// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import { useMemo, useState } from "react";
import { api, ApiClientError } from "../api";
import { Modal } from "../components/Modal";
import { useStore } from "../state";
import {
  PRIORITY_LABEL, PRIORITIES, STATUS_LABEL, STATUSES,
  type Priority, type Status, type Task,
} from "../types";

export function TaskEditor() {
  const store = useStore();
  const spec = store.taskEditor!;
  const existing: Task | undefined = spec.taskId
    ? store.tasks.find((t) => t.id === spec.taskId)
    : undefined;

  const [title, setTitle] = useState(existing?.title ?? spec.preset.title ?? "");
  const [project_id, setProjectId] = useState<number>(
    existing?.project_id ?? spec.preset.project_id ?? store.projects[0]?.id ?? 0);
  const [description, setDescription] = useState(existing?.description ?? "");
  const [priority, setPriority] = useState<Priority>(existing?.priority ?? "medium");
  const [status, setStatus] = useState<Status>(existing?.status ?? "todo");
  const [due, setDue] = useState(existing?.due_date ?? "");
  const [estimate, setEstimate] = useState(existing?.estimate_min?.toString() ?? "");
  const [tags, setTags] = useState(existing?.tags.join(", ") ?? "");
  const [deps, setDeps] = useState<number[]>(existing?.depends_on ?? []);
  const [subs, setSubs] = useState<{ title: string; done: boolean }[]>(
    (existing?.subtasks ?? []).map((s) => ({ title: s.title, done: s.done })));
  const [newSub, setNewSub] = useState("");
  const [cycleErr, setCycleErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allTasks = useMemo(
    () => store.tasks.filter((t) => !t.archived && (spec.taskId ? t.id !== spec.taskId : true)),
    [store.tasks, spec.taskId]);

  if (!existing && store.projects.length === 0) {
    return (
      <Modal title="New task" onClose={() => store.set({ taskEditor: null })}>
        <p className="muted">Create a project first (Data menu or Dashboard), then come back.</p>
      </Modal>
    );
  }

  const tagList = tags.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);

  const save = async () => {
    setBusy(true);
    setError(null);
    setCycleErr(null);
    const ifMatchVersion = conflict ?? existing?.version ?? 0;
    setConflict(null);
    const body: Record<string, unknown> = {
      title: title.trim(),
      project_id,
      description,
      priority,
      status,
      due_date: due || null,
      estimate_min: estimate ? Number(estimate) : null,
      tags: tagList,
      depends_on: deps,
      subtasks: subs,
    };
    try {
      if (existing) {
        const r = await api.updateTask(existing.id, body, ifMatchVersion);
        store.upsertTask(r.task);
        store.toast("ok", "Task updated");
      } else {
        const r = await api.createTask(body);
        store.upsertTask(r.task);
        store.toast("ok", "Task created");
      }
      await store.refreshDashboard();
      store.set({ taskEditor: null });
    } catch (e) {
      if (e instanceof ApiClientError && (e.status === 409 || e.status === 422) && e.body.cycle) {
        const names = e.body.cycle.map((id) =>
          allTasks.find((t) => t.id === id)?.title ?? store.tasks.find((t) => t.id === id)?.title ?? `task #${id}`);
        setCycleErr(`Dependency cycle: ${names.join(" → ")}. Fix the dependencies before saving.`);
      } else if (e instanceof ApiClientError && e.status === 409 && e.body.current_version != null) {
        setConflict(e.body.current_version);
      } else {
        setError(e instanceof Error ? e.message : "Save failed");
      }
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    if (!existing) return;
    try {
      const r = await api.task(existing.id);
      setTitle(r.task.title);
      setProjectId(r.task.project_id);
      setDescription(r.task.description);
      setPriority(r.task.priority);
      setStatus(r.task.status);
      setDue(r.task.due_date ?? "");
      setEstimate(r.task.estimate_min?.toString() ?? "");
      setTags(r.task.tags.join(", "));
      setDeps(r.task.depends_on);
      setSubs(r.task.subtasks.map((s) => ({ title: s.title, done: s.done })));
      store.upsertTask(r.task);
      setConflict(null);
      store.toast("ok", "Reloaded latest version");
    } catch (e) {
      store.toast("err", e instanceof Error ? e.message : "Reload failed");
    }
  };

  return (
    <Modal title={existing ? `Edit task — ${existing.title}` : "New task"}
      onClose={() => store.set({ taskEditor: null })} wide>
      <div className="form">
        <label className="fld">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" autoFocus />
        </label>
        <div className="fld-grid">
          <label className="fld">
            <span>Project</span>
            <select value={project_id} onChange={(e) => setProjectId(Number(e.target.value))}>
              {store.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="fld">
            <span>Priority</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </label>
          <label className="fld">
            <span>Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </label>
          <label className="fld">
            <span>Due date</span>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <label className="fld">
            <span>Estimate (min)</span>
            <input type="number" min={0} value={estimate} onChange={(e) => setEstimate(e.target.value)} />
          </label>
          <label className="fld">
            <span>Tags (comma-sep)</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="design, frontend" />
          </label>
        </div>
        <label className="fld">
          <span>Description</span>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>

        <div className="fld">
          <span>Depends on (blocked until these are done)</span>
          <div className="dep-list">
            {allTasks.map((t) => (
              <label key={t.id} className="chk">
                <input type="checkbox" checked={deps.includes(t.id)}
                  onChange={(e) => setDeps(e.target.checked ? [...deps, t.id] : deps.filter((d) => d !== t.id))} />
                {store.projects.find((p) => p.id === t.project_id)?.name} — {t.title}
              </label>
            ))}
            {allTasks.length === 0 && <span className="muted small">No other tasks to depend on.</span>}
          </div>
        </div>

        <div className="fld">
          <span>Subtasks</span>
          {subs.map((s, i) => (
            <div key={i} className="sub-edit">
              <input type="checkbox" checked={s.done}
                onChange={() => setSubs(subs.map((x, j) => j === i ? { ...x, done: !x.done } : x))} />
              <span className={s.done ? "sub-done" : ""}>{s.title}</span>
              <button className="icon-btn" aria-label="Delete subtask"
                onClick={() => setSubs(subs.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <div className="row">
            <input value={newSub} placeholder="Add a subtask…"
              onChange={(e) => setNewSub(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newSub.trim()) {
                  setSubs([...subs, { title: newSub.trim(), done: false }]);
                  setNewSub("");
                }
              }} />
            <button className="btn small" onClick={() => {
              if (newSub.trim()) { setSubs([...subs, { title: newSub.trim(), done: false }]); setNewSub(""); }
            }}>Add</button>
          </div>
        </div>

        {cycleErr && <p className="banner banner-err" role="alert">{cycleErr}</p>}
        {conflict != null && (
          <p className="banner banner-warn" role="alert">
            Someone else changed this task while you were editing (server is now v{conflict}, you edited v{existing?.version}).
            <span className="row">
              <button className="btn small" onClick={() => void reload()}>Load latest</button>
              <button className="btn small" onClick={() => { void save(); }}>Overwrite with mine</button>
            </span>
          </p>
        )}
        {error && <p className="banner banner-err" role="alert">{error}</p>}

        <div className="row modal-actions">
          <button className="btn primary" disabled={busy || !title.trim()} onClick={() => void save()}>
            {existing ? "Save changes" : "Create task"}
          </button>
          <button className="btn ghost" onClick={() => store.set({ taskEditor: null })}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
