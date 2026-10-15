// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef,
} from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import { makeNoteControllerRegistry, type NoteControllerRegistry } from "./notescontroller";
import {
  DEFAULT_FILTERS,
  type DashboardStats, type Filters, type Note, type Project, type Session, type Task, type View,
} from "./types";

export interface Toast { id: number; kind: "ok" | "err"; msg: string; }

export interface StoreState {
  booted: boolean;
  bootError: string | null;
  health: { version: string; schema_version: number; db: string } | null;
  workspace: { sample_seeded: boolean; workspace_empty: boolean } | null;
  projects: Project[];
  archivedProjects: Project[];
  tasks: Task[];
  notes: Note[];
  session: Session | null;
  dashboard: DashboardStats | null;
  filters: Filters;
  view: View;
  tick: number;
  toasts: Toast[];
  paletteOpen: boolean;
  dataOpen: boolean;
  taskEditor: { taskId: number | null; preset: Partial<Task> } | null;
  projectEditor: { projectId: number | null } | null;
}

const initial: StoreState = {
  booted: false, bootError: null, health: null, workspace: null,
  projects: [], archivedProjects: [], tasks: [], notes: [],
  session: null, dashboard: null,
  filters: DEFAULT_FILTERS, view: "dashboard", tick: 0,
  toasts: [], paletteOpen: false, dataOpen: false,
  taskEditor: null, projectEditor: null,
};

type Action =
  | { type: "PATCH"; patch: Partial<StoreState> }
  | { type: "TOAST_ADD"; toast: Toast }
  | { type: "TOAST_DROP"; id: number }
  | { type: "TASK_UPSERT"; task: Task }
  | { type: "PROJECT_UPSERT"; project: Project }
  | { type: "NOTE_UPSERT"; note: Note }
  | { type: "NOTE_REMOVE"; id: number };

function reducer(state: StoreState, a: Action): StoreState {
  switch (a.type) {
    case "PATCH": return { ...state, ...a.patch };
    case "TOAST_ADD": return { ...state, toasts: [...state.toasts, a.toast] };
    case "TOAST_DROP": return { ...state, toasts: state.toasts.filter((t) => t.id !== a.id) };
    case "TASK_UPSERT": {
      const tasks = state.tasks.some((t) => t.id === a.task.id)
        ? state.tasks.map((t) => (t.id === a.task.id ? a.task : t))
        : [a.task, ...state.tasks];
      return { ...state, tasks };
    }
    case "PROJECT_UPSERT": {
      const key = a.project.archived ? "archivedProjects" : "projects";
      const other = a.project.archived ? "projects" : "archivedProjects";
      const list = (state[key] as Project[]).filter((p) => p.id !== a.project.id);
      return { ...state, [key]: [a.project, ...list], [other]: state[other] as Project[] };
    }
    case "NOTE_UPSERT": {
      const notes = state.notes.some((n) => n.id === a.note.id)
        ? state.notes.map((n) => (n.id === a.note.id ? a.note : n))
        : [a.note, ...state.notes];
      return { ...state, notes };
    }
    case "NOTE_REMOVE":
      return { ...state, notes: state.notes.filter((n) => n.id !== a.id) };
  }
}

let toastId = 1;

