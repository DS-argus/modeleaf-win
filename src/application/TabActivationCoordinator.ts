export type TabActivationPhase = "deactivate" | "select" | "publish" | "activate" | "restore-prior";
const TAB_FAILURE_CODES = [
  "PDF_ACTIVITY_AUTHORITY_INCOMPLETE",
  "PDF_PRESENTATION_RESTORE_FAILED",
  "PDF_RESIDENT_AUTHORITY_INCOMPLETE",
  "CANVAS_LIMIT",
  "RENDER_CAPACITY",
] as const;
type TabFailureCode = typeof TAB_FAILURE_CODES[number] | "UNKNOWN";
export interface TabActivationFailure {
  readonly phase: TabActivationPhase;
  readonly code: TabFailureCode;
  readonly recoveryCode?: TabFailureCode;
}

// Only exact internal tags may cross into status/evidence. Never retain raw native
// or PDF.js messages: they can include document paths, URLs or document content.
function tabFailureCode(error: unknown): TabFailureCode {
  return error instanceof Error
    ? TAB_FAILURE_CODES.find((code) => error.message === code) ?? "UNKNOWN"
    : "UNKNOWN";
}

export interface TabActivationOperations<TId, TPayload> {
  readonly activeId: () => TId;
  readonly payload: (id: TId) => TPayload | undefined;
  readonly isActive: (payload: TPayload) => boolean;
  readonly cancelPending: (payload: TPayload) => void;
  readonly deactivate: (payload: TPayload) => Promise<void>;
  readonly activateWorkspace: (id: TId) => boolean;
  readonly activateCurrent: (restoreFocus: boolean) => Promise<void>;
  readonly publish: () => void;
  readonly reportFailure: (payload: TPayload, failure: TabActivationFailure) => void;
}

export async function performTabActivation<TId, TPayload>(targetId: TId, operations: TabActivationOperations<TId, TPayload>): Promise<void> {
  const priorId = operations.activeId();
  const prior = operations.payload(priorId);
  if (prior === undefined) throw new Error("ACTIVE_TAB_MISSING");
  let phase: TabActivationPhase = "activate";
  if (Object.is(targetId, priorId)) {
    if (operations.isActive(prior)) return;
    try {
      await operations.activateCurrent(true);
      phase = "publish";
      operations.publish();
    } catch (error) {
      operations.reportFailure(prior, { phase, code: tabFailureCode(error) });
      operations.publish();
    }
    return;
  }
  operations.cancelPending(prior);
  let activationFailure: TabActivationFailure | undefined;
  try {
    phase = "deactivate";
    await operations.deactivate(prior);
    phase = "select";
    if (!operations.activateWorkspace(targetId)) {
      phase = "restore-prior";
      await operations.activateCurrent(true);
      phase = "publish";
      operations.publish();
      return;
    }
    // The selected host must be visible before activation computes fit geometry.
    phase = "publish";
    operations.publish();
    phase = "activate";
    try { await operations.activateCurrent(true); }
    catch (error) {
      activationFailure = { phase, code: tabFailureCode(error) };
      phase = "restore-prior";
      try {
        operations.activateWorkspace(priorId);
        operations.publish();
        // Reactivate through the same focus-restoring path used by a successful switch.
        await operations.activateCurrent(true);
      } catch (recoveryError) {
        activationFailure = { ...activationFailure, recoveryCode: tabFailureCode(recoveryError) };
      }
      throw error;
    }
  } catch (error) {
    operations.reportFailure(prior, activationFailure ?? { phase, code: tabFailureCode(error) });
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
