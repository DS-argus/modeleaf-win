export interface OpenAdoptionOwnershipOperations<TId> {
  readonly requestPending: () => boolean;
  readonly activeId: () => TId;
  readonly cancelPagePrompt: () => void;
}

export async function withOpenAdoptionOwnership<TId, TResult>(
  operations: OpenAdoptionOwnershipOperations<TId>,
  transition: (priorActiveId: TId) => Promise<TResult>,
): Promise<TResult> {
  if (!operations.requestPending()) throw new Error("OPEN_REQUEST_DISPOSED");
  const priorActiveId = operations.activeId();
  // Prompt ownership is revoked before any transition can select or stage another tab.
  operations.cancelPagePrompt();
  return transition(priorActiveId);
}

export function rollbackOpenAdoptionOwnership<TId>(settledId: TId, priorActiveId: TId | undefined, operations: {
  readonly close: (id: TId) => void;
  readonly has: (id: TId) => boolean;
  readonly activate: (id: TId) => void;
}): void {
  operations.close(settledId);
  if (priorActiveId !== undefined && !Object.is(priorActiveId, settledId) && operations.has(priorActiveId)) operations.activate(priorActiveId);
}
