// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
export type Priority = "low" | "medium" | "high" | "urgent";
export type Status = "todo" | "in_progress" | "done";

export interface Project {
  id: number;
  name: string;
  description: string;
  color: string;
  archived: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Subtask {
  id: number;
  title: string;
  done: boolean;
  position: number;
}

export interface Task {
  id: number;
  project_id: number;
  title: string;
  description: string;
  priority: Priority;
  status: Status;
  archived: boolean;
  due_date: string | null;
  tags: string[];
  estimate_min: number | null;
  version: number;
  depends_on: number[];
  blocked: boolean;
  blocked_by: number[];
  subtasks: Subtask[];
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: number;
  project_id: number;
  title: string;
  body: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: number;
  task_id: number;
  project_id: number;
  started_at: number;
  paused_at: number | null;
  total_paused_ms: number;
  status: "running" | "paused" | "stopped";
  stopped_at: number | null;
  elapsed_ms: number;
}

export interface DayActivity {
  date: string;
  seconds: number;
  active: boolean;
}

export interface DashboardStats {
  counts: {
    tasks_total: number;
    todo: number;
    in_progress: number;
    done: number;
    overdue: number;
    blocked: number;
    projects_active: number;
    projects_archived: number;
    notes: number;
    sessions: number;
  };
  time: {
    by_task: { task_id: number; task_title: string; project_id: number; project_name: string; seconds: number }[];
    by_project: { project_id: number; project_name: string; seconds: number }[];
    activity: DayActivity[];
  };
}

export interface ApiError {
  error: string;
  message: string;
  current_version?: number;
  cycle?: number[];
  errors?: { path: string; message: string }[];
}

export type View = "dashboard" | "tasks" | "kanban" | "notes";

export interface Filters {
  q: string;
  project_id: string;
  status: string;
  priority: string;
  tag: string;
  overdue: string;
  archived: string;
  sort: string;
}

export const DEFAULT_FILTERS: Filters = {
  q: "",
  project_id: "",
  status: "",
  priority: "",
  tag: "",
  overdue: "",
  archived: "",
  sort: "updated",
};

export const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];
export const STATUSES: Status[] = ["todo", "in_progress", "done"];

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};
export const STATUS_LABEL: Record<Status, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function fmtDate(d: string | null): string {
  if (!d) return "—";
  return d.slice(0, 10);
}
