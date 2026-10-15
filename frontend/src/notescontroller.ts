// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import { api, ApiClientError } from "./api";
import type { Note } from "./types";

export const AUTO_SAVE_MS = 1200;
type Hooks = { saved(note: Note): void; failed(message: string): void; revived(id: number): void };

/** Provider-owned draft and queue; editor remounts keep the same note identity. */
export interface NoteController {
  id: number;
  title: string;
  body: string;
  version: number;
  generation: number;
  ackGeneration: number;
  saving: boolean;
  queue: Promise<void>;
  conflictVersion: number | null;
  error: string | null;
  deleting: boolean;
  deleted: boolean;
  bump(): void;
  save(force?: boolean): Promise<void>;
  overwrite(): void;
  adoptLatest(note: Note): void;
  markDeleting(): void;
  commitDelete(): void;
  failDelete(): void;
  subscribe(fn: () => void): () => void;
  unsubscribe(fn: () => void): void;
  flushNow(): void;
}

function makeNoteController(note: Note, hooks: Hooks): NoteController {
  const listeners = new Set<() => void>();
  let timer: number | null = null;
  let lastSaved: Note | null = null;
  const notify = () => { for (const fn of [...listeners]) fn(); };
  const cancelTimer = () => {
    if (timer != null) window.clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    cancelTimer();
    if (c.deleted || c.deleting || c.conflictVersion != null) return;
    timer = window.setTimeout(() => { timer = null; void c.save(); }, AUTO_SAVE_MS);
  };

  const c: NoteController = {
    id: note.id, title: note.title, body: note.body, version: note.version,
    generation: 0, ackGeneration: 0, saving: false, queue: Promise.resolve(),
    conflictVersion: null, error: null, deleting: false, deleted: false,

    bump() {
      if (c.deleting || c.deleted) return;
      c.generation++;
      c.error = null;
      schedule(); // A conflict stays parked until an explicit user decision.
      notify();
    },

    save(force = false) {
      const job = c.queue.then(async () => {
        let forced = force;
        while (!c.deleting && !c.deleted && c.conflictVersion == null &&
               (forced || c.generation > c.ackGeneration)) {
          forced = false;
          const sentGeneration = c.generation;
          const payload = { title: c.title.trim() || "Untitled", body: c.body };
          c.saving = true;
          c.error = null;
          notify();
          try {
            const response = await api.updateNote(c.id, payload, c.version);
            if (c.deleted) return;
            c.version = response.version;
            c.ackGeneration = Math.max(c.ackGeneration, sentGeneration);
            lastSaved = response.note;
            if (!c.deleting) hooks.saved(response.note);
          } catch (error) {
            if (c.deleted) return;
            if (error instanceof ApiClientError && error.status === 409 && error.body.current_version != null) {
              c.conflictVersion = error.body.current_version;
            } else {
              c.error = error instanceof Error ? error.message : "Save failed";
              hooks.failed(c.error);
            }
            break; // Retain the draft; never spin on a failure or force a conflict.
          } finally {
            c.saving = false;
            notify();
          }
          // New edits use the returned version in the next serialized PUT.
        }
      });
      c.queue = job.catch(() => {});
      return job;
    },

    overwrite() {
      if (c.deleted || c.deleting) return;
      if (c.conflictVersion != null) c.version = c.conflictVersion;
      c.conflictVersion = null;
      c.error = null;
      cancelTimer();
      notify();
      void c.save(true);
    },

    adoptLatest(latest) {
      if (c.deleted || c.deleting) return;
      cancelTimer();
      c.title = latest.title;
      c.body = latest.body;
      c.version = latest.version;
      c.generation++;
      c.ackGeneration = c.generation;
      c.conflictVersion = null;
      c.error = null;
      lastSaved = latest;
      hooks.saved(latest);
      notify();
    },

    markDeleting() {
      c.deleting = true;
      cancelTimer();
      notify();
    },

    commitDelete() {
      c.deleted = true;
      c.deleting = false;
      cancelTimer();
      notify();
    },

    failDelete() {
      c.deleting = false;
      // A PUT may have succeeded while DELETE waited; publish its real version.
      if (lastSaved) hooks.saved(lastSaved);
      if (c.generation > c.ackGeneration) schedule();
      notify();
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },

    unsubscribe(fn) { listeners.delete(fn); },

    flushNow() {
      cancelTimer();
      if (!c.deleting && !c.deleted && c.conflictVersion == null && c.generation > c.ackGeneration) {
        void c.save();
      }
    },
  };
  return c;
}

export interface NoteControllerRegistry {
  get(id: number): NoteController | undefined;
  create(note: Note): NoteController;
}

export function makeNoteControllerRegistry(hooks: Hooks): NoteControllerRegistry {
  const controllers = new Map<number, NoteController>();
  return {
    get(id) {
      const controller = controllers.get(id);
      return controller?.deleted ? undefined : controller;
    },
    create(note) {
      const existing = controllers.get(note.id);
      if (existing && !existing.deleted) return existing;
      if (existing?.deleted) hooks.revived(note.id);
      const controller = makeNoteController(note, hooks);
      controllers.set(note.id, controller);
      return controller;
    },
  };
}
