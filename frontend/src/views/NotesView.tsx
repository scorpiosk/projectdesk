// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../state";
import { renderMarkdown } from "../markdown";
import { fmtDate, type Note } from "../types";

/**
 * Snapshot of the shared controller that drives this editor's UI. It is read on
 * each render and refreshed by the controller's subscription, so switching notes
 * and StrictMode's setup/cleanup/setup always reconnect cleanly instead of ever
 * permanently disabling UI updates.
 */
interface EditorState {
  title: string;
  body: string;
  version: number;
  saving: boolean;
  conflict: number | null;
  error: string | null;
  dirty: boolean;
}

function readState(title: string, body: string, version: number,
                   gen: number, ack: number, saving: boolean,
                   conflict: number | null, error: string | null): EditorState {
  return {
    title, body, version, saving, conflict, error,
    dirty: gen > ack,
  };
}

function NoteEditor({ note }: { note: Note }) {
  const store = useStore();
  const [mode, setMode] = useState<"write" | "preview">("write");

  // Bind to the one persistent controller for this note ID (owned by the
  // provider). If none exists yet, create it from the current note so a freshly
  // listed/created note starts from the server's version.
  const ctrl = store.noteControllers.get(note.id) ?? store.noteControllers.create(note);

  const [state, setState] = useState<EditorState>(() => readState(
    ctrl.title, ctrl.body, ctrl.version, ctrl.generation, ctrl.ackGeneration,
    ctrl.saving, ctrl.conflictVersion, ctrl.error,
  ));

  // Subscribe for rerenders and flush any pending draft on unmount. This is the
  // StrictMode-safe reconnect: cleanup only unsubscribes and flushes, so a
  // subsequent setup re-subscribes and restores the UI.
  useEffect(() => {
    const listener = () => {
      setState(readState(ctrl.title, ctrl.body, ctrl.version, ctrl.generation,
        ctrl.ackGeneration, ctrl.saving, ctrl.conflictVersion, ctrl.error));
    };
    ctrl.subscribe(listener);
    listener(); // Catch a completion between render and subscription setup.
    return () => {
      ctrl.unsubscribe(listener);
      ctrl.flushNow();
    };
  }, [note.id, ctrl]);

  const change = (which: "title" | "body", val: string) => {
    if (ctrl.deleting || ctrl.deleted) return;
    if (which === "title") ctrl.title = val;
    else ctrl.body = val;
    ctrl.bump();
  };

  const overwrite = () => { ctrl.overwrite(); };

  const reload = async () => {
    try {
      const list = await api.notes();
      if (ctrl.deleting || ctrl.deleted) return;
      const found = list.notes.find((n) => n.id === note.id);
      if (found) {
        ctrl.adoptLatest(found);
        store.toast("ok", "Reloaded latest note");
      }
    } catch (e) {
      store.toast("err", e instanceof Error ? e.message : "Reload failed");
    }
  };

  const { title, body, version, saving, conflict, error, dirty } = state;

  return (
    <div className="note-editor">
      <div className="note-toolbar">
        <input className="note-title" value={title} aria-label="Note title"
          onChange={(e) => change("title", e.target.value)} />
        <div className="seg-group" role="tablist" aria-label="Editor mode">
          <button role="tab" aria-selected={mode === "write"}
            className={mode === "write" ? "seg active" : "seg"}
            onClick={() => setMode("write")}>Write</button>
          <button role="tab" aria-selected={mode === "preview"}
            className={mode === "preview" ? "seg active" : "seg"}
            onClick={() => setMode("preview")}>Preview</button>
        </div>
        <span className="save-state">
          {saving ? "Saving…" : dirty ? "unsaved…" : "saved"}
        </span>
      </div>
      {conflict != null && (
        <p className="banner banner-warn" role="alert">
          This note was changed elsewhere (server v{conflict}, you edited v{version}).
          <span className="row">
            <button className="btn small" onClick={() => void reload()}>Load latest</button>
            <button className="btn small" onClick={overwrite}>Overwrite with mine</button>
          </span>
        </p>
      )}
      {error != null && conflict == null && (
        <p className="banner banner-warn" role="alert">{error}</p>
      )}
      {mode === "write" ? (
        <textarea className="note-body" value={body} aria-label="Note body (Markdown)"
          onChange={(e) => change("body", e.target.value)} />
      ) : (
        <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
      )}
    </div>
  );
}

export function NotesView() {
  const store = useStore();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<number | null>(store.notes[0]?.id ?? null);
  const [busy, setBusy] = useState(false);

  const list = store.notes.filter((n) =>
    !q || (n.title + " " + n.body).toLowerCase().includes(q.toLowerCase()));
  const current = store.notes.find((n) => n.id === sel) ?? list[0] ?? null;

  return (
    <div className="notes-layout">
      <aside className="note-list card" aria-label="Notes list">
        <div className="row" style={{ marginBottom: 8 }}>
          <input placeholder="Filter notes…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter notes" />
        </div>
        <ul>
          {list.map((n) => (
            <li key={n.id}>
              <button className={current?.id === n.id ? "note-item active" : "note-item"}
                onClick={() => setSel(n.id)}>
                <strong>{n.title}</strong>
                <span className="muted small">{fmtDate(n.updated_at)}</span>
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="muted small">No notes.</li>}
        </ul>
        <div className="row">
          <button className="btn small" disabled={busy}
            onClick={async () => {
              const project_id = store.projects[0]?.id;
              if (!project_id) { store.toast("err", "Create a project first"); return; }
              setBusy(true);
              try {
                const r = await api.createNote({ title: "Untitled note", body: "", project_id });
                store.upsertNote(r.note);
                setSel(r.note.id);
                store.toast("ok", "Note created");
              } catch (e) { store.toast("err", e instanceof Error ? e.message : "Create failed"); }
              finally { setBusy(false); }
            }}>
            + New note
          </button>
          {current && (
            <button className="btn small ghost" disabled={busy}
              onClick={async () => {
                if (!window.confirm(`Delete note “${current.title}”?`)) return;
                setBusy(true);
                const id = current.id;
                const ctrl =
                  store.noteControllers.get(id) ??
                  store.noteControllers.create(store.notes.find((n) => n.id === id)!);
                // Mark deleting and hold any debounced autosave; an already-running
                // PUT is allowed to finish (its upsert is ignored while deleting).
                ctrl.markDeleting();
                try {
                  await ctrl.queue;
                  await api.deleteNote(id);
                  ctrl.commitDelete();
                  store.markNoteGone(id);   // suppress any upsert of the removed note
                  store.removeNote(id);
                  setSel(null);             // falls back to first remaining note or empty
                  store.toast("ok", "Note deleted");
                } catch (e) {
                  // Deletion failed: keep the note and draft, clear the transient
                  // gone/gone-flag so a dirty draft may autosave again.
                  ctrl.failDelete();
                  store.toast("err", e instanceof Error ? e.message : "Delete failed");
                } finally {
                  setBusy(false);
                }
              }}>
              Delete
            </button>
          )}
        </div>
      </aside>
      <section className="note-main card" aria-label="Note editor">
        {current
          ? <NoteEditor key={current.id} note={current} />
          : <p className="muted">Select or create a note. Markdown supported: **bold**, *italic*, `code`, lists, - [ ] tasks, ``` fences.</p>}
      </section>
    </div>
  );
}
