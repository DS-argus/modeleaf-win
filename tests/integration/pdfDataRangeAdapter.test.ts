import { describe, expect, it, vi } from "vitest";
import { PDFDataRangeTransport } from "pdfjs-dist";
import {
  createPdfDataRangeAdapter,
  type NativePdfSessionLifecycle,
} from "../../src/pdf/PdfDataRangeAdapter";
import { RESOURCE_LIMITS } from "../../src/pdf/ResourceBudget";
import type { BinaryRangeInvoker, PdfRangeRequest } from "../../src/pdf/BinaryRangeTransport";

const settle = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fixture(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251);
}

function lifecycle(events: string[]): NativePdfSessionLifecycle {
  return {
    cancel: async () => { events.push("cancel"); },
    waitForBarrier: async () => { events.push("barrier"); },
    close: async () => { events.push("close"); },
  };
}

describe("PDFDataRangeTransport opaque binary adapter", () => {
  it("uses the installed PDF.js range class and delivers exact offset bytes", async () => {
    const bytes = fixture(32);
    const invoker: BinaryRangeInvoker = { invoke: vi.fn(async (request: PdfRangeRequest) => bytes.slice(request.offset, request.offset + request.length)) };
    const adapter = createPdfDataRangeAdapter({
      session: { sessionId: "opaque", documentGeneration: 7, byteLength: bytes.byteLength },
      invoker,
      isGenerationCurrent: () => true,
      nativeLifecycle: lifecycle([]),
    });
    expect(adapter.transport).toBeInstanceOf(PDFDataRangeTransport);
    const delivered: Array<{ begin: number; chunk: Uint8Array }> = [];
    adapter.transport.addRangeListener((begin, chunk) => delivered.push({ begin, chunk }));

    adapter.transport.requestDataRange(5, 12);
    await settle();

    expect(invoker.invoke).toHaveBeenCalledWith(expect.objectContaining({ offset: 5, length: 7 }), expect.any(AbortSignal));
    expect(delivered).toEqual([{ begin: 5, chunk: bytes.slice(5, 12) }]);
  });

  it("splits requests above one MiB and reports only completed bytes", async () => {
    const bytes = fixture(RESOURCE_LIMITS.normalRangeBytes + 3);
    const progress: number[] = [];
    const invoker: BinaryRangeInvoker = { invoke: vi.fn(async (request: PdfRangeRequest) => bytes.slice(request.offset, request.offset + request.length)) };
    const adapter = createPdfDataRangeAdapter({
      session: { sessionId: "opaque", documentGeneration: 1, byteLength: bytes.byteLength },
      invoker,
      isGenerationCurrent: () => true,
      nativeLifecycle: lifecycle([]),
    });
    const delivered: Array<{ begin: number; chunk: Uint8Array }> = [];
    adapter.transport.addRangeListener((begin, chunk) => delivered.push({ begin, chunk }));
    adapter.transport.addProgressListener(({ loaded }) => progress.push(loaded));

    adapter.transport.requestDataRange(0, bytes.byteLength);
    await settle();

    expect(adapter.rangeChunkSize).toBe(RESOURCE_LIMITS.normalRangeBytes);
    expect(vi.mocked(invoker.invoke).mock.calls.map(([request]) => request.length)).toEqual([RESOURCE_LIMITS.normalRangeBytes, 3]);
    expect(delivered).toEqual([
      { begin: 0, chunk: bytes.slice(0, RESOURCE_LIMITS.normalRangeBytes) },
      { begin: RESOURCE_LIMITS.normalRangeBytes, chunk: bytes.slice(RESOURCE_LIMITS.normalRangeBytes) },
    ]);
    expect(progress.sort((left, right) => left - right)).toEqual([RESOURCE_LIMITS.normalRangeBytes, bytes.byteLength]);
  });

  it("caps a final PDF.js range at EOF without a whole-file request", async () => {
    const bytes = fixture(9);
    const invoker: BinaryRangeInvoker = { invoke: vi.fn(async (request: PdfRangeRequest) => bytes.slice(request.offset, request.offset + request.length)) };
    const adapter = createPdfDataRangeAdapter({
      session: { sessionId: "opaque", documentGeneration: 2, byteLength: bytes.byteLength },
      invoker,
      isGenerationCurrent: () => true,
      nativeLifecycle: lifecycle([]),
    });
    const delivered: Array<{ begin: number; chunk: Uint8Array }> = [];
    adapter.transport.addRangeListener((begin, chunk) => delivered.push({ begin, chunk }));

    adapter.transport.requestDataRange(7, 100);
    await settle();

    expect(invoker.invoke).toHaveBeenCalledWith(expect.objectContaining({ offset: 7, length: 2 }), expect.any(AbortSignal));
    expect(delivered).toEqual([{ begin: 7, chunk: bytes.slice(7) }]);
  });

  it("suppresses stale generations before dispatch and after completion", async () => {
    const bytes = fixture(8);
    let current = false;
    const failures: string[] = [];
    const invoker: BinaryRangeInvoker = { invoke: vi.fn(async () => bytes) };
    const adapter = createPdfDataRangeAdapter({
      session: { sessionId: "opaque", documentGeneration: 4, byteLength: bytes.byteLength },
      invoker,
      isGenerationCurrent: () => current,
      nativeLifecycle: lifecycle([]),
      onFailure: (tag) => failures.push(tag),
    });
    const delivered: Array<{ begin: number; chunk: Uint8Array }> = [];
    adapter.transport.addRangeListener((begin, chunk) => delivered.push({ begin, chunk }));

    adapter.transport.requestDataRange(0, 4);
    await settle();
    expect(invoker.invoke).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
    expect(failures).toContain("RANGE_STALE");

    current = true;
    adapter.transport.requestDataRange(0, 4);
    current = false;
    await settle();
    expect(delivered).toEqual([]);
    expect(failures).toContain("RANGE_STALE");
  });

  it("aborts idempotently and orders native cancel, barrier, then close", async () => {
    const events: string[] = [];
    let resolveRead: ((bytes: Uint8Array) => void) | undefined;
    const adapter = createPdfDataRangeAdapter({
      session: { sessionId: "opaque", documentGeneration: 5, byteLength: 4 },
      invoker: { invoke: async () => new Promise<Uint8Array>((resolve) => { resolveRead = resolve; }) },
      isGenerationCurrent: () => true,
      nativeLifecycle: lifecycle(events),
    });

    adapter.transport.requestDataRange(0, 4);
    await Promise.resolve();
    const first = adapter.abort();
    const second = adapter.destroy();
    resolveRead?.(fixture(4));
    await Promise.all([first, second]);

    expect(events).toEqual(["cancel", "barrier", "close"]);
  });
});
