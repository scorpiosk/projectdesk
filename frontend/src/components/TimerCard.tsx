// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import { useState } from "react";
import { api } from "../api";
import { liveElapsed, useStore } from "../state";
import { fmtDuration } from "../types";

/** Session timer card: live elapsed (timestamp-based), start / pause / resume / stop. */
export function TimerCard() {
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState("");
  const s = store.session;
  const elapsed = liveElapsed(s);
  const candidates = store.tasks.filter((t) => !t.archived);

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try {
      await fn();
      await Promise.all([store.refreshSession(), store.refreshDashboard()]);
      store.toast("ok", okMsg);
    } catch (e) {
      store.toast("err", e instanceof Error ? e.message : "Timer action failed");
    } finally {
      setBusy(false);
    }
  };

  const sPid = s?.project_id;
  const taskName = s ? candidates.find((t) => t.id === s.task_id)?.title : undefined;
  const projectName = sPid != null
    ? store.projects.find((p) => p.id === sPid)?.name
      ?? store.archivedProjects.find((p) => p.id === sPid)?.name
    : undefined;

  return (
    <section className="card timer-card" aria-label="Work session timer">
      <div className="card-head">
        <h3>Work session</h3>
        {s && s.status !== "stopped" && (
          <span className={`pill ${s.status === "running" ? "pill-run" : "pill-pause"}`}>
            {s.status === "running" ? "● running" : "❚❚ paused"}
          </span>
        )}
      </div>

      {s && s.status !== "stopped" ? (
        <>
          <div className="timer-digits" aria-live="off">{fmtDuration(elapsed)}</div>
          <div className="timer-meta">
            {taskName ?? `task #${s.task_id}`}
            {projectName && <span className="muted"> · {projectName}</span>}
            <span className="muted"> · since {new Date(s.started_at * 1000).toLocaleDateString()}</span>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {s.status === "running" ? (
              <button className="btn" disabled={busy}
                onClick={() => act(() => api.pauseSession(), "Session paused")}>⏸ Pause</button>
            ) : (
              <button className="btn primary" disabled={busy}
                onClick={() => act(() => api.resumeSession(), "Session resumed")}>▶ Resume</button>
            )}
            <button className="btn danger" disabled={busy}
              onClick={() => { if (window.confirm("Stop this session and record the time?")) void act(() => api.stopSession(), "Session stopped"); }}>
              ⏹ Stop
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">No active session. Pick a task to time — the clock survives refreshes and restarts.</p>
          <div className="row">
            <select aria-label="Task to time" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Select task…</option>
              {candidates.map((t) => (
                <option key={t.id} value={t.id}>
                  {store.projects.find((p) => p.id === t.project_id)?.name ?? "?"} — {t.title}
                </option>
              ))}
            </select>
            <button className="btn primary" disabled={busy || !pick}
              onClick={() => pick && act(() => api.startSession(Number(pick)), "Session started")}>
              ▶ Start
            </button>
          </div>
        </>
      )}
    </section>
  );
}
