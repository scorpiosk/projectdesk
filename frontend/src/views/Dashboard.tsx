// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../state";
import { TimerCard } from "../components/TimerCard";
import { Spinner } from "../components/Modal";

export function Dashboard() {
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const d = store.dashboard;

  useEffect(() => { void store.refreshDashboard(); /* eslint-disable-next-line */ }, []);

  if (!store.booted) return <Spinner />;

  if (store.workspace?.workspace_empty) {
    return (
      <div className="empty-hero card">
        <h1>Welcome to ProjectDesk</h1>
        <p className="muted">
          A local desk for your development projects, tasks, notes and work sessions.
          Everything stays in a private SQLite file on this machine.
        </p>
        <div className="row">
          <button className="btn primary" disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.sampleData();
                await store.refreshAll();
                store.toast("ok", "Sample workspace loaded");
              } catch (e) {
                store.toast("err", e instanceof Error ? e.message : "Seeding failed");
              } finally { setBusy(false); }
            }}>
            Load sample workspace
          </button>
          <button className="btn" onClick={() => store.set({ projectEditor: { projectId: null } })}>
            + New project
          </button>
        </div>
        {busy && <Spinner label="Seeding…" />}
      </div>
    );
  }

  if (!d) return <Spinner label="Building dashboard…" />;

  const c = d.counts;
  const days = d.time.activity;
  const maxDay = Math.max(1, ...days.map((r) => r.seconds));
  const totalSec = days.reduce((a, b) => a + b.seconds, 0);
  const overdueTasks = store.tasks.filter((t) => !t.archived && t.due_date && t.status !== "done"
    && t.due_date < new Date().toISOString().slice(0, 10)).slice(0, 6);

  return (
    <div className="dash">
      <div className="dash-row">
        <TimerCard />
        <section className="card" aria-label="Status overview">
          <div className="card-head"><h3>Status</h3></div>
          <div className="stat-grid">
            <div className="stat"><span className="stat-n">{c.in_progress}</span><span className="stat-l">in progress</span></div>
            <div className="stat"><span className="stat-n">{c.blocked}</span><span className="stat-l">blocked</span></div>
            <div className="stat"><span className="stat-n">{c.overdue}</span><span className="stat-l">overdue</span></div>
            <div className="stat"><span className="stat-n">{c.done}</span><span className="stat-l">done</span></div>
          </div>
        </section>
      </div>

      <div className="dash-row">
        <section className="card" aria-label="7 day activity">
          <div className="card-head"><h3>Activity — last 7 days</h3>
            <span className="muted">{Math.round(totalSec / 60)} min total</span>
          </div>
          <div className="bars" role="img"
            aria-label={days.map((r) => `${r.date}: ${Math.round(r.seconds / 60)} minutes`).join(", ")}>
            {days.map((r) => (
              <div key={r.date} className="bar-col">
                <div className="bar" style={{ height: `${Math.max(3, (r.seconds / maxDay) * 100)}%` }}
                  title={`${r.date} — ${Math.round(r.seconds / 60)} min`} />
                <span className="bar-l">{r.date.slice(5)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card" aria-label="Needs attention">
          <div className="card-head"><h3>Needs attention</h3></div>
          {c.blocked === 0 && c.overdue === 0 ? (
            <p className="muted">Nothing blocked, nothing overdue. 🎉</p>
          ) : (
            <ul className="attention">
              {store.tasks.filter((t) => t.blocked && !t.archived).slice(0, 4).map((t) => (
                <li key={t.id}>
                  <span className="pill pill-block">blocked</span> {t.title}
                  <span className="muted"> waiting on {t.blocked_by.length} task(s)</span>
                </li>
              ))}
              {overdueTasks.map((t) => (
                <li key={t.id}>
                  <span className="pill pill-over">overdue</span> {t.title}
                  <span className="muted"> due {t.due_date}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card" aria-label="Projects">
        <div className="card-head">
          <h3>Projects</h3>
          <button className="btn small" onClick={() => store.set({ projectEditor: { projectId: null } })}>+ New</button>
        </div>
        <div className="proj-grid">
          {store.projects.map((p) => {
            const pt = store.tasks.filter((t) => t.project_id === p.id && !t.archived);
            const done = pt.filter((t) => t.status === "done").length;
            const pct = pt.length ? Math.round((done / pt.length) * 100) : 0;
            return (
              <article key={p.id} className="proj" style={{ "--proj": p.color } as React.CSSProperties}>
                <div className="proj-head">
                  <span className="dot" aria-hidden />
                  <strong>{p.name}</strong>
                  <span className="proj-actions">
                    <button className="icon-btn" aria-label={`Edit ${p.name}`}
                      onClick={() => store.set({ projectEditor: { projectId: p.id } })}>✎</button>
                    <button className="icon-btn" aria-label={`Archive ${p.name}`}
                      onClick={async () => {
                        try {
                          await api.archiveProject(p.id);
                          await store.refreshProjects();
                          store.toast("ok", `${p.name} archived`);
                        } catch (e) { store.toast("err", e instanceof Error ? e.message : "Archive failed"); }
                      }}>⤵</button>
                  </span>
                </div>
                {p.description && <p className="muted small">{p.description}</p>}
                <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div style={{ width: `${pct}%` }} />
                </div>
                <span className="muted small">{done}/{pt.length} tasks done · {pct}%</span>
                {store.archivedProjects.length > 0 && p.id === store.projects[0]?.id && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn small ghost" onClick={async () => {
                      for (const ap of store.archivedProjects) {
                        try { await api.restoreProject(ap.id); } catch { /* keep going */ }
                      }
                      await store.refreshProjects();
                      store.toast("ok", "Archived projects restored");
                    }}>restore archived ({store.archivedProjects.length})</button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
