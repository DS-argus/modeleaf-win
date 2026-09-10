import { parseAndValidateConfigToml, type ConfigTomlResult } from "../domain/config/ConfigFile";

export type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type ConfigLoadOutcome =
  | { readonly tag: "MISSING" }
  | { readonly tag: "LOADED"; readonly config: ConfigTomlResult }
  | { readonly tag: "TOO_LARGE" | "INVALID_UTF8" | "STORAGE_FAILED" };
export type ConfigWriteOutcome = { readonly tag: "CREATED" | "ALREADY_EXISTS" | "TOO_LARGE" | "LOCK_TIMEOUT" | "STORAGE_FAILED" };
export type ConfigResetOutcome = { readonly tag: "REPLACED" | "UNCHANGED" | "MISSING" | "TOO_LARGE" | "LOCK_TIMEOUT" | "STORAGE_FAILED" };

const READ_TAGS = new Set(["MISSING", "LOADED", "TOO_LARGE", "INVALID_UTF8", "STORAGE_FAILED"]);
const WRITE_TAGS = new Set(["CREATED", "ALREADY_EXISTS", "TOO_LARGE", "LOCK_TIMEOUT", "STORAGE_FAILED"]);
const RESET_TAGS = new Set(["REPLACED", "UNCHANGED", "MISSING", "TOO_LARGE", "LOCK_TIMEOUT", "STORAGE_FAILED"]);

export async function readProductConfig(invoke: NativeInvoke): Promise<ConfigLoadOutcome> {
  const value = await invoke<unknown>("read_config");
  const object = tagged(value, READ_TAGS);
  if (object.tag === "LOADED") {
    if (typeof object.text !== "string") throw contractError();
    return Object.freeze({ tag: "LOADED", config: parseAndValidateConfigToml(object.text) });
  }
  if ("text" in object) throw contractError();
  return Object.freeze({ tag: object.tag as Exclude<ConfigLoadOutcome["tag"], "LOADED"> });
}
export async function writeDefaultProductConfig(invoke: NativeInvoke): Promise<ConfigWriteOutcome> {
  return decodeSimple(await invoke<unknown>("write_default_config"), WRITE_TAGS) as ConfigWriteOutcome;
}
export async function resetProductConfig(invoke: NativeInvoke): Promise<ConfigResetOutcome> {
  return decodeSimple(await invoke<unknown>("reset_config"), RESET_TAGS) as ConfigResetOutcome;
}
export interface RecentEntry { readonly recentId: string; readonly displayName: string; readonly displayPath: string }
export type RecentListOutcome =
  | { readonly tag: "READY"; readonly revision: string; readonly entries: readonly RecentEntry[] }
  | { readonly tag: "STATE_UNAVAILABLE"; readonly reason: "STATE_UNREADABLE" | "STATE_INVALID_ROOT" | "RECENT_FIELD_INVALID" };
export type RecentRecordOutcome =
  | { readonly tag: "COMMITTED"; readonly revision: string; readonly entries: readonly RecentEntry[] }
  | { readonly tag: "STATE_UNAVAILABLE"; readonly reason: "STATE_UNREADABLE" | "STATE_INVALID_ROOT" | "RECENT_FIELD_INVALID" }
  | { readonly tag: "STORAGE_FAILED"; readonly reason: "STATE_WRITE_FAILED" | "IDENTITY_UNAVAILABLE" };
