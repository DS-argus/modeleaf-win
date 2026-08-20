const WORKSPACE_QUEUE_LIMIT = 8;
type QueueItem = {
  readonly kind: "normal" | "ownership" | "activation";
  work: () => Promise<void> | void;
  resolve: () => void;
  reject: (error: unknown) => void;
};
export interface WorkspaceTransitionQueue {
  readonly enqueue: (work: () => Promise<void> | void) => Promise<void>;
  readonly enqueueOwnership: (work: () => Promise<void> | void) => Promise<void>;
  readonly enqueueActivation: (work: () => Promise<void> | void) => Promise<void>;
}
export function createWorkspaceTransitionQueue(onOverflow: () => void, limit = WORKSPACE_QUEUE_LIMIT, ownershipLimit = WORKSPACE_QUEUE_LIMIT): WorkspaceTransitionQueue {
  const pending: QueueItem[] = [];
  let running = false;
  const count = (kind: QueueItem["kind"]): number => pending.filter((item) => item.kind === kind).length;
  const drain = (): void => {
    if (running) return;
    const item = pending.shift();
    if (item === undefined) return;
    running = true;
    Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => { running = false; drain(); });
  };
  const enqueue = (kind: QueueItem["kind"], work: QueueItem["work"]): Promise<void> => new Promise((resolve, reject) => {
    const prior = kind === "activation" ? pending[pending.length - 1] : undefined;
    if (prior?.kind === "activation") { prior.resolve(); prior.work = work; prior.resolve = resolve; prior.reject = reject; return; }
    if (kind === "normal" && count("normal") >= limit) { onOverflow(); resolve(); return; }
    if (kind === "ownership" && count("ownership") >= ownershipLimit) { reject(new Error("OWNERSHIP_QUEUE_CAPACITY")); return; }
    pending.push({ kind, work, resolve, reject });
    drain();
  });
  return { enqueue: (work) => enqueue("normal", work), enqueueOwnership: (work) => enqueue("ownership", work), enqueueActivation: (work) => enqueue("activation", work) };
}

export interface RemovedTabTeardownSupervisor<T> {
  readonly remove: (value: T) => void;
  readonly close: (value: T) => Promise<void>;
  readonly retryParked: () => void;
  readonly dispose: () => void;
}
export function createRemovedTabTeardownSupervisor<T>(options: { readonly remove: (value: T) => void; readonly close: (value: T) => Promise<void>; readonly initialDelayMs?: number; readonly maxAttempts?: number; }): RemovedTabTeardownSupervisor<T> {
  const retained = new Map<T, { attempts: number; timer?: ReturnType<typeof setTimeout> }>();
  const initialDelayMs = options.initialDelayMs ?? 100;
  const maxAttempts = options.maxAttempts ?? 4;
  let disposed = false;
  const clear = (item: { timer?: ReturnType<typeof setTimeout> }): void => { if (item.timer !== undefined) clearTimeout(item.timer); };
  const attempt = (value: T): void => {
    const item = retained.get(value);
    if (disposed || item === undefined) return;
    void options.close(value).then(() => { const current = retained.get(value); if (current) { clear(current); retained.delete(value); } }, () => {
      const current = retained.get(value);
      if (disposed || current === undefined) return;
      current.attempts += 1;
      if (current.attempts >= maxAttempts) return;
      current.timer = setTimeout(() => { delete current.timer; attempt(value); }, initialDelayMs * 2 ** (current.attempts - 1));
    });
  };
  return {
    remove: (value) => { options.remove(value); if (retained.has(value)) return; retained.set(value, { attempts: 0 }); attempt(value); },
    close: options.close,
    retryParked: () => { if (disposed) return; for (const [value, item] of retained) { if (item.timer === undefined && item.attempts >= maxAttempts) { item.attempts = 0; attempt(value); } } },
    dispose: () => { disposed = true; for (const item of retained.values()) clear(item); },
  };
}
