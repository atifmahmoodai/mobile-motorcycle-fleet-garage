// The technician app's outbox. Every action is stored on the phone first and sent to /api/tech/sync
// in order; with no signal it waits and retries. Each action carries its own id, so the server applies
// it once even if a flaky connection sends it twice. Actions the server refuses (a part out of stock,
// a job someone cancelled) are kept in a "needs attention" list instead of being retried forever.
import { useSyncExternalStore } from "react";
import { api, ApiError } from "../api/client";
import type { TechOp } from "../../../shared/schemas";

export type QueuedOp = TechOp & { label: string };
/** An operation before it gets its id and time; distributes over the union so each type keeps its fields. */
export type NewOp = TechOp extends infer T ? (T extends TechOp ? Omit<T, "opId" | "at"> & { label: string } : never) : never;
export interface FailedOp {
  op: QueuedOp;
  message: string;
}
interface State {
  userId: string | null;
  queue: QueuedOp[];
  failed: FailedOp[];
  sending: boolean;
  lastError: string | null;
}

let state: State = { userId: null, queue: [], failed: [], sending: false, lastError: null };
const listeners = new Set<() => void>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 2000;
/** Called after a successful send so screens can reload the server's view. */
let onSynced: () => void = () => {};

const key = (userId: string) => `fleet-outbox:${userId}`;

function persist() {
  if (!state.userId) return;
  try {
    localStorage.setItem(key(state.userId), JSON.stringify({ queue: state.queue, failed: state.failed }));
  } catch {
    // storage full or blocked: the queue still lives in memory for this session
  }
}

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  persist();
  listeners.forEach((l) => l());
}

/** Loads this user's queue from the phone. Queues are per user, so a shared phone doesn't mix them up. */
export function initOutbox(userId: string, synced: () => void) {
  onSynced = synced;
  if (state.userId === userId) return;
  let saved: { queue: QueuedOp[]; failed: FailedOp[] } = { queue: [], failed: [] };
  try {
    saved = JSON.parse(localStorage.getItem(key(userId)) ?? "null") ?? saved;
  } catch {
    // unreadable storage: start empty
  }
  state = { userId, queue: saved.queue ?? [], failed: saved.failed ?? [], sending: false, lastError: null };
  listeners.forEach((l) => l());
  void flush();
}

export function enqueue(op: NewOp) {
  const full = { ...op, opId: crypto.randomUUID(), at: new Date().toISOString() } as QueuedOp;
  set({ queue: [...state.queue, full] });
  void flush();
  return full;
}

export function dismissFailed(opId: string) {
  set({ failed: state.failed.filter((f) => f.op.opId !== opId) });
}

export async function flush(): Promise<void> {
  if (state.sending || !state.queue.length) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  set({ sending: true });
  const batch = state.queue.slice(0, 50);
  try {
    const res = await api<{ results: { opId: string; ok: boolean; message?: string }[] }>("/tech/sync", {
      method: "POST",
      body: { ops: batch.map(({ label: _label, ...op }) => op) },
    });
    const byId = new Map(res.results.map((r) => [r.opId, r]));
    const failed = batch.filter((o) => byId.get(o.opId)?.ok === false).map((o) => ({ op: o, message: byId.get(o.opId)!.message ?? "Refused" }));
    set({
      queue: state.queue.filter((o) => !byId.has(o.opId)),
      failed: [...state.failed, ...failed],
      sending: false,
      lastError: null,
    });
    retryDelay = 2000;
    onSynced();
    if (state.queue.length) void flush();
  } catch (e) {
    const offline = e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 429);
    if (e instanceof ApiError && e.status === 400) {
      // The server couldn't read the batch at all (an app update changed the format): don't loop on it.
      set({ queue: state.queue.slice(batch.length), failed: [...state.failed, ...batch.map((op) => ({ op, message: e.message }))], sending: false });
      return;
    }
    set({ sending: false, lastError: offline ? "Offline — changes are saved on this phone and will send when there's signal." : (e as Error).message });
    if (e instanceof ApiError && e.status === 401) return; // signed out: the queue waits for the same user to sign in
    retryTimer = setTimeout(() => void flush(), retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60_000);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    retryDelay = 2000;
    void flush();
  });
}

export function useOutbox() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Applies queued actions to a job the phone has cached, so the screen shows them before they are sent. */
export function pendingFor(jobId: string): QueuedOp[] {
  return state.queue.filter((o) => o.jobId === jobId);
}
