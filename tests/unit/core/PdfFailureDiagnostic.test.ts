import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DIAGNOSTIC_EVENTS, DIAGNOSTIC_OUTCOMES, DIAGNOSTIC_TAGS, isDiagnosticEvent, isRendererDiagnosticEvent } from "../../../src/core/DiagnosticEvent";
import { PDF_FAILURE_CODES, PdfFailureError, PdfDiagnosticBusyError, classifyPdfFailure, isPdfFailureDiagnostic, isSafePdfFailureStatus, pdfFailureStatus, presentPdfFailure, type PdfDiagnosticReceipt } from "../../../src/core/PdfFailureDiagnostic";
const matrix = JSON.parse(readFileSync("tests/fixtures/pdfRendererFailures.json", "utf8")) as [string, string, string, number | null][];
const base = { storageClass: "LOCAL", epochMs: 1, appVersion: "0.2.0", runtimeVersion: "0.0.0" };
const receipt: PdfDiagnosticReceipt = { delivery: "QUEUED", worker: "RUNNING", dropped: 0, writeFailures: 0 };

describe("renderer PDF diagnostics", () => {
  it("retains only bounded numeric page details in materialization fallback", () => {
    const messages = new Set(["PDF viewport could not be materialized."]);
    for (const page of [1, 17, 1_000_000]) expect(isSafePdfFailureStatus(`PDF viewport page ${page} could not be materialized. [PDF_PRESENTATION]`, messages)).toBe(true);
    for (const page of [0, -1, 1_000_001, "private", "007"]) expect(isSafePdfFailureStatus(`PDF viewport page ${page} could not be materialized. [PDF_PRESENTATION]`, messages)).toBe(false);
  });
  it("retains existing timeout error messages while recording the actual deadline cause", () => {
    const error = new PdfFailureError({ code: "PDF_TIMEOUT" }, "RENDER_FAILED");
    expect(error.message).toBe("RENDER_FAILED");
    expect(classifyPdfFailure(error, "PDF_RENDER")).toEqual({ code: "PDF_TIMEOUT" });
  });
  it("covers the finite code catalog in shared vectors", () => expect(matrix.map(([code]) => code).sort()).toEqual([...PDF_FAILURE_CODES].sort()));
  it.each(matrix)("validates %s without permitting native evidence", (code, outcome, tag, status) => {
    const failure = { code, ...(status === null ? {} : { httpStatus: status }) };
    expect(isPdfFailureDiagnostic(failure)).toBe(true);
    const event = { ...base, event: "PDF_RENDER", outcome, tag, rendererCode: code, ...(status === null ? {} : { httpStatus: status }) };
    expect(isDiagnosticEvent(event)).toBe(true);
    expect(isRendererDiagnosticEvent(event)).toBe(false); // Only the narrow report command constructs these events.
    for (const name of DIAGNOSTIC_EVENTS) for (const otherOutcome of DIAGNOSTIC_OUTCOMES) for (const otherTag of DIAGNOSTIC_TAGS) {
      expect(isDiagnosticEvent({ ...event, event: name, outcome: otherOutcome, tag: otherTag })).toBe(name === "PDF_RENDER" && otherOutcome === outcome && otherTag === tag);
    }
    for (const field of [{ stage: "OPEN" }, { osCode: 5 }, { message: "private" }]) expect(isDiagnosticEvent({ ...event, ...field })).toBe(false);
    for (const httpStatus of [null, -1, 0, 99, 600, 1.5, "500", Infinity]) expect(isPdfFailureDiagnostic({ ...failure, httpStatus })).toBe(false);
    for (const httpStatus of [100, 599]) expect(isPdfFailureDiagnostic({ ...failure, httpStatus })).toBe(status !== null);
  });
  it("never forwards exception messages or capabilities into the failure DTO", () => {
    const secret = "private document path and password";
    expect(classifyPdfFailure(new Error(secret), "PDF_LOAD")).toEqual({ code: "PDF_LOAD" });
    expect(classifyPdfFailure({ name: "InvalidPDFException", message: secret }, "PDF_LOAD")).toEqual({ code: "PDF_LOAD_INVALID" });
    expect(classifyPdfFailure({ name: "ResponseException", status: 503, message: secret }, "PDF_LOAD")).toEqual({ code: "PDF_LOAD_HTTP", httpStatus: 503 });
    expect(classifyPdfFailure({ name: "ResponseException", status: secret }, "PDF_LOAD")).toEqual({ code: "PDF_LOAD" });
    expect(isPdfFailureDiagnostic({ code: secret })).toBe(false);
    expect(isPdfFailureDiagnostic({ code: "PDF_LOAD", path: secret })).toBe(false);
    expect(classifyPdfFailure(new Error("PDF_TIMEOUT"), "PDF_LOAD").code).toBe("PDF_TIMEOUT");
    expect(classifyPdfFailure({ name: "AbortError" }, "PDF_LOAD").code).toBe("PDF_CANCELLED");
  });
  it("keeps a code visible when the reporter fails and does not expose the rejection", async () => {
    let status = "";
    const report = vi.fn().mockRejectedValue(new Error("secret write path"));
    presentPdfFailure("Could not read this PDF.", { code: "PDF_LOAD" }, (value) => { status = value; }, (initial) => status === initial, report);
    expect(status).toBe("Could not read this PDF. [PDF_LOAD]");
    await vi.waitFor(() => expect(status).toBe("Could not read this PDF. [PDF_LOAD] (diagnostic unavailable)"));
    expect(report).toHaveBeenCalledOnce();
  });
  it("omits unobserved startup counters from unavailable health", async () => {
    let status = "";
    presentPdfFailure("Could not read this PDF.", { code: "PDF_LOAD" }, (value) => { status = value; }, (initial) => status === initial,
      async () => ({ delivery: "UNAVAILABLE", worker: "UNAVAILABLE" }));
    await vi.waitFor(() => expect(status).toBe("Could not read this PDF. [PDF_LOAD] (diagnostic unavailable; worker unavailable)"));
    expect(isSafePdfFailureStatus(status, new Set(["Could not read this PDF."]))).toBe(true);
    expect(isSafePdfFailureStatus("Could not read this PDF. [PDF_LOAD] (diagnostic unavailable; worker unavailable; dropped 0; write failures 0)", new Set(["Could not read this PDF."]))).toBe(false);
  });
  it("does not publish a delayed local-capacity rejection over newer status", async () => {
    let status = "";
    presentPdfFailure("Could not read this PDF.", { code: "PDF_LOAD" }, (value) => { status = value; }, (initial) => status === initial,
      async () => { throw new PdfDiagnosticBusyError(); });
    status = "Newer status";
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(status).toBe("Newer status");
  });
  it("cannot overwrite a newer status after delayed log delivery", async () => {
    let finish!: (receipt: PdfDiagnosticReceipt) => void;
    let status = "";
    presentPdfFailure("Could not read this PDF.", { code: "PDF_LOAD" }, (value) => { status = value; }, (initial) => status === initial,
      () => new Promise((resolve) => { finish = resolve; }));
    await Promise.resolve();
    status = "Opening another document";
    finish(receipt);
    await Promise.resolve(); await Promise.resolve();
    expect(status).toBe("Opening another document");
  });
  it("carries only a validated diagnostic suffix through adoption rollback", () => {
    const messages = new Set(["Could not read this PDF."]);
    const status = pdfFailureStatus("Could not read this PDF.", { code: "PDF_RANGE_STATUS", httpStatus: 500 });
    expect(isSafePdfFailureStatus(status, messages)).toBe(true);
    expect(isSafePdfFailureStatus(`${status} (diagnostic queued; worker running; dropped 2; write failures 1)`, messages)).toBe(true);
    for (const hostile of [`${status} private`, `${status}\nprivate`, "secret [PDF_LOAD]", "Could not read this PDF. [PDF_LOAD:500]", `${status} (diagnostic queued; worker running; dropped 1000001; write failures 0)`]) {
      expect(isSafePdfFailureStatus(hostile, messages)).toBe(false);
    }
  });
});
