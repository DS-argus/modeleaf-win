export interface PagePromptFields {
  readonly digits: string;
  readonly revision: number;
  readonly committing: boolean;
  readonly validationMessage?: string | undefined;
}

export type PagePromptState<TOwner extends object> = TOwner & PagePromptFields;

export type PagePromptNavigationKind =
  | "verifiedLanding"
  | "noOp"
  | "preflightRejected"
  | "compensatedFailure"
  | "uncompensatedInvariantFailure"
  | "unavailable"
  | "stale"

  | "failed-verification"
  | "excluded"
  | "search-epoch-recorded"
  | "invalid"
  | "rolled-back";
export type PagePromptCommitStart<TState extends PagePromptFields> =
  | { readonly kind: "invalid"; readonly state: TState; readonly message: string }
  | { readonly kind: "ready"; readonly state: TState; readonly page: number; readonly revision: number };

export type PagePromptCommitSettlement<TState extends PagePromptFields> =
  | { readonly kind: "stale"; readonly state: TState | undefined }
  | { readonly kind: "ownerLost"; readonly state: undefined }
  | { readonly kind: "closed"; readonly state: undefined; readonly restoreFocus: true }
  | { readonly kind: "failed"; readonly state: TState; readonly message: string; readonly restoreFocus: true };

export function openPagePrompt<TOwner extends object>(owner: TOwner, revision: number): PagePromptState<TOwner> {
  return { ...owner, digits: "", revision, committing: false };
}

export function editPagePrompt<TState extends PagePromptFields>(state: TState, token: string, revision: number, ownerCurrent: boolean): TState | undefined {
  if (!ownerCurrent || state.committing) return undefined;
  let digits = state.digits;
  if (/^[0-9]$/u.test(token) && digits.length < 16) digits += token;
  else if (token === "<BS>") digits = digits.slice(0, -1);
  else return undefined;
  return { ...state, digits, revision, validationMessage: undefined };
}

export function beginPagePromptCommit<TState extends PagePromptFields>(state: TState, pageCount: number, revision: number): PagePromptCommitStart<TState> {
  const page = Number(state.digits);
  let message: string | undefined;
  if (state.digits.length === 0) message = "Enter a page number.";
  else if (!Number.isSafeInteger(page)) message = "Page number is too large.";
  else if (page < 1) message = "Page numbers start at 1.";
  else if (page > pageCount) message = `Page ${page} is outside 1–${pageCount}.`;
  if (message !== undefined) return { kind: "invalid", state: { ...state, revision, validationMessage: message }, message };
  return { kind: "ready", state: { ...state, revision, committing: true, validationMessage: undefined }, page, revision };
}

export function settlePagePromptCommit<TState extends PagePromptFields>(
  state: TState | undefined,
  expectedRevision: number,
  ownerCurrent: boolean,
  outcome: PagePromptNavigationKind | "exception",
  revision: number,
): PagePromptCommitSettlement<TState> {
  if (state === undefined || state.revision !== expectedRevision) return { kind: "stale", state };
  if (!ownerCurrent) return { kind: "ownerLost", state: undefined };
  if (outcome === "verifiedLanding" || outcome === "noOp") return { kind: "closed", state: undefined, restoreFocus: true };
  const message = outcome === "exception" ? "Page navigation failed." : navigationFailureStatus(outcome);
  return { kind: "failed", state: { ...state, revision, committing: false, validationMessage: message }, message, restoreFocus: true };
}

export function navigationFailureStatus(kind: PagePromptNavigationKind): string {
  if (kind === "preflightRejected") return "The requested page could not be prepared.";
  if (kind === "compensatedFailure") return "Page navigation failed; the previous position was restored.";
  if (kind === "uncompensatedInvariantFailure") return "Page navigation failed and the previous position could not be restored.";
  if (kind === "unavailable") return "Page navigation is unavailable.";
  return "Page navigation was cancelled.";
}

export function revokePagePromptOwnership<TState extends PagePromptFields>(live: TState | undefined, suspended: TState | undefined): {
  readonly transaction: TState | undefined;
  readonly live: undefined;
  readonly suspended: undefined;
} {
  return { transaction: live ?? suspended, live: undefined, suspended: undefined };
}
