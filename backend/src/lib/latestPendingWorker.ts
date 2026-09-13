export interface LatestPendingWorkerStats {
  activeKeys: number;
  pendingKeys: number;
  coalesced: number;
  processed: number;
  maxQueueAgeMs: number;
  lastQueueAgeMs: number;
}

interface PendingWork<T> {
  value: T;
  enqueuedAt: number;
}

interface WorkerState<T> {
  pending: PendingWork<T> | null;
}

interface LatestPendingWorkerOptions<K, T> {
  run: (key: K, value: T) => Promise<void>;
  onError?: (key: K, error: unknown) => void;
  now?: () => number;
}

export class LatestPendingWorker<K, T> {
  private readonly states = new Map<K, WorkerState<T>>();
  private readonly runWork: (key: K, value: T) => Promise<void>;
  private readonly onError?: (key: K, error: unknown) => void;
  private readonly now: () => number;
  private coalesced = 0;
  private processed = 0;
  private maxQueueAgeMs = 0;
  private lastQueueAgeMs = 0;

  constructor(options: LatestPendingWorkerOptions<K, T>) {
    this.runWork = options.run;
    this.onError = options.onError;
    this.now = options.now ?? Date.now;
  }

  schedule(key: K, value: T): void {
    const existing = this.states.get(key);
    if (!existing) {
      const state: WorkerState<T> = { pending: null };
      this.states.set(key, state);
      void this.drain(key, state, { value, enqueuedAt: this.now() });
      return;
    }

    if (existing.pending) this.coalesced += 1;
    existing.pending = { value, enqueuedAt: this.now() };
  }

  stats(): LatestPendingWorkerStats {
    let pendingKeys = 0;
    for (const state of this.states.values()) {
      if (state.pending) pendingKeys += 1;
    }
    return {
      activeKeys: this.states.size,
      pendingKeys,
      coalesced: this.coalesced,
      processed: this.processed,
      maxQueueAgeMs: this.maxQueueAgeMs,
      lastQueueAgeMs: this.lastQueueAgeMs,
    };
  }

  private async drain(
    key: K,
    state: WorkerState<T>,
    initial: PendingWork<T>,
  ): Promise<void> {
    let current: PendingWork<T> | null = initial;
    try {
      while (current) {
        const queueAgeMs = Math.max(0, this.now() - current.enqueuedAt);
        this.lastQueueAgeMs = queueAgeMs;
        this.maxQueueAgeMs = Math.max(this.maxQueueAgeMs, queueAgeMs);
        try {
          await this.runWork(key, current.value);
        } catch (error) {
          try {
            this.onError?.(key, error);
          } catch {
            /* error reporting must not stall the pending worker. */
          }
        } finally {
          this.processed += 1;
        }
        current = state.pending;
        state.pending = null;
      }
    } finally {
      if (this.states.get(key) === state) this.states.delete(key);
    }
  }
}