export type DialogFailureReason = "OWNER_UNAVAILABLE" | "WORKER_FAILED" | "PICKER_FAILED";
export type SelectionRejectionReason = "OPEN_REQUEST_NOT_FOUND" | "OPEN_REQUEST_CAPACITY" | "OPEN_REQUEST_OWNER_MISMATCH" | "OPEN_REQUEST_NOT_CLAIMED" | "OPEN_REQUEST_CANCELLED" | "OPEN_REQUEST_REJECTED" | "OPEN_REQUEST_DELIVERY_EXPIRED" | "PATH_REJECTED" | "REMOTE_PATH" | "MISSING_FILE" | "FILE_UNREADABLE" | "PDF_INVALID" | "DOCUMENT_TOO_LARGE" | "SESSION_CAPACITY" | "RANGE_INVALID" | "RANGE_CAPACITY" | "SESSION_NOT_FOUND" | "OWNER_MISMATCH" | "GENERATION_MISMATCH" | "SESSION_CLOSING" | "BARRIER_MISMATCH" | "DIALOG_FAILED" | "EXTERNAL_LINK_DRAIN_TIMEOUT";
export type NativeDialogOutcome =
  | { readonly tag: "CANCELLED" }
  | { readonly tag: "ADMITTED"; readonly requestId: string }
  | { readonly tag: "DIALOG_FAILED"; readonly reason: DialogFailureReason }
  | { readonly tag: "SELECTION_REJECTED"; readonly reason: SelectionRejectionReason };
export type RecentOpenOutcome =
  | { readonly tag: "ADMITTED"; readonly requestId: string }
  | { readonly tag: "STALE_SELECTION" | "MISSING_PRUNED"; readonly revision: string; readonly entries: readonly RecentEntry[] }
  | { readonly tag: "MISSING_PRUNE_FAILED"; readonly reason: "STATE_WRITE_FAILED" | "STATE_UNAVAILABLE" }
  | { readonly tag: "ACCESS_DENIED"; readonly reason: "REMOTE_PATH" | "PATH_REJECTED" | "PERMISSION_DENIED" }
  | { readonly tag: "TRANSIENT_FAILURE"; readonly reason: "IO_TRANSIENT" }
  | { readonly tag: "DOCUMENT_REJECTED"; readonly reason: SelectionRejectionReason }
  | Extract<RecentListOutcome, { tag: "STATE_UNAVAILABLE" }>;

