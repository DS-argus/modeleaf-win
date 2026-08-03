export const OPEN_REQUEST_EVENT = "modeleaf://open-request" as const;
export const OPEN_FAILURE_EVENT = "modeleaf://open-failure" as const;
const ID = /^[0-9a-f]{64}$/i;
const TAGS = new Set(["DOCUMENT_TOO_LARGE", "REMOTE_PATH", "PATH_REJECTED", "PDF_INVALID", "FILE_UNREADABLE", "SESSION_CAPACITY"]);
const HISTORY_LIMIT = 64;
const INGRESS_LIMIT = 16;
const RETRY_INITIAL = 50;
const RETRY_MAX = 1_000;
const RECONCILE_INTERVAL = 1_000;

export interface OpenRequestNotice { readonly requestId: string; }
export interface OpenFailureNotice { readonly failureId: string; readonly tag: "DOCUMENT_TOO_LARGE" | "REMOTE_PATH" | "PATH_REJECTED" | "PDF_INVALID" | "FILE_UNREADABLE" | "SESSION_CAPACITY"; }
export interface ClaimedOpenRequest { readonly sessionId: string; readonly documentGeneration: number; readonly ownerGeneration: number; readonly length: number; readonly displayName: string; }
export interface OpenRequestAdoption extends ClaimedOpenRequest { readonly requestId: string; }
export type OpenRequestTerminal = (requestId: string) => void;
export type OpenRequestUnlisten = () => void;
export type OpenRequestListener = (event: string, handler: (event: { readonly payload: unknown }) => void) => Promise<OpenRequestUnlisten> | OpenRequestUnlisten;
export type OpenRequestInvoke = (command: string, args: { readonly requestId?: string; readonly failureId?: string }) => Promise<unknown>;
export interface OpenRequestClientOptions { readonly listen: OpenRequestListener; readonly invoke: OpenRequestInvoke; readonly adopt: (request: OpenRequestAdoption) => Promise<void> | void; readonly onFailure?: (tag: OpenFailureNotice["tag"]) => void; }
export interface OpenRequestClient { readonly ready: Promise<void>; readonly admitNotice: (notice: unknown, onTerminal?: OpenRequestTerminal) => void; readonly retryPending: () => void; readonly dispose: () => void; }
type Request = { state: "queued" | "ack" | "reject" | "done"; terminal?: OpenRequestTerminal };
type Failure = { state: "queued" | "ack" | "done"; tag: OpenFailureNotice["tag"]; published: boolean };
type Ingress = { readonly tag: "OPEN_REQUEST"; readonly requestId: string } | { readonly tag: "OPEN_FAILURE"; readonly failureId: string; readonly failureTag: OpenFailureNotice["tag"] };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
const opaque = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const terminal = (error: unknown): boolean => {
  const tag = object(error) && typeof error.tag === "string" ? error.tag : undefined;
  if (tag !== undefined && /^(?:OPEN_(?:REQUEST|FAILURE)_)?(?:NOT_FOUND|CANCELLED|REJECTED|DELIVERY_EXPIRED)$/.test(tag)) return true;
  return /OPEN_(?:REQUEST|FAILURE)_(?:NOT_FOUND|CANCELLED|REJECTED|DELIVERY_EXPIRED)/.test(error instanceof Error ? error.message : String(error));
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
  const fifo: Ingress[] = [];
  let retryPending: () => void;
  const enqueue = (task: () => Promise<void>) => { tail = tail.then(task, task); void tail.catch(() => undefined); };
  const clearTimer = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  const scheduleRetry = () => { if (!active) return; clearTimer(); const delay = retryDelay; retryDelay = Math.min(retryDelay * 2, RETRY_MAX); timer = setTimeout(() => { timer = undefined; retryPending(); }, delay); };
  const scheduleReconcile = () => { if (!active || timer !== undefined) return; timer = setTimeout(() => { timer = undefined; retryPending(); }, RECONCILE_INTERVAL); };
  const resetRetry = () => { retryDelay = RETRY_INITIAL; };
  const makeRoom = <T extends { state: string }>(items: Map<string, T>): boolean => { if (items.size < HISTORY_LIMIT) return true; const completedId = Array.from(items).find(([, item]) => item.state === "done")?.[0]; if (completedId === undefined) return false; items.delete(completedId); return true; };
  const rememberTerminal = (id: string, callback: OpenRequestTerminal) => { if (terminals.has(id)) return; if (terminals.size >= HISTORY_LIMIT) terminals.delete(terminals.keys().next().value as string); terminals.set(id, callback); };
  const completeRequest = (id: string, item: Request) => { if (item.state === "done") return; item.state = "done"; if (item.terminal !== undefined) { try { item.terminal(id); } catch { /* Terminal cleanup must not disrupt acknowledgement. */ } delete item.terminal; } };
  const finishFailure = async (id: string): Promise<boolean> => {
    const item = failures.get(id);
    if (!active || item?.state !== "queued") return true;
    if (!item.published) { try { options.onFailure?.(item.tag); item.published = true; } catch { scheduleRetry(); return false; } }
    item.state = "ack";
    try { await options.invoke("ack_open_failure", { failureId: id }); item.state = "done"; resetRetry(); return true; } catch (error) { if (terminal(error)) { item.state = "done"; return true; } item.state = "queued"; scheduleRetry(); return false; }
  };
  const finishRequest = async (id: string, item: Request): Promise<boolean> => {
    try { await options.invoke(item.state === "ack" ? "ack_open_request" : "reject_open_request", { requestId: id }); completeRequest(id, item); resetRetry(); return true; } catch (error) { if (terminal(error)) { completeRequest(id, item); return true; } scheduleRetry(); return false; }
  };
  const processRequest = async (id: string): Promise<boolean> => {
    const item = requests.get(id);
    if (!active || item === undefined) return true;
    if (item.state === "ack" || item.state === "reject") return finishRequest(id, item);
    if (item.state === "done") return true;
    try {
      const value = await options.invoke("claim_open_request", { requestId: id });
      const open = claimed(value);
      if (open === undefined) item.state = "reject";
      else { try { await options.adopt(Object.freeze({ requestId: id, ...open })); item.state = "ack"; } catch { item.state = "reject"; } }
    } catch (error) { if (terminal(error)) { completeRequest(id, item); return true; } scheduleRetry(); return false; }
    return finishRequest(id, item);
  };
  const admitIngress = (item: Ingress) => {
    if (fifo.length >= INGRESS_LIMIT) { scheduleReconcile(); return; }
    if (item.tag === "OPEN_REQUEST") {
      if (requests.has(item.requestId)) return;
      if (!makeRoom(requests)) { scheduleReconcile(); return; }
      const callback = terminals.get(item.requestId);
      terminals.delete(item.requestId);
      requests.set(item.requestId, callback === undefined ? { state: "queued" } : { state: "queued", terminal: callback });
    } else {
      if (failures.has(item.failureId)) return;
      if (!makeRoom(failures)) { scheduleReconcile(); return; }
      failures.set(item.failureId, { state: "queued", tag: item.failureTag, published: false });
    }
    fifo.push(item);
  };
  const enumerate = async (): Promise<boolean> => { try { const pending = ingressList(await options.invoke("list_pending_open_ingress", {})); if (pending === undefined) return false; for (const item of pending) admitIngress(item); return true; } catch { return false; } };
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
  const admitNotice = (value: unknown, onTerminal?: OpenRequestTerminal) => {
    const item = notice(value);
    if (!active || item === undefined) return;
    const existing = requests.get(item.requestId);
    if (existing !== undefined) {
      if (onTerminal !== undefined) { if (existing.state === "done") { try { onTerminal(item.requestId); } catch { /* Terminal callbacks are isolated. */ } } else if (existing.terminal === undefined) existing.terminal = onTerminal; }
    } else if (onTerminal !== undefined) rememberTerminal(item.requestId, onTerminal);
    retryPending();
  };
  retryPending = () => { if (!active || reconcileQueued) return; reconcileQueued = true; enqueue(async () => { reconcileQueued = false; if (!active) return; const shouldRegister = !listenersReady && !listenersAttempted; const complete = await enumerate(); await drain(); const listenerComplete = shouldRegister ? await registerListeners() : listenersReady; if (complete) scheduleReconcile(); else scheduleRetry(); if (complete || listenerComplete) { resolveReady?.(); resolveReady = undefined; } }); };
  retryPending();
  return { ready, admitNotice, retryPending, dispose: () => { if (!active) return; active = false; clearTimer(); unlistenRequest?.(); unlistenFailure?.(); } };
}
