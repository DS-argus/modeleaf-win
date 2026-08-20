export const OPEN_REQUEST_EVENT = "modeleaf://open-request" as const;
export const OPEN_FAILURE_EVENT = "modeleaf://open-failure" as const;
const ID = /^[0-9a-f]{64}$/i;
const TAGS = new Set(["DOCUMENT_TOO_LARGE", "MISSING_FILE", "REMOTE_PATH", "PATH_REJECTED", "PDF_INVALID", "FILE_UNREADABLE", "SESSION_CAPACITY"]);
const HISTORY_LIMIT = 64;
const INGRESS_LIMIT = 16;
const RETRY_INITIAL = 50;
const RETRY_MAX = 1_000;
const RECONCILE_INTERVAL = 1_000;

export interface OpenRequestNotice { readonly requestId: string; }
export interface OpenFailureNotice { readonly failureId: string; readonly tag: "DOCUMENT_TOO_LARGE" | "MISSING_FILE" | "REMOTE_PATH" | "PATH_REJECTED" | "PDF_INVALID" | "FILE_UNREADABLE" | "SESSION_CAPACITY"; }
export interface ClaimedOpenRequest { readonly sessionId: string; readonly documentGeneration: number; readonly ownerGeneration: number; readonly length: number; readonly displayName: string; }
export interface OpenRequestAdoption extends ClaimedOpenRequest { readonly requestId: string; }
export type OpenRequestTerminalOutcome =
  | { readonly tag: "ACKNOWLEDGED" }
  | { readonly tag: "ADOPTED_WITH_WARNING"; readonly reason: "NOT_FOUND" | "DELIVERY_EXPIRED" }
  | { readonly tag: "REJECTED"; readonly phase: "CLAIM" | "ADOPT" | "ACK" | "REJECT"; readonly baseReason: "CLAIM_INVALID" | "ADOPTION_FAILED" | "OWNERSHIP_CAPACITY" | "REQUEST_EXPIRED" | "ACK_CANCELLED" | "ACK_REJECTED"; readonly cleanup: "NATIVE_COMPLETE" | "TRANSFERRED_TRUSTED_DESCRIPTOR" | "NATIVE_LIFECYCLE_ONLY_NO_DESCRIPTOR" };
export type OpenRequestProgress =
  | { readonly step: "ADOPT" | "ACK"; readonly descriptor: ClaimedOpenRequest }
  | { readonly step: "ROLLBACK"; readonly descriptor: ClaimedOpenRequest; readonly baseReason: "ADOPTION_FAILED" | "OWNERSHIP_CAPACITY" }
  | { readonly step: "REJECT"; readonly baseReason: "CLAIM_INVALID" };
