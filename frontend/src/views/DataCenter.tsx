// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import { useRef, useState } from "react";
import { api } from "../api";
import { Modal } from "../components/Modal";
import { useStore } from "../state";

interface Preview {
  valid: boolean;
  errors: { path: string; message: string }[];
  duplicates: { kind: string; id: number; title: string }[];
  summary: { incoming?: Record<string, number> } & Record<string, unknown>;
  will_replace_whole_workspace: boolean;
}

export function DataCenter() {
  const store = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [doc, setDoc] = useState<unknown | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setLog(null);
    try {
      const out = await fn();
      await store.refreshAll();
      setLog(`${label} — done${typeof out === "object" ? "" : ""}`);
      store.toast("ok", `${label} complete`);
      if (label === "Import") { setDoc(null); setPreview(null); if (fileRef.current) fileRef.current.value = ""; }
    } catch (e) {
      setLog(`${label} failed: ${e instanceof Error ? e.message : "unknown error"}`);
      store.toast("err", e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy(false);
    }
  };

  const download = (url: string, filename: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const onFile = async (f: File | null) => {
    if (!f) return;
    try {
      const text = await f.text();
      const parsed = JSON.parse(text);
      setDoc(parsed);
      const p = await api.importPreview(parsed);
      setPreview(p);
    } catch (e) {
      setDoc(null);
      setPreview(null);
      store.toast("err", `Could not parse ${f.name}: ${e instanceof Error ? e.message : "invalid JSON"}`);
    }
  };

  return (
    <Modal title="Data — export, import, sample" onClose={() => store.set({ dataOpen: false })} wide>
      <div className="data-grid">
        <section className="card inner">
          <h3>Export</h3>
          <p className="muted small">Versioned JSON snapshot of the whole workspace, or a CSV of tasks with the current filters.</p>
          <div className="row">
            <button className="btn" disabled={busy}
              onClick={() => void run("Export", async () => {
                const d = await api.exportDoc();
                const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                download(url, `projectdesk-export-${new Date().toISOString().slice(0, 10)}.json`);
                URL.revokeObjectURL(url);
                return null;
              })}>
              ⬇ Download workspace (JSON)
            </button>
            <button className="btn" disabled={busy}
              onClick={() => download(api.tasksCsvUrl(store.filters), `projectdesk-tasks-${new Date().toISOString().slice(0, 10)}.csv`)}>
              ⬇ Tasks (CSV)
            </button>
          </div>
        </section>

        <section className="card inner">
          <h3>Import (replaces the whole workspace)</h3>
          <p className="muted small">Validates first; on any error the import rolls back and your current data is untouched.</p>
          <input ref={fileRef} type="file" accept="application/json,.json"
            aria-label="Import file"
            onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
          {preview && (
            <div className="import-preview">
              <p className={preview.valid ? "banner banner-ok" : "banner banner-err"} role="alert">
                {preview.valid
                  ? `Valid — ${preview.summary?.incoming?.tasks ?? 0} tasks, ${preview.summary?.incoming?.projects ?? 0} projects, ${preview.summary?.incoming?.notes ?? 0} notes will replace the current workspace.`
                  : `Invalid: ${preview.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join(" · ")}${preview.errors.length > 3 ? ` (+${preview.errors.length - 3} more)` : ""}`}
              </p>
              {preview.duplicates.length > 0 && (
                <ul className="small muted">
                  {preview.duplicates.slice(0, 6).map((d, i) => (
                    <li key={i}>duplicate {d.kind} — {d.title}</li>
                  ))}
                </ul>
              )}
              {preview.valid && (
                <button className="btn primary" disabled={busy}
                  onClick={() => doc && void run("Import", async () => { await api.importDoc(doc); return null; })}>
                  Confirm import
                </button>
              )}
            </div>
          )}
        </section>

        <section className="card inner">
          <h3>Sample workspace</h3>
          <p className="muted small">
            {store.workspace?.sample_seeded
              ? "Sample data is present. Reloading replaces all current data with the sample set."
              : "Loads 3 projects, 7 tasks, 3 notes and 6 time sessions so you can explore everything."}
          </p>
          <button className="btn" disabled={busy}
            onClick={() => {
              if (!window.confirm("Replace the entire workspace with the sample dataset?")) return;
              void run("Sample data", async () => { await api.sampleData(); return null; });
            }}>
            Load sample data
          </button>
        </section>
      </div>
      {log && <p className="small muted" role="status">{log}</p>}
    </Modal>
  );
}