const REQUEST_ID = /^[0-9a-f]{64}$/u;
const RECENT_ID = /^recent-[0-9a-f]{32}$/u;
const REVISION = /^(?:0|[1-9][0-9]*)$/u;
const U64_MAX = 18_446_744_073_709_551_615n;
const STATE_REASONS = new Set(["STATE_UNREADABLE", "STATE_INVALID_ROOT", "RECENT_FIELD_INVALID"]);
const DIALOG_FAILURE_REASONS = new Set<DialogFailureReason>(["OWNER_UNAVAILABLE", "WORKER_FAILED", "PICKER_FAILED"]);
const SELECTION_REJECTION_REASONS = new Set<SelectionRejectionReason>(["OPEN_REQUEST_NOT_FOUND", "OPEN_REQUEST_CAPACITY", "OPEN_REQUEST_OWNER_MISMATCH", "OPEN_REQUEST_NOT_CLAIMED", "OPEN_REQUEST_CANCELLED", "OPEN_REQUEST_REJECTED", "OPEN_REQUEST_DELIVERY_EXPIRED", "PATH_REJECTED", "REMOTE_PATH", "MISSING_FILE", "FILE_UNREADABLE", "PDF_INVALID", "DOCUMENT_TOO_LARGE", "SESSION_CAPACITY", "RANGE_INVALID", "RANGE_CAPACITY", "SESSION_NOT_FOUND", "OWNER_MISMATCH", "GENERATION_MISMATCH", "SESSION_CLOSING", "BARRIER_MISMATCH", "DIALOG_FAILED", "EXTERNAL_LINK_DRAIN_TIMEOUT"]);
const RECENT_FAILURE_REASONS = {
  MISSING_PRUNE_FAILED: new Set(["STATE_WRITE_FAILED", "STATE_UNAVAILABLE"]),
  ACCESS_DENIED: new Set(["REMOTE_PATH", "PATH_REJECTED", "PERMISSION_DENIED"]),
  TRANSIENT_FAILURE: new Set(["IO_TRANSIENT"]),
  DOCUMENT_REJECTED: SELECTION_REJECTION_REASONS,
} as const;
export async function listRecentDocuments(invoke: NativeInvoke): Promise<RecentListOutcome> {
  return decodeRecentList(await invoke<unknown>("list_recents"));
}
export function decodeRecentStateChanged(value: unknown): Extract<RecentListOutcome, { tag: "READY" }> {
  const outcome = decodeRecentList(value);
  if (outcome.tag !== "READY") throw contractError();
  return outcome;
}
export async function clearRecentDocuments(invoke: NativeInvoke): Promise<RecentRecordOutcome> {
  return decodeRecentRecord(await invoke<unknown>("clear_recent_documents"));
}
export async function recordRecentDocument(invoke: NativeInvoke, sessionId: string, documentGeneration: number, ownerGeneration: number): Promise<RecentRecordOutcome> {
  if (!REQUEST_ID.test(sessionId) || !Number.isSafeInteger(documentGeneration) || documentGeneration < 1 || !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1) throw contractError();
  return decodeRecentRecord(await invoke<unknown>("record_recent", { sessionId, documentGeneration, ownerGeneration }));
}
export async function openRecentDocument(invoke: NativeInvoke, recentId: string): Promise<RecentOpenOutcome> {
  if (!RECENT_ID.test(recentId)) throw contractError();
  return decodeRecentOpen(await invoke<unknown>("open_recent", { recentId }));
}
export async function openNativePdfDialog(invoke: NativeInvoke): Promise<NativeDialogOutcome> {
  const value = tagged(await invoke<unknown>("open_pdf_dialog"), new Set(["CANCELLED", "ADMITTED", "DIALOG_FAILED", "SELECTION_REJECTED"]));
  if (value.tag === "CANCELLED") { exactKeys(value, ["tag"]); return Object.freeze({ tag: "CANCELLED" }); }
  if (value.tag === "ADMITTED") { exactKeys(value, ["tag", "requestId"]); if (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)) throw contractError(); return Object.freeze({ tag: "ADMITTED", requestId: value.requestId }); }
  exactKeys(value, ["tag", "reason"]);
  if (typeof value.reason !== "string") throw contractError();
  if (value.tag === "DIALOG_FAILED") {
    if (!DIALOG_FAILURE_REASONS.has(value.reason as DialogFailureReason)) throw contractError();
    return Object.freeze({ tag: "DIALOG_FAILED", reason: value.reason as DialogFailureReason });
  }
  if (!SELECTION_REJECTION_REASONS.has(value.reason as SelectionRejectionReason)) throw contractError();
  return Object.freeze({ tag: "SELECTION_REJECTED", reason: value.reason as SelectionRejectionReason });
}
function decodeRecentRecord(value: unknown): RecentRecordOutcome {
  const object = tagged(value, new Set(["COMMITTED", "STATE_UNAVAILABLE", "STORAGE_FAILED"]));
  if (object.tag === "COMMITTED") {
    exactKeys(object, ["tag", "revision", "entries"]);
    return Object.freeze({ tag: "COMMITTED", revision: decodeRevision(object.revision), entries: decodeRecentEntries(object.entries) });
  }
  if (object.tag === "STATE_UNAVAILABLE") return decodeRecentList(object) as Extract<RecentRecordOutcome, { tag: "STATE_UNAVAILABLE" }>;
  exactKeys(object, ["tag", "reason"]);
  if (object.reason !== "STATE_WRITE_FAILED" && object.reason !== "IDENTITY_UNAVAILABLE") throw contractError();
  return Object.freeze({ tag: "STORAGE_FAILED", reason: object.reason });
}
function decodeRecentList(value: unknown): RecentListOutcome {
  const object = tagged(value, new Set(["READY", "STATE_UNAVAILABLE"]));
  if (object.tag === "STATE_UNAVAILABLE") {
    exactKeys(object, ["tag", "reason"]);
    if (typeof object.reason !== "string" || !STATE_REASONS.has(object.reason)) throw contractError();
    return Object.freeze({ tag: "STATE_UNAVAILABLE", reason: object.reason as "STATE_UNREADABLE" | "STATE_INVALID_ROOT" | "RECENT_FIELD_INVALID" });
  }
  exactKeys(object, ["tag", "revision", "entries"]);
  return Object.freeze({ tag: "READY", revision: decodeRevision(object.revision), entries: decodeRecentEntries(object.entries) });
}
function decodeRecentOpen(value: unknown): RecentOpenOutcome {
  const object = tagged(value, new Set(["ADMITTED", "STALE_SELECTION", "MISSING_PRUNED", "MISSING_PRUNE_FAILED", "ACCESS_DENIED", "TRANSIENT_FAILURE", "DOCUMENT_REJECTED", "STATE_UNAVAILABLE"]));
  if (object.tag === "ADMITTED") { exactKeys(object, ["tag", "requestId"]); if (typeof object.requestId !== "string" || !REQUEST_ID.test(object.requestId)) throw contractError(); return Object.freeze({ tag: "ADMITTED", requestId: object.requestId }); }
  if (object.tag === "STALE_SELECTION" || object.tag === "MISSING_PRUNED") { exactKeys(object, ["tag", "revision", "entries"]); return Object.freeze({ tag: object.tag, revision: decodeRevision(object.revision), entries: decodeRecentEntries(object.entries) }); }
  if (object.tag === "STATE_UNAVAILABLE") return decodeRecentList(object) as Extract<RecentOpenOutcome, { tag: "STATE_UNAVAILABLE" }>;
  exactKeys(object, ["tag", "reason"]);
  if (typeof object.reason !== "string") throw contractError();
  const allowed = RECENT_FAILURE_REASONS[object.tag as keyof typeof RECENT_FAILURE_REASONS] as ReadonlySet<string>;
  if (!allowed.has(object.reason)) throw contractError();
  return Object.freeze({ tag: object.tag, reason: object.reason }) as RecentOpenOutcome;
}
function decodeRecentEntries(value: unknown): readonly RecentEntry[] {
  if (!Array.isArray(value) || value.length > 15) throw contractError();
  const ids = new Set<string>();
  const entries = value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw contractError();
    const prototype = Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== null) throw contractError();
    const object = entry as Record<string, unknown>;
    exactKeys(object, ["recentId", "displayName", "displayPath"]);
    if (typeof object.recentId !== "string" || !RECENT_ID.test(object.recentId) || ids.has(object.recentId)) throw contractError();
    if (typeof object.displayName !== "string" || object.displayName.length === 0 || object.displayName.length > 255 || /[\\/\p{Cc}]/u.test(object.displayName)) throw contractError();
    if (typeof object.displayPath !== "string" || object.displayPath.length === 0 || object.displayPath.length > 32_767 || /\p{Cc}/u.test(object.displayPath)) throw contractError();
    ids.add(object.recentId);
    return Object.freeze({ recentId: object.recentId, displayName: object.displayName.normalize("NFC"), displayPath: object.displayPath });
  });
  return Object.freeze(entries);
}
function decodeRevision(value: unknown): string { if (typeof value !== "string" || !REVISION.test(value) || BigInt(value) > U64_MAX) throw contractError(); return value; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void { if (Object.keys(value).length !== expected.length || Object.keys(value).some((key) => !expected.includes(key))) throw contractError(); }
function decodeSimple(value: unknown, tags: ReadonlySet<string>): Readonly<{ tag: string }> {
  const object = tagged(value, tags);
  if (Object.keys(object).length !== 1) throw contractError();
  return Object.freeze({ tag: object.tag });
}
function tagged(value: unknown, tags: ReadonlySet<string>): Record<string, unknown> & { tag: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw contractError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw contractError();
  const object = value as Record<string, unknown>;
  if (typeof object.tag !== "string" || !tags.has(object.tag)) throw contractError();
  return object as Record<string, unknown> & { tag: string };
}
function contractError(): Error { return new Error("NATIVE_CONTRACT_INVALID"); }