export type OpenRequestProgressCallback = (requestId: string, progress: OpenRequestProgress) => void;
export type OpenRequestTerminal = (requestId: string, outcome: OpenRequestTerminalOutcome) => void;
export type OpenRequestUnlisten = () => void;
export type OpenRequestListener = (event: string, handler: (event: { readonly payload: unknown }) => void) => Promise<OpenRequestUnlisten> | OpenRequestUnlisten;
export type OpenRequestInvoke = (command: string, args: { readonly requestId?: string; readonly failureId?: string }) => Promise<unknown>;
export interface OpenRequestClientOptions { readonly listen: OpenRequestListener; readonly invoke: OpenRequestInvoke; readonly adopt: (request: OpenRequestAdoption) => Promise<void> | void; readonly onFailure?: (tag: OpenFailureNotice["tag"]) => void; readonly onTerminal?: OpenRequestTerminal; }
export interface OpenRequestClient { readonly ready: Promise<void>; readonly admitNotice: (notice: unknown, onTerminal?: OpenRequestTerminal, onProgress?: OpenRequestProgressCallback) => void; readonly retryPending: () => void; readonly dispose: () => void; }
type Request = { state: "queued" | "ack" | "reject" | "done"; terminal?: OpenRequestTerminal; progress?: OpenRequestProgressCallback; outcome?: OpenRequestTerminalOutcome; descriptor?: ClaimedOpenRequest; baseReason?: "CLAIM_INVALID" | "ADOPTION_FAILED" | "OWNERSHIP_CAPACITY" };
type Failure = { state: "queued" | "ack" | "done"; tag: OpenFailureNotice["tag"]; published: boolean };
type Ingress = { readonly tag: "OPEN_REQUEST"; readonly requestId: string } | { readonly tag: "OPEN_FAILURE"; readonly failureId: string; readonly failureTag: OpenFailureNotice["tag"] };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
const opaque = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const terminalReason = (error: unknown): "NOT_FOUND" | "CANCELLED" | "REJECTED" | "DELIVERY_EXPIRED" | undefined => {
  const tag = object(error) && typeof error.tag === "string" ? error.tag : undefined;
  const text = tag ?? (error instanceof Error ? error.message : String(error));
  const match = /^(?:OPEN_(?:REQUEST|FAILURE)_)?(NOT_FOUND|CANCELLED|REJECTED|DELIVERY_EXPIRED)$/u.exec(text);
  return match?.[1] as "NOT_FOUND" | "CANCELLED" | "REJECTED" | "DELIVERY_EXPIRED" | undefined;
};
function notice(value: unknown): OpenRequestNotice | undefined { return object(value) && keys(value, ["requestId"]) && opaque(value.requestId) ? { requestId: value.requestId } : undefined; }
function ingress(value: unknown): Ingress | undefined {
  if (!object(value) || typeof value.tag !== "string") return undefined;
  if (value.tag === "OPEN_REQUEST" && keys(value, ["tag", "requestId"]) && opaque(value.requestId)) return { tag: "OPEN_REQUEST", requestId: value.requestId };
  if (value.tag === "OPEN_FAILURE" && keys(value, ["tag", "failureId", "failureTag"]) && opaque(value.failureId) && typeof value.failureTag === "string" && TAGS.has(value.failureTag)) return { tag: "OPEN_FAILURE", failureId: value.failureId, failureTag: value.failureTag as OpenFailureNotice["tag"] };
  return undefined;
}
function claimed(value: unknown): ClaimedOpenRequest | undefined {
  if (!object(value) || !keys(value, ["sessionId", "documentGeneration", "ownerGeneration", "length", "displayName"])) return undefined;
  const { sessionId, documentGeneration, ownerGeneration, length, displayName } = value;
  if (!opaque(sessionId) || typeof documentGeneration !== "number" || !Number.isSafeInteger(documentGeneration) || documentGeneration < 1 || typeof ownerGeneration !== "number" || !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1 || typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || typeof displayName !== "string" || displayName.length === 0 || displayName.length > 255 || /[\\/\u0000-\u001f]/.test(displayName) || /^[a-z][a-z0-9+.-]*:/i.test(displayName)) return undefined;
  return { sessionId, documentGeneration, ownerGeneration, length, displayName };
}
function ingressList(value: unknown): Ingress[] | undefined { if (!Array.isArray(value) || value.length > INGRESS_LIMIT) return undefined; const result = value.map(ingress); return result.every((item): item is Ingress => item !== undefined) ? result : undefined; }

