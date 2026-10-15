// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import type {
  ApiError, DashboardStats, Filters, Note, Project, Session, Status, Task,
} from "./types";

const BASE = "/api";

export class ApiClientError extends Error {
  status: number;
  body: ApiError;
  constructor(status: number, body: ApiError) {
    super(body.message || `${status}`);
    this.status = status;
    this.body = body;
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    let body: ApiError = { error: "http_error", message: res.statusText };
    try { body = await res.json(); } catch { /* not json */ }
    throw new ApiClientError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function qs(params: Record<string, string | string[]>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === "" || v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => x && usp.append(k, x));
    else usp.set(k, v);
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

export function tasksQuery(f: Filters): string {
  return qs({
    q: f.q,
    project_id: f.project_id,
    status: f.status,
    priority: f.priority,
    tag: f.tag ? [f.tag] : [],
    overdue: f.overdue,
    archived: f.archived,
    sort: f.sort,
  });
}

export const api = {
  health: () => req<{ status: string; version: string; schema_version: number; db: string; tables: Record<string, number> }>("/health"),

  state: () => req<{ sample_seeded: boolean; workspace_empty: boolean; projects: number; tasks: number; notes: number; sessions: number }>("/state"),

  // projects
  projects: (archived?: boolean) =>
    req<{ projects: Project[]; total: number }>(`/projects${qs({ archived: archived == null ? "" : String(archived) })}`),
  createProject: (b: Partial<Project>) =>
    req<{ project: Project }>("/projects", { method: "POST", body: JSON.stringify(b) }),
  updateProject: (id: number, b: Partial<Project>, ifMatch: number) =>
    req<{ project: Project; version: number }>(`/projects/${id}`, {
      method: "PUT", body: JSON.stringify(b), headers: { "If-Match": String(ifMatch) },
    }),
  archiveProject: (id: number) => req<{ project: Project }>(`/projects/${id}/archive`, { method: "POST" }),
  restoreProject: (id: number) => req<{ project: Project }>(`/projects/${id}/restore`, { method: "POST" }),
  deleteProject: (id: number) => req<{ deleted: number; tasks_removed: number; notes_removed: number }>(`/projects/${id}`, { method: "DELETE" }),

  // tasks
  tasks: (f: Filters) => req<{ tasks: Task[]; total: number }>(`/tasks${tasksQuery(f)}`),
  task: (id: number) => req<{ task: Task }>(`/tasks/${id}`),
  createTask: (b: Partial<Task>) =>
    req<{ task: Task }>("/tasks", { method: "POST", body: JSON.stringify(b) }),
  updateTask: (id: number, b: Partial<Task>, ifMatch: number) =>
    req<{ task: Task; version: number }>(`/tasks/${id}`, {
      method: "PUT", body: JSON.stringify(b), headers: { "If-Match": String(ifMatch) },
    }),
  archiveTask: (id: number) => req<{ task: Task }>(`/tasks/${id}/archive`, { method: "POST" }),
  restoreTask: (id: number) => req<{ task: Task }>(`/tasks/${id}/restore`, { method: "POST" }),
  setSubtasks: (id: number, subtasks: { title: string; done: boolean }[]) =>
    req<{ task: Task }>(`/tasks/${id}/subtasks`, { method: "PUT", body: JSON.stringify({ subtasks }) }),
  tasksCsvUrl: (f: Filters) => `${BASE}/tasks/export.csv${tasksQuery(f)}`,

  // notes
  notes: (q?: string) => req<{ notes: Note[]; total: number }>(`/notes${qs({ q: q || "" })}`),
  createNote: (b: Partial<Note>) =>
    req<{ note: Note }>("/notes", { method: "POST", body: JSON.stringify(b) }),
  updateNote: (id: number, b: Partial<Note>, ifMatch: number) =>
    req<{ note: Note; version: number }>(`/notes/${id}`, {
      method: "PUT", body: JSON.stringify(b), headers: { "If-Match": String(ifMatch) },
    }),
  deleteNote: (id: number) => req<{ deleted: number }>(`/notes/${id}`, { method: "DELETE" }),

  // sessions
  session: () => req<{ session: Session | null }>("/session"),
  startSession: (task_id: number) =>
    req<{ session: Session }>("/session/start", { method: "POST", body: JSON.stringify({ task_id }) }),
  pauseSession: () => req<{ session: Session }>("/session/pause", { method: "POST" }),
  resumeSession: () => req<{ session: Session }>("/session/resume", { method: "POST" }),
  stopSession: () => req<{ session: Session }>("/session/stop", { method: "POST" }),

  // dashboard
  dashboard: () => req<DashboardStats>("/dashboard"),

  // data
  exportDoc: () => req<Record<string, unknown>>("/export"),
  importPreview: (doc: unknown) =>
    req<{ valid: boolean; errors: { path: string; message: string }[]; duplicates: { kind: string; id: number; title: string }[]; summary: { incoming?: Record<string, number> } & Record<string, unknown>; will_replace_whole_workspace: boolean }>(
      "/import/preview", { method: "POST", body: JSON.stringify(doc) }),
  importDoc: (doc: unknown) =>
    req<{ imported: Record<string, number> }>("/import", { method: "POST", body: JSON.stringify(doc) }),
  sampleData: () =>
    req<{ sample_seeded: boolean; projects: number; tasks: number; notes: number; sessions: number }>("/sample-data", { method: "POST" }),
};

export type { Status };
