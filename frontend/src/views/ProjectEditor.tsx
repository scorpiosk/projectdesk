// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import { useState } from "react";
import { api, ApiClientError } from "../api";
import { Modal } from "../components/Modal";
import { useStore } from "../state";
import type { Project } from "../types";

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#0ea5e9", "#a855f7", "#64748b"];

export function ProjectEditor() {
  const store = useStore();
  const spec = store.projectEditor!;
  const existing: Project | undefined = spec.projectId != null
    ? store.projects.find((p) => p.id === spec.projectId)
      ?? store.archivedProjects.find((p) => p.id === spec.projectId)
    : undefined;

  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [color, setColor] = useState(existing?.color ?? COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);

  const close = () => store.set({ projectEditor: null });

  const save = async () => {
    setBusy(true); setError(null);
    const body = { name: name.trim(), description, color };
    try {
      if (existing) {
        const r = await api.updateProject(existing.id, body, conflict ?? existing.version);
        store.upsertProject(r.project);
        store.toast("ok", "Project updated");
      } else {
        const r = await api.createProject(body);
        store.upsertProject(r.project);
        store.toast("ok", "Project created");
      }
      await store.refreshAll();
      close();
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 409 && e.body.current_version != null) {
        setConflict(e.body.current_version);
      } else {
        setError(e instanceof Error ? e.message : "Save failed");
      }
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!existing) return;
    if (!window.confirm(`Delete “${existing.name}” and all its tasks & notes?`)) return;
    setBusy(true);
    try {
      await api.deleteProject(existing.id);
      await store.refreshAll();
      store.toast("ok", "Project deleted");
      close();
    } catch (e) {
      store.toast("err", e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  };

  const setArchived = async (archived: boolean) => {
    if (!existing) return;
    setBusy(true);
    try {
      if (archived) await api.archiveProject(existing.id);
      else await api.restoreProject(existing.id);
      await store.refreshProjects();
      store.toast("ok", archived ? "Project archived" : "Project restored");
      close();
    } catch (e) {
      store.toast("err", e instanceof Error ? e.message : "Action failed");
      setBusy(false);
    }
  };

  return (
    <Modal title={existing ? `Edit project — ${existing.name}` : "New project"} onClose={close}>
      <div className="form">
        <label className="fld">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" autoFocus />
        </label>
        <label className="fld">
          <span>Description</span>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="fld">
          <span>Color</span>
          <div className="swatches" role="radiogroup" aria-label="Project color">
            {COLORS.map((c) => (
              <button key={c} role="radio" aria-checked={color === c}
                className={color === c ? "swatch active" : "swatch"}
                style={{ background: c }}
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        {conflict != null && (
          <p className="banner banner-warn" role="alert">
            Project changed elsewhere (server v{conflict}). Retry to overwrite, or close and reopen.
          </p>
        )}
        {error && <p className="banner banner-err" role="alert">{error}</p>}
        <div className="row modal-actions">
          <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            {existing ? "Save" : "Create"}
          </button>
          {existing && !existing.archived && (
            <button className="btn" disabled={busy} onClick={() => void setArchived(true)}>Archive</button>
          )}
          {existing?.archived && (
            <button className="btn" disabled={busy} onClick={() => void setArchived(false)}>Restore</button>
          )}
          {existing && (
            <button className="btn danger" disabled={busy} onClick={() => void remove()}>Delete</button>
          )}
          <button className="btn ghost" onClick={close}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
