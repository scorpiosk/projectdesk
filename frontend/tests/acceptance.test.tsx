// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import React, { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiClientError } from '../src/api';
import { StoreProvider, useStore, type Store } from '../src/state';
import { NotesView } from '../src/views/NotesView';

vi.mock('../src/api', async (load) => {
  const original = await load<typeof import('../src/api')>();
  return { ...original, api: Object.fromEntries(Object.keys(original.api).map(k => [k, vi.fn()])) };
});

let store: Store;
let persisted: any[];
let saves: {id: number; body: any; version: number}[];
const note = (id: number) => ({ id, project_id: 1, title: `Note ${id}`, body: `Original ${id}`, version: 1, created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' });
const task = (id: number, title: string) => ({ id, title, project_id: 1, status: 'todo', priority: 'medium', archived: false, due_date: null, tags: [], estimate_min: null, version: 1, depends_on: [], blocked: false, blocked_by: [], subtasks: [], description: '', created_at: '', updated_at: '' });
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: any) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
async function flush() { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); }
async function advance(ms = 1400) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function commit(id: number, body: any, version: number) {
  const existing = persisted.find(n => n.id === id);
  if (!existing) throw new ApiClientError(404, {error: 'not_found', message: 'Deleted note'});
  if (version !== existing.version) throw new ApiClientError(409, {error: 'conflict', message: 'Version conflict', current_version: existing.version});
  const next = {...existing, ...body, version: version + 1};
  persisted = persisted.map(n => n.id === id ? next : n);
  return {note: next, version: next.version};
}
function Probe({showNotes}: {showNotes: boolean}) {
  store = useStore();
  return <><output data-testid="boot">{String(store.booted)}</output>{showNotes && store.booted && <NotesView />}</>;
}
function tree(showNotes: boolean, strict = false) {
  const t = <StoreProvider><Probe showNotes={showNotes} /></StoreProvider>;
  return strict ? <StrictMode>{t}</StrictMode> : t;
}
async function mount(showNotes = false, strict = false) {
  const view = render(tree(showNotes, strict));
  await flush();
  expect(store.booted).toBe(true);
  return view;
}
function edit(text: string) { fireEvent.change(screen.getByLabelText('Note body (Markdown)'), {target: {value: text}}); }

beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  persisted = [note(1), note(2)]; saves = [];
  vi.mocked(api.health).mockResolvedValue({status: 'ok', version: '2', schema_version: 1, db: 'test-only', tables: {}});
  vi.mocked(api.state).mockResolvedValue({sample_seeded: false, workspace_empty: false, projects: 1, tasks: 0, notes: 2, sessions: 0});
  vi.mocked(api.projects).mockImplementation(async archived => ({projects: archived ? [] : [{id: 1, name: 'Project', description: '', color: '#fff', archived: false, version: 1, created_at: '', updated_at: ''}], total: archived ? 0 : 1}));
  vi.mocked(api.tasks).mockResolvedValue({tasks: [], total: 0});
  vi.mocked(api.notes).mockImplementation(async () => ({notes: persisted.map(n => ({...n})), total: persisted.length}));
  vi.mocked(api.session).mockResolvedValue({session: null});
  vi.mocked(api.dashboard).mockResolvedValue({counts: {tasks_total: 0, todo: 0, in_progress: 0, done: 0, overdue: 0, blocked: 0, projects_active: 1, projects_archived: 0, notes: 2, sessions: 0}, time: {by_task: [], by_project: [], activity: []}});
  vi.mocked(api.updateNote).mockImplementation(async (id, body, version) => {saves.push({id, body, version}); return commit(id, body, version);});
  vi.mocked(api.deleteNote).mockImplementation(async id => {persisted = persisted.filter(n => n.id !== id); return {deleted: id};});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(async () => { cleanup(); await flush(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Codex architect acceptance: current store and request ordering', () => {
  it('combines all sequential filters and refreshes with the current filters', async () => {
    await mount();
    for (const f of [{project_id: '7'}, {status: 'in_progress'}, {priority: 'high'}, {q: 'needle'}, {tag: 'frontend'}, {archived: 'true'}, {sort: 'due'}]) {
      await act(async () => {await store.setFilters(f);});
    }
    const expected = {project_id: '7', status: 'in_progress', priority: 'high', q: 'needle', tag: 'frontend', archived: 'true', sort: 'due'};
    expect(store.filters).toMatchObject(expected);
    await act(async () => {await store.refreshTasks();});
    expect(api.tasks).toHaveBeenLastCalledWith(expect.objectContaining(expected));
  });
  it('combines rapid filter updates before network requests finish', async () => {
    await mount();
    const a = deferred(), b = deferred();
    vi.mocked(api.tasks).mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    let p: Promise<any>, q: Promise<any>;
    act(() => {p = store.setFilters({project_id: '7'}); q = store.setFilters({status: 'done'});});
    expect(api.tasks).toHaveBeenLastCalledWith(expect.objectContaining({project_id: '7', status: 'done'}));
    await act(async () => {a.resolve({tasks: [], total: 0}); b.resolve({tasks: [], total: 0}); await Promise.all([p!, q!]);});
  });
  it('keeps newer filtered results when an older request resolves last', async () => {
    await mount();
    const older = deferred(), newer = deferred();
    vi.mocked(api.tasks).mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    let p: Promise<any>, q: Promise<any>;
    act(() => {p = store.setFilters({q: 'old'});});
    act(() => {q = store.setFilters({q: 'new'});});
    await act(async () => {newer.resolve({tasks: [task(2, 'new result')], total: 1}); await q!;});
    await act(async () => {older.resolve({tasks: [task(1, 'old result')], total: 1}); await p!;});
    expect(store.tasks.map(t => t.title)).toEqual(['new result']);
  });
  it('toggles the command palette repeatedly through the keyboard', async () => {
    await mount();
    fireEvent.keyDown(window, {key: 'k', ctrlKey: true}); expect(store.paletteOpen).toBe(true);
    fireEvent.keyDown(window, {key: 'k', ctrlKey: true}); expect(store.paletteOpen).toBe(false);
  });
  it('does not let an older refresh replace newer filtered results', async () => {
    await mount(); const oldRefresh = deferred(), newFilter = deferred();
    vi.mocked(api.tasks).mockImplementationOnce(() => oldRefresh.promise).mockImplementationOnce(() => newFilter.promise);
    let p: Promise<any>, q: Promise<any>;
    act(() => {p = store.refreshTasks();});
    act(() => {q = store.setFilters({q: 'latest'});});
    await act(async () => {newFilter.resolve({tasks: [task(2, 'latest result')], total: 1}); await q!;});
    await act(async () => {oldRefresh.resolve({tasks: [task(1, 'stale refresh')], total: 1}); await p!;});
    expect(store.tasks.map(t => t.title)).toEqual(['latest result']);
  });
});

describe('Codex architect acceptance: durable note editing', () => {
  it('persists edits made during a save using its returned version, without concurrent PUTs', async () => {
    await mount(true);
    const gate = deferred<void>(); let active = 0, maxActive = 0;
    vi.mocked(api.updateNote).mockImplementation(async (id, body, version) => {
      saves.push({id, body, version}); active++; maxActive = Math.max(maxActive, active);
      if (saves.length === 1) await gate.promise;
      try {return commit(id, body, version);} finally {active--;}
    });
    edit('Draft A'); await advance(); expect(saves).toHaveLength(1);
    edit('Draft B'); await advance(); expect(saves).toHaveLength(1);
    await act(async () => {gate.resolve();}); await flush(); await advance();
    expect(persisted[0].body).toBe('Draft B');
    expect(saves.map(x => x.version)).toEqual([1, 2]); expect(maxActive).toBe(1);
    expect((screen.getByLabelText('Note body (Markdown)') as HTMLTextAreaElement).value).toBe('Draft B');
  });
  it('flushes the latest draft on note switch before debounce expiry, under StrictMode', async () => {
    await mount(true, true); edit('Quick navigation draft');
    fireEvent.click(screen.getByRole('button', {name: /Note 2/})); await flush(); await advance();
    expect(persisted.find(n => n.id === 1).body).toBe('Quick navigation draft');
    expect(persisted.find(n => n.id === 2).body).toBe('Original 2');
    expect((screen.getByLabelText('Note body (Markdown)') as HTMLTextAreaElement).value).toBe('Original 2');
  });
  it('flushes when leaving Notes before debounce expiry', async () => {
    const view = await mount(true); edit('Leave-view draft');
    view.rerender(tree(false)); await flush(); await advance();
    expect(persisted[0].body).toBe('Leave-view draft');
  });
  it('finishes queued edits for the original note after switching during an in-flight save', async () => {
    await mount(true); const gate = deferred<void>();
    vi.mocked(api.updateNote).mockImplementationOnce(async (id, body, version) => {saves.push({id, body, version}); await gate.promise; return commit(id, body, version);});
    edit('Before-flight'); await advance(); edit('During-flight');
    fireEvent.click(screen.getByRole('button', {name: /Note 2/})); await flush();
    await act(async () => {gate.resolve();}); await flush(); await advance();
    expect(persisted.find(n => n.id === 1).body).toBe('During-flight');
    expect(persisted.find(n => n.id === 2).body).toBe('Original 2');
  });
  it('retains a conflict draft and explicit overwrite uses the current server version', async () => {
    await mount(true); persisted[0] = {...persisted[0], body: 'Other editor', version: 2};
    edit('My conflicted draft'); await advance();
    expect((screen.getByLabelText('Note body (Markdown)') as HTMLTextAreaElement).value).toBe('My conflicted draft');
    expect(screen.getByRole('alert').textContent).toMatch(/changed|conflict/i);
    const count = api.updateNote.mock.calls.length; await advance(5000); expect(api.updateNote.mock.calls.length).toBe(count);
    fireEvent.click(screen.getByRole('button', {name: 'Overwrite with mine'})); await flush(); await advance();
    expect(persisted[0].body).toBe('My conflicted draft'); expect(saves.at(-1)?.version).toBe(2);
  });
  it('reloads a conflict only on explicit user choice', async () => {
    await mount(true); persisted[0] = {...persisted[0], body: 'Other editor', version: 2};
    edit('My draft'); await advance(); fireEvent.click(screen.getByRole('button', {name: 'Load latest'})); await flush();
    expect((screen.getByLabelText('Note body (Markdown)') as HTMLTextAreaElement).value).toBe('Other editor');
    expect(persisted[0].body).toBe('Other editor');
  });
  it('preserves the dirty draft when saving fails', async () => {
    await mount(true); vi.mocked(api.updateNote).mockRejectedValue(new Error('Network unavailable'));
    edit('Retain on failure'); await advance();
    expect((screen.getByLabelText('Note body (Markdown)') as HTMLTextAreaElement).value).toBe('Retain on failure');
    expect(persisted[0].body).toBe('Original 1');
    expect(store.toasts.some(t => t.kind === 'err')).toBe(true);
  });
  it('removes a successfully deleted note from shared state and editor immediately', async () => {
    await mount(true); fireEvent.click(screen.getByRole('button', {name: 'Delete', exact: true})); await flush();
    expect(store.notes.map(n => n.id)).toEqual([2]);
    expect(screen.queryByRole('button', {name: /Note 1/})).toBeNull();
    expect((screen.getByLabelText('Note body (Markdown)') as HTMLTextAreaElement).value).toBe('Original 2');
  });
  it('keeps a note visible when deletion fails', async () => {
    await mount(true); vi.mocked(api.deleteNote).mockRejectedValue(new Error('Delete failed'));
    fireEvent.click(screen.getByRole('button', {name: 'Delete', exact: true})); await flush();
    expect(store.notes.map(n => n.id)).toEqual([1, 2]); expect(persisted.map(n => n.id)).toEqual([1, 2]);
    expect((screen.getByLabelText('Note body (Markdown)') as HTMLTextAreaElement).value).toBe('Original 1');
    expect(store.toasts.some(t => t.kind === 'err')).toBe(true);
  });
  it('does not issue an autosave after deleting a dirty note before debounce', async () => {
    await mount(true); edit('Must not return after deletion');
    fireEvent.click(screen.getByRole('button', {name: 'Delete', exact: true})); await flush(); await advance(5000);
    expect(store.notes.map(n => n.id)).toEqual([2]); expect(persisted.map(n => n.id)).toEqual([2]);
    expect(api.updateNote).not.toHaveBeenCalled();
  });
  it('keeps a deleted note removed when its already-running save finishes', async () => {
    await mount(true); const gate = deferred<void>();
    vi.mocked(api.updateNote).mockImplementationOnce(async (id, body, version) => {saves.push({id, body, version}); await gate.promise; return commit(id, body, version);});
    edit('Pending save'); await advance();
    fireEvent.click(screen.getByRole('button', {name: 'Delete', exact: true})); await flush();
    await act(async () => {gate.resolve();}); await flush(); await advance();
    expect(persisted.map(n => n.id)).toEqual([2]); expect(store.notes.map(n => n.id)).toEqual([2]);
    expect((screen.getByLabelText('Note body (Markdown)') as HTMLTextAreaElement).value).toBe('Original 2');
  });
  it('shows an empty editor state after deleting the last note', async () => {
    persisted = [note(1)]; await mount(true);
    fireEvent.click(screen.getByRole('button', {name: 'Delete', exact: true})); await flush();
    expect(store.notes).toEqual([]); expect(screen.queryByLabelText('Note body (Markdown)')).toBeNull();
  });
  it('can still save a dirty draft after deletion fails', async () => {
    await mount(true); vi.mocked(api.deleteNote).mockRejectedValue(new Error('Delete failed'));
    edit('Keep after delete failure'); fireEvent.click(screen.getByRole('button', {name: 'Delete', exact: true}));
    await flush(); await advance(); expect(persisted[0].body).toBe('Keep after delete failure');
    expect(store.notes.map(n => n.id)).toEqual([1, 2]);
    expect(store.notes.find(n => n.id === 1)?.body).toBe('Keep after delete failure');
  });
  it('acknowledges a completed autosave visibly under StrictMode', async () => {
    await mount(true, true); edit('StrictMode saved draft'); await advance(); await flush();
    expect(persisted[0].body).toBe('StrictMode saved draft');
    expect((screen.getByLabelText('Note body (Markdown)') as HTMLTextAreaElement).value).toBe('StrictMode saved draft');
    expect(screen.queryByText('Saving…')).toBeNull();
    expect(screen.queryByText('unsaved…')).toBeNull();
  });
  it('serializes a note across switch-away and switch-back while its save is running', async () => {
    await mount(true); const gate = deferred<void>(); let active = 0, maxActive = 0;
    vi.mocked(api.updateNote).mockImplementation(async (id, body, version) => {
      saves.push({id, body, version}); active++; maxActive = Math.max(maxActive, active);
      if (saves.length === 1) await gate.promise;
      try {return commit(id, body, version);} finally {active--;}
    });
    edit('First pending draft'); await advance();
    fireEvent.click(screen.getByRole('button', {name: /Note 2/})); await flush();
    fireEvent.click(screen.getByRole('button', {name: /Note 1/})); await flush();
    edit('Newest return draft'); await advance();
    expect(maxActive).toBe(1);
    await act(async () => {gate.resolve();}); await flush(); await advance();
    expect(persisted.find(n => n.id === 1).body).toBe('Newest return draft');
    expect(store.notes.find(n => n.id === 1)?.body).toBe('Newest return draft');
  });
});