export function createOpenRequestClient(options: OpenRequestClientOptions): OpenRequestClient {
  let active = true;
  let listenersReady = false;
  let listenersAttempted = false;
  let reconcileQueued = false;
  let retryDelay = RETRY_INITIAL;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail = Promise.resolve();
  let unlistenRequest: OpenRequestUnlisten | undefined;
  let unlistenFailure: OpenRequestUnlisten | undefined;
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const requests = new Map<string, Request>();
  const failures = new Map<string, Failure>();
  const terminals = new Map<string, OpenRequestTerminal>();
  const progresses = new Map<string, OpenRequestProgressCallback>();
  const fifo: Ingress[] = [];
  let retryPending: () => void;
  const enqueue = (task: () => Promise<void>) => { tail = tail.then(task, task); void tail.catch(() => undefined); };
  const clearTimer = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  const scheduleRetry = () => { if (!active) return; clearTimer(); const delay = retryDelay; retryDelay = Math.min(retryDelay * 2, RETRY_MAX); timer = setTimeout(() => { timer = undefined; retryPending(); }, delay); };
  const scheduleReconcile = () => { if (!active || timer !== undefined) return; timer = setTimeout(() => { timer = undefined; retryPending(); }, RECONCILE_INTERVAL); };
  const resetRetry = () => { retryDelay = RETRY_INITIAL; };
  const makeRoom = <T extends { state: string }>(items: Map<string, T>): boolean => { if (items.size < HISTORY_LIMIT) return true; const completedId = Array.from(items).find(([, item]) => item.state === "done")?.[0]; if (completedId === undefined) return false; items.delete(completedId); return true; };
  const rememberTerminal = (id: string, callback: OpenRequestTerminal) => { if (terminals.has(id)) return; if (terminals.size >= HISTORY_LIMIT) terminals.delete(terminals.keys().next().value as string); terminals.set(id, callback); };
  const rememberProgress = (id: string, callback: OpenRequestProgressCallback) => { if (progresses.has(id)) return; if (progresses.size >= HISTORY_LIMIT) progresses.delete(progresses.keys().next().value as string); progresses.set(id, callback); };
  const completeRequest = (id: string, item: Request, outcome: OpenRequestTerminalOutcome) => {
    if (item.state === "done") return;
    item.state = "done";
    item.outcome = outcome;
    const terminal = item.terminal;
    delete item.terminal;
    if (terminal !== undefined) { try { terminal(id, outcome); } catch { /* Terminal cleanup must not disrupt acknowledgement. */ } }
    if (options.onTerminal !== undefined && options.onTerminal !== terminal) { try { options.onTerminal(id, outcome); } catch { /* Global terminal ownership is isolated. */ } }
  };
  const rejectDisposedRequest = (id: string, item: Request): void => {
    void options.invoke("reject_open_request", { requestId: id }).then(
      () => completeRequest(id, item, { tag: "REJECTED", phase: "REJECT", baseReason: "REQUEST_EXPIRED", cleanup: "NATIVE_COMPLETE" }),
      () => completeRequest(id, item, { tag: "REJECTED", phase: "REJECT", baseReason: "REQUEST_EXPIRED", cleanup: item.descriptor === undefined ? "NATIVE_LIFECYCLE_ONLY_NO_DESCRIPTOR" : "TRANSFERRED_TRUSTED_DESCRIPTOR" }),
    );
  };
  const finishFailure = async (id: string): Promise<boolean> => {
    const item = failures.get(id);
    if (!active || item?.state !== "queued") return true;
    if (!item.published) { try { options.onFailure?.(item.tag); item.published = true; } catch { scheduleRetry(); return false; } }
    item.state = "ack";
    try { await options.invoke("ack_open_failure", { failureId: id }); item.state = "done"; resetRetry(); return true; } catch (error) { if (terminalReason(error) !== undefined) { item.state = "done"; return true; } item.state = "queued"; scheduleRetry(); return false; }
  };
  const finishRequest = async (id: string, item: Request): Promise<boolean> => {
    const acknowledging = item.state === "ack";
    try {
      await options.invoke(acknowledging ? "ack_open_request" : "reject_open_request", { requestId: id });
      completeRequest(id, item, acknowledging
        ? { tag: "ACKNOWLEDGED" }
        : { tag: "REJECTED", phase: "REJECT", baseReason: item.baseReason ?? "CLAIM_INVALID", cleanup: "NATIVE_COMPLETE" });
      resetRetry();
      return true;
    } catch (error) {
      const reason = terminalReason(error);
      if (reason !== undefined) {
        const outcome: OpenRequestTerminalOutcome = acknowledging
          ? (reason === "NOT_FOUND" || reason === "DELIVERY_EXPIRED"
              ? { tag: "ADOPTED_WITH_WARNING", reason }
              : { tag: "REJECTED", phase: "ACK", baseReason: reason === "CANCELLED" ? "ACK_CANCELLED" : "ACK_REJECTED", cleanup: "NATIVE_COMPLETE" })
          : { tag: "REJECTED", phase: "REJECT", baseReason: item.baseReason ?? "CLAIM_INVALID", cleanup: "NATIVE_COMPLETE" };
        completeRequest(id, item, outcome);
        return true;
      }
      scheduleRetry();
      return false;
    }
  };
  const processRequest = async (id: string): Promise<boolean> => {
    const item = requests.get(id);
    if (!active || item === undefined) return true;
    if (item.state === "ack" || item.state === "reject") return finishRequest(id, item);
    if (item.state === "done") return true;
    try {
      const value = await options.invoke("claim_open_request", { requestId: id });
      const open = claimed(value);
      if (!active) return true;
      if (open === undefined) {
        item.baseReason = "CLAIM_INVALID";
        try { item.progress?.(id, { step: "REJECT", baseReason: "CLAIM_INVALID" }); } catch { /* Progress observers cannot disrupt cleanup. */ }
        item.state = "reject";
      } else {
        item.descriptor = open;
        try { item.progress?.(id, { step: "ADOPT", descriptor: open }); } catch { /* Progress observers cannot disrupt adoption. */ }
        try {
          await options.adopt(Object.freeze({ requestId: id, ...open }));
          if (!active) return true;
          try { item.progress?.(id, { step: "ACK", descriptor: open }); } catch { /* Progress observers cannot disrupt acknowledgement. */ }
          item.state = "ack";
        } catch (error) {
          item.baseReason = error instanceof Error && /(?:CAPACITY|TAB_CAPACITY)/u.test(error.message) ? "OWNERSHIP_CAPACITY" : "ADOPTION_FAILED";
          if (!active) return true;
          try { item.progress?.(id, { step: "ROLLBACK", descriptor: open, baseReason: item.baseReason }); } catch { /* Progress observers cannot disrupt rejection. */ }
          item.state = "reject";
        }
      }
    } catch (error) {
      if (!active) return true;
      const reason = terminalReason(error);
      if (reason !== undefined) {
        completeRequest(id, item, { tag: "REJECTED", phase: "CLAIM", baseReason: "REQUEST_EXPIRED", cleanup: "NATIVE_LIFECYCLE_ONLY_NO_DESCRIPTOR" });
        return true;
      }
      scheduleRetry();
      return false;
    }
    return finishRequest(id, item);
  };
  const admitIngress = (item: Ingress) => {
    if (fifo.length >= INGRESS_LIMIT) { scheduleReconcile(); return; }
    if (item.tag === "OPEN_REQUEST") {
      if (requests.has(item.requestId)) return;
      if (!makeRoom(requests)) { scheduleReconcile(); return; }
      const terminal = terminals.get(item.requestId);
      const progress = progresses.get(item.requestId);
      terminals.delete(item.requestId);
      progresses.delete(item.requestId);
      requests.set(item.requestId, {
        state: "queued",
        ...(terminal === undefined ? {} : { terminal }),
        ...(progress === undefined ? {} : { progress }),
      });
    } else {
      if (failures.has(item.failureId)) return;
      if (!makeRoom(failures)) { scheduleReconcile(); return; }
      failures.set(item.failureId, { state: "queued", tag: item.failureTag, published: false });
    }
    fifo.push(item);
  };
  const enumerate = async (): Promise<boolean> => {
    try {
      const pending = ingressList(await options.invoke("list_pending_open_ingress", {}));
      if (pending === undefined) return false;
      if (!active) {
        for (const ingress of pending) {
          if (ingress.tag !== "OPEN_REQUEST" || requests.has(ingress.requestId)) continue;
          const item: Request = { state: "reject" };
          requests.set(ingress.requestId, item);
          rejectDisposedRequest(ingress.requestId, item);
        }
        return true;
      }
      for (const ingress of pending) admitIngress(ingress);
      return true;
    } catch { return false; }
  };
  const drain = async () => {
    while (active) {
      const head = fifo[0];
      if (head === undefined) return;
      if (head.tag === "OPEN_REQUEST") {
        if (!(await processRequest(head.requestId))) return;
      } else if (!(await finishFailure(head.failureId))) return;
      fifo.shift();
    }
  };
  const registerListeners = async (): Promise<boolean> => { listenersAttempted = true; let requestUnlisten: OpenRequestUnlisten | undefined; let failureUnlisten: OpenRequestUnlisten | undefined; try { requestUnlisten = await options.listen(OPEN_REQUEST_EVENT, () => retryPending()); failureUnlisten = await options.listen(OPEN_FAILURE_EVENT, () => retryPending()); if (!active) { requestUnlisten(); failureUnlisten(); return false; } unlistenRequest = requestUnlisten; unlistenFailure = failureUnlisten; listenersReady = true; resetRetry(); return true; } catch { requestUnlisten?.(); failureUnlisten?.(); return false; } };
  const admitNotice = (value: unknown, onTerminal?: OpenRequestTerminal, onProgress?: OpenRequestProgressCallback) => {
    const item = notice(value);
    if (!active || item === undefined) return;
    const existing = requests.get(item.requestId);
    if (existing !== undefined) {
      if (onTerminal !== undefined) {
        if (existing.state === "done" && existing.outcome !== undefined) { try { onTerminal(item.requestId, existing.outcome); } catch { /* Terminal callbacks are isolated. */ } }
        else if (existing.state !== "done" && existing.terminal === undefined) existing.terminal = onTerminal;
      }
      if (onProgress !== undefined && existing.state !== "done" && existing.progress === undefined) existing.progress = onProgress;
    } else {
      if (onTerminal !== undefined) rememberTerminal(item.requestId, onTerminal);
      if (onProgress !== undefined) rememberProgress(item.requestId, onProgress);
    }
    retryPending();
  };
  retryPending = () => { if (!active || reconcileQueued) return; reconcileQueued = true; enqueue(async () => { reconcileQueued = false; if (!active) return; const shouldRegister = !listenersReady && !listenersAttempted; const complete = await enumerate(); await drain(); const listenerComplete = shouldRegister ? await registerListeners() : listenersReady; if (complete) scheduleReconcile(); else scheduleRetry(); if (complete || listenerComplete) { resolveReady?.(); resolveReady = undefined; } }); };
  retryPending();
  return { ready, admitNotice, retryPending, dispose: () => {
    if (!active) return;
    active = false;
    clearTimer();
    unlistenRequest?.();
    unlistenFailure?.();
    for (const [id, item] of requests) {
      if (item.state !== "done") rejectDisposedRequest(id, item);
    }
    for (const [id, terminal] of terminals) {
      if (requests.has(id)) continue;
      const item: Request = { state: "reject", terminal };
      requests.set(id, item);
      rejectDisposedRequest(id, item);
    }
    terminals.clear();
    progresses.clear();
  } };
}
