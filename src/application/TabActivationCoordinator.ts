export interface TabActivationOperations<TId, TPayload> {
  readonly activeId: () => TId;
  readonly payload: (id: TId) => TPayload | undefined;
  readonly isActive: (payload: TPayload) => boolean;
  readonly cancelPending: (payload: TPayload) => void;
  readonly deactivate: (payload: TPayload) => Promise<void>;
  readonly activateWorkspace: (id: TId) => boolean;
  readonly activateCurrent: (restoreFocus: boolean) => Promise<void>;
  readonly publish: () => void;
  readonly reportFailure: (payload: TPayload) => void;
}

export async function performTabActivation<TId, TPayload>(targetId: TId, operations: TabActivationOperations<TId, TPayload>): Promise<void> {
  const priorId = operations.activeId();
  const prior = operations.payload(priorId);
  if (prior === undefined) throw new Error("ACTIVE_TAB_MISSING");
  if (Object.is(targetId, priorId)) {
    if (operations.isActive(prior)) return;
    try { await operations.activateCurrent(true); operations.publish(); }
    catch { operations.reportFailure(prior); operations.publish(); }
    return;
  }
  operations.cancelPending(prior);
  try {
    await operations.deactivate(prior);
    if (!operations.activateWorkspace(targetId)) {
      await operations.activateCurrent(true);
      operations.publish();
      return;
    }
    // The selected host must be visible before activation computes fit geometry.
    operations.publish();
    try { await operations.activateCurrent(true); }
    catch (error) {
      operations.activateWorkspace(priorId);
      operations.publish();
      // Reactivate through the same focus-restoring path used by a successful switch.
      await operations.activateCurrent(true);
      throw error;
    }
  } catch {
    operations.reportFailure(prior);
    operations.publish();
  }
}

export function queueRelativeTabActivation<TId>(
  direction: -1 | 1,
  enqueue: (work: () => Promise<void>) => Promise<void>,
  adjacentId: (direction: -1 | 1) => TId,
  activate: (id: TId) => Promise<void>,
): Promise<void> {
  // Resolve adjacency inside the serialized work item so rapid N/P presses are relative to the latest committed tab.
  return enqueue(() => activate(adjacentId(direction)));
}

export interface TabCloseOperations<TId> {
  readonly activeId: () => TId;
  readonly cancelPending: () => void;
  readonly closeWorkspace: (id: TId) => boolean;
  readonly publish: () => void;
  readonly activateCurrent: () => Promise<void>;
}

/** A successor needs visible geometry before its suspended presentation can restore. */
export async function performTabClose<TId>(id: TId, operations: TabCloseOperations<TId>): Promise<void> {
  const wasActive = Object.is(id, operations.activeId());
  if (wasActive) operations.cancelPending();
  if (!operations.closeWorkspace(id)) return;
  operations.publish();
  if (wasActive) await operations.activateCurrent();
}
