import { PdfDiagnosticBusyError, isPdfFailureDiagnostic, type PdfFailureDiagnostic, type PdfDiagnosticReceipt } from "../core/PdfFailureDiagnostic";
import type { NativeInvoke } from "./tauri-commands";

export type PdfFailureReporter = (failure: PdfFailureDiagnostic) => Promise<PdfDiagnosticReceipt>;
const MAX_PENDING_REPORTS = 4;
export function decodePdfDiagnosticReceipt(value: unknown): PdfDiagnosticReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("PDF_DIAGNOSTIC_CONTRACT");
  const item = value as Record<string, unknown>;
  if (item.worker === "UNAVAILABLE") {
    if (Object.keys(item).length !== 2 || item.delivery !== "UNAVAILABLE" || !Object.hasOwn(item, "worker") || !Object.hasOwn(item, "delivery")) throw new Error("PDF_DIAGNOSTIC_CONTRACT");
    return { delivery: "UNAVAILABLE", worker: "UNAVAILABLE" };
  }
  const bounded = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
  if (Object.keys(item).length !== 4 || Object.keys(item).some((key) => !["delivery", "worker", "dropped", "writeFailures"].includes(key)) ||
    !["QUEUED", "DROPPED", "UNAVAILABLE"].includes(item.delivery as string) ||
    !["RUNNING", "STOPPED"].includes(item.worker as string) || !bounded(item.dropped) || !bounded(item.writeFailures)) throw new Error("PDF_DIAGNOSTIC_CONTRACT");
  return item as unknown as PdfDiagnosticReceipt;
}
/** At most four outstanding invokes; never wait for log I/O or block PDF ownership. */
export function createPdfFailureReporter(invoke: NativeInvoke): PdfFailureReporter {
  let pending = 0;
  return async (failure) => {
    if (!isPdfFailureDiagnostic(failure)) throw new Error("PDF_DIAGNOSTIC_CONTRACT");
    if (pending >= MAX_PENDING_REPORTS) throw new PdfDiagnosticBusyError();
    pending += 1;
    try {
      return decodePdfDiagnosticReceipt(await invoke<unknown>("report_pdf_failure", { failure }));
    } finally {
      pending -= 1;
    }
  };
}
