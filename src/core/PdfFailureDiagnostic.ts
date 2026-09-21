export const PDF_FAILURE_CODES = [
  "PDF_OPEN_REQUEST", "PDF_SOURCE", "PDF_LOAD", "PDF_LOAD_INVALID", "PDF_LOAD_HTTP",
  "PDF_METADATA", "PDF_FIRST_RENDER", "PDF_RENDER", "PDF_PRESENTATION",
  "PDF_RANGE_FETCH", "PDF_RANGE_STATUS", "PDF_RANGE_HEADERS", "PDF_RANGE_BODY", "PDF_RANGE_LENGTH",
  "PDF_TIMEOUT", "PDF_CANCELLED", "PDF_PASSWORD", "PDF_RESOURCE_LIMIT",
] as const;
export type PdfFailureCode = (typeof PDF_FAILURE_CODES)[number];
export interface PdfFailureDiagnostic { readonly code: PdfFailureCode; readonly httpStatus?: number; }
export type PdfDiagnosticReceipt =
  | { readonly delivery: "UNAVAILABLE"; readonly worker: "UNAVAILABLE" }
  | { readonly delivery: "QUEUED" | "DROPPED" | "UNAVAILABLE"; readonly worker: "RUNNING" | "STOPPED"; readonly dropped: number; readonly writeFailures: number };
export class PdfDiagnosticBusyError extends Error {
  public constructor() { super("PDF_DIAGNOSTIC_BUSY"); }
}
const codes = new Set<string>(PDF_FAILURE_CODES);
export function isPdfFailureDiagnostic(value: unknown): value is PdfFailureDiagnostic {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => key !== "code" && key !== "httpStatus") || typeof item.code !== "string" || !codes.has(item.code)) return false;
  const http = item.code === "PDF_RANGE_STATUS" || item.code === "PDF_LOAD_HTTP";
  return http ? typeof item.httpStatus === "number" && Number.isInteger(item.httpStatus) && item.httpStatus >= 100 && item.httpStatus <= 599 : item.httpStatus === undefined;
}
export class PdfFailureError extends Error {
  public constructor(public readonly diagnostic: PdfFailureDiagnostic, message: string = diagnostic.code) {
    super(message);
  }
}
/** Only finite classifications escape this boundary. Never return arbitrary exception text. */
export function classifyPdfFailure(error: unknown, fallback: PdfFailureCode): PdfFailureDiagnostic {
  if (error instanceof PdfFailureError && isPdfFailureDiagnostic(error.diagnostic)) return error.diagnostic;
  const item = typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
  const name = item?.name;
  const tag = item?.tag ?? item?.message;
  if (name === "AbortException" || name === "AbortError" || name === "RenderingCancelledException" || tag === "PASSWORD_CANCELLED" || tag === "Opening PDF cancelled") return { code: "PDF_CANCELLED" };
  if (name === "PasswordException" || tag === "PDF_PASSWORD_PROMPT_FAILED" || tag === "PDF_PASSWORD_UPDATE_FAILED" || tag === "PDF_PASSWORD_REASON_INVALID") return { code: "PDF_PASSWORD" };
  if (tag === "PDF_TIMEOUT" || tag === "PDF_METADATA_TIMEOUT") return { code: "PDF_TIMEOUT" };
  if (tag === "CANVAS_LIMIT" || tag === "DOCUMENT_TOO_LARGE" || tag === "SESSION_CAPACITY") return { code: "PDF_RESOURCE_LIMIT" };
  if (fallback === "PDF_OPEN_REQUEST" || fallback === "PDF_SOURCE") return { code: fallback };
  if (name === "InvalidPDFException" || tag === "PDF_INVALID" || tag === "EMPTY_DOCUMENT") return { code: "PDF_LOAD_INVALID" };
  const http = { code: "PDF_LOAD_HTTP", httpStatus: item?.status };
  if ((name === "UnexpectedResponseException" || name === "ResponseException") && isPdfFailureDiagnostic(http)) return http;
  return { code: fallback };
}
export function pdfFailureStatus(message: string, failure: PdfFailureDiagnostic): string {
  return `${message} [${failure.code}${failure.httpStatus === undefined ? "" : `:${failure.httpStatus}`}]`;
}
export function diagnosticReceiptStatus(receipt: PdfDiagnosticReceipt): string {
  if (receipt.worker === "UNAVAILABLE") return "diagnostic unavailable; worker unavailable";
  return `diagnostic ${receipt.delivery.toLowerCase()}; worker ${receipt.worker.toLowerCase()}; dropped ${receipt.dropped}; write failures ${receipt.writeFailures}`;
}

/** Keep the code visible even when diagnostics are unavailable; never delay PDF cleanup. */
export function presentPdfFailure(
  message: string,
  failure: PdfFailureDiagnostic,
  publish: (status: string) => void,
  isCurrent: (initialStatus: string) => boolean,
  report?: (failure: PdfFailureDiagnostic) => Promise<PdfDiagnosticReceipt>,
): void {
  const initial = pdfFailureStatus(message, failure);
  publish(initial);
  if (report === undefined) return;
  void Promise.resolve().then(() => report(failure)).then((receipt) => {
    if (isCurrent(initial)) publish(`${initial} (${diagnosticReceiptStatus(receipt)})`);
  }, (error: unknown) => {
    if (isCurrent(initial)) publish(`${initial} (${error instanceof PdfDiagnosticBusyError ? "diagnostic client busy" : "diagnostic unavailable"})`);
  }).catch(() => { /* An observer cannot replace the original PDF failure. */ });
}

/** Validate the entire displayed suffix before carrying it across a tab rollback. */
export function isSafePdfFailureStatus(status: string, messages: ReadonlySet<string>): boolean {
  const match = /^(.*?) \[(PDF_[A-Z_]+)(?::([0-9]{3}))?\](?: \((diagnostic unavailable|diagnostic client busy|diagnostic unavailable; worker unavailable|diagnostic (?:queued|dropped|unavailable); worker (?:running|stopped); dropped ([0-9]{1,7}); write failures ([0-9]{1,7}))\))?$/.exec(status);
  if (match === null) return false;
  const materialization = /^PDF viewport page ([1-9][0-9]{0,6}) could not be materialized\.$/.exec(match[1]!);
  if (!messages.has(match[1]!) && !(messages.has("PDF viewport could not be materialized.") && materialization !== null && Number(materialization[1]) <= 1_000_000)) return false;
  const failure = { code: match[2], ...(match[3] === undefined ? {} : { httpStatus: Number(match[3]) }) };
  return isPdfFailureDiagnostic(failure) && (match[5] === undefined || Number(match[5]) <= 1_000_000) &&
    (match[6] === undefined || Number(match[6]) <= 1_000_000);
}
