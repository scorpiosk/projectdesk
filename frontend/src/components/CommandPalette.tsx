// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const store = useStore();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => store.set({ paletteOpen: false });

  const cmds = useMemo<Cmd[]>(() => {
    const go = (view: "dashboard" | "tasks" | "kanban" | "notes") => () => { store.setView(view); close(); };
    const base: Cmd[] = [
      { id: "dash", label: "Go to Dashboard", hint: "nav", run: go("dashboard") },
      { id: "tasks", label: "Go to Task list", hint: "nav", run: go("tasks") },
      { id: "kanban", label: "Go to Kanban", hint: "nav", run: go("kanban") },
      { id: "notes", label: "Go to Notes", hint: "nav", run: go("notes") },
      { id: "new-task", label: "Create task…", hint: "action", run: () => { store.set({ view: "tasks", taskEditor: { taskId: null, preset: {} } }); close(); } },
      { id: "new-proj", label: "Create project…", hint: "action", run: () => { store.set({ projectEditor: { projectId: null } }); close(); } },
      { id: "new-note", label: "Create note…", hint: "action", run: () => { store.setView("notes"); close(); } },
      { id: "data", label: "Open Data center (import/export)", hint: "action", run: () => { store.set({ dataOpen: true }); close(); } },
    ];
    const taskCmds: Cmd[] = store.tasks.slice(0, 40).filter((t) => !t.archived).map((t) => ({
      id: `task-${t.id}`,
      label: `Open task: ${t.title}`,
      hint: "task",
      run: () => { store.setView("tasks"); store.set({ taskEditor: { taskId: t.id, preset: {} } }); close(); },
    }));
    const projCmds: Cmd[] = store.projects.map((p) => ({
      id: `proj-${p.id}`,
      label: `Open project: ${p.name}`,
      hint: "project",
      run: () => { void store.setFilters({ project_id: String(p.id) }); store.setView("tasks"); close(); },
    }));
    return [...base, ...projCmds, ...taskCmds];
  }, [store]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return cmds.slice(0, 12);
    return cmds.filter((c) => c.label.toLowerCase().includes(needle)).slice(0, 12);
  }, [q, cmds]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter" && results[sel]) { e.preventDefault(); results[sel].run(); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command or search… (↑↓ to move, Enter to run, Esc to close)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          aria-label="Command input"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
        />
        <ul id="palette-list" className="palette-list" role="listbox" aria-label="Commands">
          {results.map((c, i) => (
            <li key={c.id}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? "pal-item active" : "pal-item"}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => { e.preventDefault(); c.run(); }}>
              <span>{c.label}</span>
              {c.hint && <span className="muted small">{c.hint}</span>}
            </li>
          ))}
          {results.length === 0 && <li className="pal-item muted">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}
