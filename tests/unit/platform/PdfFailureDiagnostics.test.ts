import { describe, expect, it, vi } from "vitest";
import { createPdfFailureReporter, decodePdfDiagnosticReceipt } from "../../../src/platform/PdfFailureDiagnostics";
import type { NativeInvoke } from "../../../src/platform/tauri-commands";
const receipt = { delivery: "QUEUED", worker: "RUNNING", dropped: 0, writeFailures: 0 };
describe("PDF failure diagnostic bridge", () => {
  it("sends only the finite failure DTO and preserves truthful health", async () => {
    const invoke = vi.fn().mockResolvedValue({ ...receipt, dropped: 2, writeFailures: 3 });
    const report = createPdfFailureReporter(invoke as NativeInvoke);
    expect(await report({ code: "PDF_RANGE_STATUS", httpStatus: 500 })).toEqual({ ...receipt, dropped: 2, writeFailures: 3 });
    expect(invoke).toHaveBeenCalledWith("report_pdf_failure", { failure: { code: "PDF_RANGE_STATUS", httpStatus: 500 } });
  });
  it("bounds stalled invokes and restores capacity after settlement", async () => {
    const releases: ((value: unknown) => void)[] = [];
    const invoke = vi.fn(() => new Promise((resolve) => releases.push(resolve)));
    const report = createPdfFailureReporter(invoke as NativeInvoke);
    const pending = Array.from({ length: 4 }, () => report({ code: "PDF_LOAD" }));
    await expect(report({ code: "PDF_LOAD" })).rejects.toThrow("PDF_DIAGNOSTIC_BUSY");
    expect(invoke).toHaveBeenCalledTimes(4);
    releases.forEach((resolve) => resolve(receipt));
    await Promise.all(pending);
    const next = report({ code: "PDF_LOAD" });
    releases.at(-1)!(receipt);
    await expect(next).resolves.toEqual(receipt);
  });
  it("rejects malformed health rather than displaying arbitrary returned text", () => {
    for (const value of [null, { ...receipt, path: "private" }, { ...receipt, worker: "private" }, { ...receipt, dropped: 1_000_001 }, { ...receipt, writeFailures: -1 }, { ...receipt, delivery: "SUCCESS" }]) {
      expect(() => decodePdfDiagnosticReceipt(value)).toThrow("PDF_DIAGNOSTIC_CONTRACT");
    }
    expect(decodePdfDiagnosticReceipt({ delivery: "UNAVAILABLE", worker: "UNAVAILABLE", dropped: 0, writeFailures: 0 })).toEqual({ delivery: "UNAVAILABLE", worker: "UNAVAILABLE", dropped: 0, writeFailures: 0 });
  });
});
