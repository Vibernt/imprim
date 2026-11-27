import { overlays } from 'fire-design';
import type { Send } from '../lib/api';

interface Hold<T> {
  title: string;
  description?: string;
  seconds?: number;
  countdownOnly?: boolean;
  /** Sends the action. Pass `send` on to `api()`: a commit on pagehide only arrives with keepalive. */
  run: (send: Send) => Promise<T>;
  done?: (result: T) => void | Promise<void>;
  failed: (error: unknown) => void;
  settled?: (undone: boolean) => void;
}

export function held<T>({ title, description, seconds = 5, countdownOnly = false, run, done, failed, settled }: Hold<T>) {
  let resolved = false;
  const undo = () => {
    if (resolved) return;
    resolved = true;
    settled?.(true);
  };
  const commit = async () => {
    if (resolved) return;
    resolved = true;
    try {
      const result = await run({ keepalive: true });
      await done?.(result);
    } catch (error) {
      failed(error);
    } finally {
      settled?.(false);
    }
  };
  return overlays.toast.hold({
    title, description, seconds,
    // Fire commits a held toast when the page is left (pagehide) or the stack evicts it. That is what the person
    // decided, so it is sent, with keepalive. A countdownOnly hold (sign-up approvals) commits only when its time runs
    // out: leaving the page or an eviction counts as Undo and sends nothing, the safe direction for an approval.
    onCommit: (_, cause) => countdownOnly && cause !== 'time' ? undo() : void commit(),
    onUndo: undo,
    onDismiss: countdownOnly ? undo : commit,
  });
}

export class HeldRows {
  private readonly pending = new Set<string>();

  constructor(private readonly update: () => void) {}

  has(id: string) { return this.pending.has(id); }
  get active() { return this.pending.size > 0; }

  start<T>(id: string, options: Omit<Hold<T>, 'settled'>, undo?: () => void) {
    if (this.has(id)) return;
    this.pending.add(id);
    this.update();
    held({ ...options, settled: undone => {
      this.pending.delete(id);
      this.update();
      if (undone) undo?.();
    } });
  }
}
