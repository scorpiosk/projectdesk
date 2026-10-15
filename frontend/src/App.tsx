// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { useStore } from "./state";
import type { View } from "./types";
import { Dashboard } from "./views/Dashboard";
import { TasksView } from "./views/TasksView";
import { Kanban } from "./views/Kanban";
import { NotesView } from "./views/NotesView";
import { CommandPalette } from "./components/CommandPalette";
import { DataCenter } from "./views/DataCenter";
import { TaskEditor } from "./views/TaskEditor";
import { ProjectEditor } from "./views/ProjectEditor";
import { Toasts } from "./components/Toasts";
import { Spinner } from "./components/Modal";

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "◧" },
  { id: "tasks", label: "Tasks", icon: "☑" },
  { id: "kanban", label: "Kanban", icon: "⫼" },
  { id: "notes", label: "Notes", icon: "✎" },
];

function useTheme() {
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme || "light");
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("projectdesk.theme", next);
    setTheme(next);
  };
  return { theme, toggle };
}

function Header() {
  const store = useStore();
  const { theme, toggle } = useTheme();
  return (
    <header className="topbar">
      <div className="brand" onClick={() => store.setView("dashboard")} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") store.setView("dashboard"); }}>
        <span className="brand-mark" aria-hidden>◈</span> ProjectDesk
      </div>
      <nav className="nav" aria-label="Primary">
        {NAV.map((n) => (
          <button key={n.id}
            className={store.view === n.id ? "nav-btn active" : "nav-btn"}
            aria-current={store.view === n.id ? "page" : undefined}
            onClick={() => store.setView(n.id)}>
            <span aria-hidden>{n.icon}</span> {n.label}
          </button>
        ))}
      </nav>
      <div className="topbar-actions">
        <button className="btn ghost" onClick={() => store.set({ paletteOpen: true })} title="Command palette (⌘K)">
          ⌘K <span className="muted">commands</span>
        </button>
        <button className="btn ghost" onClick={() => store.set({ dataOpen: true })}>Data</button>
        <button className="icon-btn" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </div>
    </header>
  );
}

export function App() {
  const store = useStore();
  const [search, setSearch] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => { void store.setFilters({ q: search }); }, 220);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  if (!store.booted) {
    return <div className="boot"><Spinner label="Starting ProjectDesk…" /></div>;
  }

  return (
    <div className="app">
      <Header />
      <div className="searchbar">
        <input
          className="search-input"
          placeholder="Search tasks, notes, tags…  (try: design, or #frontend)"
          value={search}
          aria-label="Search"
          onChange={(e) => setSearch(e.target.value)}
        />
        {store.bootError && (
          <span className="banner banner-err" role="alert">
            {store.bootError} — check that the backend is running on :8321.
          </span>
        )}
      </div>
      <main className="content" aria-live="polite">
        {store.view === "dashboard" && <Dashboard />}
        {store.view === "tasks" && <TasksView />}
        {store.view === "kanban" && <Kanban />}
        {store.view === "notes" && <NotesView />}
      </main>
      <footer className="footer">
        {store.health
          ? <>ProjectDesk v{store.health.version} · schema v{store.health.schema_version} · local SQLite</>
          : "ProjectDesk"}
        <span className="footer-right">
          {store.workspace && !store.workspace.workspace_empty
            ? `${store.projects.length} projects · ${store.notes.length} notes`
            : "local · private · no cloud"}
        </span>
      </footer>
      <Toasts />
      {store.paletteOpen && <CommandPalette />}
      {store.dataOpen && <DataCenter />}
      {store.taskEditor && <TaskEditor key={store.taskEditor.taskId ?? "new"} />}
      {store.projectEditor && <ProjectEditor key={store.projectEditor.projectId ?? "new"} />}
    </div>
  );
}