export interface Store extends StoreState {
  refreshProjects: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  refreshNotes: () => Promise<void>;
  refreshSession: () => Promise<void>;
  refreshDashboard: () => Promise<void>;
  refreshAll: () => Promise<void>;
  setFilters: (f: Partial<Filters>) => Promise<void>;
  setView: (v: View) => void;
  toast: (kind: "ok" | "err", msg: string) => void;
  dismissToast: (id: number) => void;
  upsertTask: (t: Task) => void;
  upsertProject: (p: Project) => void;
  upsertNote: (n: Note) => void;
  removeNote: (id: number) => void;
  /** Mark a note as gone (in-flight or completed delete) so late PUTs/flushes skip it. */
  markNoteGone: (id: number) => void;
  /** True if the note is already marked gone (delete in-flight or completed). */
  isNoteGone: (id: number) => boolean;
  /** One persistent controller per note ID, owned by this provider (serial saves, retained drafts). */
  noteControllers: NoteControllerRegistry;
  set: (patch: Partial<StoreState>) => void;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);

  // Keep latest committed state reachable from stable callbacks without
  // recreating them. Assigned during render so reads are always current.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Monotonic task-request generation shared by refreshTasks and setFilters so
  // stale in-flight responses never replace newer filtered results.
  const reqGenRef = useRef(0);

  // Note ids confirmed or in-flight for deletion; their late PUT completions
  // must not be re-inserted and unmount flushes must not resurrect them.
  const deletedNotesRef = useRef<Set<number>>(new Set());

  // One persistent controller per note ID, owned by this provider. Stable for
  // the lifetime of the provider so switching/remounting the same note reuses
  // its draft, version and serial save queue.
  const noteControllersRef = useRef<NoteControllerRegistry | null>(null);
  if (noteControllersRef.current === null) {
    noteControllersRef.current = makeNoteControllerRegistry({
      saved: (note) => {
        if (!deletedNotesRef.current.has(note.id)) dispatch({ type: "NOTE_UPSERT", note });
      },
      failed: (message) => toast("err", message),
      revived: (id) => { deletedNotesRef.current.delete(id); },
    });
  }
  const noteControllers = noteControllersRef.current;

  const set = useCallback((patch: Partial<StoreState>) => dispatch({ type: "PATCH", patch }), []);
  const toast = useCallback((kind: "ok" | "err", msg: string) => {
    const id = toastId++;
    dispatch({ type: "TOAST_ADD", toast: { id, kind, msg } });
    window.setTimeout(() => dispatch({ type: "TOAST_DROP", id }), 4200);
  }, []);

  const refreshProjects = useCallback(async () => {
    const [act, arch] = await Promise.all([api.projects(false), api.projects(true)]);
    set({ projects: act.projects, archivedProjects: arch.projects });
  }, [set]);

  const refreshTasks = useCallback(async () => {
    const gen = ++reqGenRef.current;
    const r = await api.tasks(stateRef.current.filters);
    if (gen !== reqGenRef.current) return;
    set({ tasks: r.tasks });
  }, [set]);

  const refreshNotes = useCallback(async () => {
    const r = await api.notes();
    set({ notes: r.notes });
  }, [set]);

  const refreshSession = useCallback(async () => {
    const r = await api.session();
    set({ session: r.session });
  }, [set]);

  const refreshDashboard = useCallback(async () => {
    const d = await api.dashboard();
    set({ dashboard: d });
  }, [set]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshProjects(), refreshTasks(), refreshNotes(), refreshSession(), refreshDashboard()]);
    const ws = await api.state();
    set({ workspace: { sample_seeded: ws.sample_seeded, workspace_empty: ws.workspace_empty } });
  }, [refreshProjects, refreshTasks, refreshNotes, refreshSession, refreshDashboard, set]);

  const setFilters = useCallback(async (f: Partial<Filters>) => {
    const filters = { ...stateRef.current.filters, ...f };
    // Update the ref before dispatching so an API call issued in the same tick
    // (e.g. refreshTasks) reads the merged filters, not the previous ones.
    stateRef.current = { ...stateRef.current, filters };
    const gen = ++reqGenRef.current;
    set({ filters });
    try {
      const r = await api.tasks(filters);
      if (gen !== reqGenRef.current) return;
      set({ tasks: r.tasks });
    } catch (e) {
      if (gen !== reqGenRef.current) return;
      toast("err", e instanceof Error ? e.message : "Filter failed");
    }
  }, [set, toast]);

  const setView = useCallback((v: View) => set({ view: v }), [set]);
  const upsertTask = useCallback((t: Task) => dispatch({ type: "TASK_UPSERT", task: t }), []);
  const upsertProject = useCallback((p: Project) => dispatch({ type: "PROJECT_UPSERT", project: p }), []);
  const upsertNote = useCallback((n: Note) => {
    if (deletedNotesRef.current.has(n.id)) return;
    dispatch({ type: "NOTE_UPSERT", note: n });
  }, []);
  const removeNote = useCallback((id: number) => {
    deletedNotesRef.current.add(id);
    dispatch({ type: "NOTE_REMOVE", id });
  }, []);
  const markNoteGone = useCallback((id: number) => {
    deletedNotesRef.current.add(id);
  }, []);
  const isNoteGone = useCallback((id: number) => deletedNotesRef.current.has(id), []);
  const dismissToast = useCallback((id: number) => dispatch({ type: "TOAST_DROP", id }), []);

  // boot
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const h = await api.health();
        if (!alive) return;
        set({ health: { version: h.version, schema_version: h.schema_version, db: h.db } });
        await refreshAll();
        if (alive) set({ booted: true });
      } catch (e) {
        if (alive) set({ booted: true, bootError: e instanceof Error ? e.message : "Backend unreachable" });
      }
    })();
    return () => { alive = false; };
  }, [refreshAll, set]);

  // 1s tick while a session is active so the timer display stays live
  useEffect(() => {
    if (!state.session || state.session.status === "stopped") return;
    const t = window.setInterval(() => set({ tick: Date.now() }), 1000);
    return () => window.clearInterval(t);
  }, [state.session, state.session?.status, set]);

  // command palette shortcut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Read the live state from the ref so rapid toggles always invert the
        // current value instead of re-opening from the stale initial value.
        set({ paletteOpen: !stateRef.current.paletteOpen });
      }
      if (e.key === "Escape") set({ paletteOpen: false, dataOpen: false, taskEditor: null, projectEditor: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set]);

  const value = useMemo<Store>(() => ({
    ...state,
    refreshProjects, refreshTasks, refreshNotes, refreshSession, refreshDashboard,
    refreshAll, setFilters, setView, toast, dismissToast,
    upsertTask, upsertProject, upsertNote, removeNote, markNoteGone, isNoteGone,
    noteControllers, set,
  }), [state, refreshProjects, refreshTasks, refreshNotes, refreshSession,
      refreshDashboard, refreshAll, setFilters, setView, toast, dismissToast,
      upsertTask, upsertProject, upsertNote, removeNote, markNoteGone, isNoteGone,
      noteControllers, set]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside provider");
  return s;
}

/** Recomputed live elapsed ms for an active session (timestamp-based, not tick-accumulated). */
export function liveElapsed(session: Session | null): number {
  if (!session) return 0;
  const now = Date.now();
  if (session.status === "paused" && session.paused_at) {
    return Math.max(0, Math.round(session.paused_at * 1000 - session.started_at * 1000 - session.total_paused_ms));
  }
  return Math.max(0, Math.round(now / 1000 - session.started_at) * 1000 - session.total_paused_ms);
}
