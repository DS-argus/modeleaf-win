/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import {
  PdfProtocolRangeTransport,
  PdfReaderController,
  pdfProtocolSourceUrl,
  type PdfDocument,
  type PdfLoadingTask,
  type PdfPage,
} from "../../src/pdf/PdfReaderController";
import { ResourceReservationManager } from "../../src/pdf/ResourceBudget";

const session = (id: string, generation: number) => ({
  sessionId: id,
  documentGeneration: generation,
  length: 64,
  displayName: `${id}.pdf`,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const pdfViewport = (width: number, height: number, scale = 1) => ({
  width,
  height,
  scale,
  rotation: 0,
  rawDims: { pageWidth: width / scale, pageHeight: height / scale },
  convertToViewportPoint: (x: number, y: number) => [x, y] as const,
  convertToPdfPoint: (x: number, y: number) => [x, y] as const,
});

function page(pageNumber: number, renderPromise: Promise<void> = Promise.resolve(), cancel = vi.fn()): PdfPage {
  return {
    getViewport: () => pdfViewport(20, 30),
    getTextContent: async () => ({ items: [] }),
    getAnnotations: async () => [],
    render: ({ canvas }) => {
      canvas.dataset.page = String(pageNumber);
      return { promise: renderPromise, cancel };
    },
  };
}

function documentWith(pageCount: number, getPage = vi.fn(async (pageNumber: number) => page(pageNumber))): PdfDocument {
  return { numPages: pageCount, getPage, destroy: vi.fn() };
}

function publishedCanvas(host: HTMLElement): HTMLCanvasElement {
  const canvas = host.querySelector<HTMLCanvasElement>(":scope > .pdf-page-frame[data-active-page='true'] > canvas");
  if (canvas === null) throw new Error("Expected a published PDF canvas");
  return canvas;
}

function task(document: PdfDocument): PdfLoadingTask {
  return { promise: Promise.resolve(document), destroy: vi.fn() };
}

function nativeBoundary(openPdfDialog: ReturnType<typeof vi.fn>) {
  return {
    openPdfDialog,
    cancelSession: vi.fn(async (_session: unknown, _ownerGeneration: number) => ({ barrierId: 7 })),
    closeSession: vi.fn(async (_session: unknown, _barrierId: number, _ownerGeneration: number) => undefined),
  };
}

describe("PdfReaderController", () => {
  it("builds an opaque custom-protocol URL without exposing a path", () => {
    expect(pdfProtocolSourceUrl(session("opaque token", 7))).toBe("http://modeleaf-pdf.localhost/opaque%20token/7");
    expect(() => pdfProtocolSourceUrl(session("", 1))).toThrow("Invalid PDF protocol session");
    expect(() => pdfProtocolSourceUrl(session("opaque", 0))).toThrow("Invalid PDF protocol session");
  });
  it("delivers exact explicit protocol ranges and aborts owned fetches", async () => {
    const onFailure = vi.fn();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes, {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/10", "Content-Length": "4" },
    }));
    const transport = new PdfProtocolRangeTransport(10, "http://modeleaf-pdf.localhost/session/1", onFailure);
    const delivered: unknown[] = [];
    transport.transportReady((event: unknown) => delivered.push(event));
    transport.requestDataRange(0, 4);
    await Promise.all(transport.settlements());

    expect(fetchMock).toHaveBeenCalledWith("http://modeleaf-pdf.localhost/session/1", expect.objectContaining({
      headers: { Range: "bytes=0-3" },
      signal: expect.any(AbortSignal),
    }));
    expect(delivered).toEqual([{ type: "range", begin: 0, chunk: bytes }]);
    expect(onFailure).not.toHaveBeenCalled();

    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    transport.requestDataRange(4, 8);
    transport.abort();
    await Promise.all(transport.settlements());
    expect(signal?.aborted).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("uses PDFDataRangeTransport for large documents without a malformed no-Range probe", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const largeSession = { ...session("large-range", 1), length: 2 * 1_048_576 + 1 };
    const getDocument = vi.fn(() => task(documentWith(1)));
    const native = nativeBoundary(vi.fn().mockResolvedValue(largeSession));
    const resources = new ResourceReservationManager();
    const controller = new PdfReaderController({
      native,
      resources,
      pdf: { getDocument, annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({
      range: expect.any(PdfProtocolRangeTransport),
      length: largeSession.length,
      url: undefined,
    }));
    await controller.dispose();
    resources.assertEmpty();
  });
  it("closes the native session when PDF.js setup throws synchronously", async () => {
    const native = nativeBoundary(vi.fn().mockResolvedValue(session("setup-throws", 1)));
    const statuses: string[] = [];
    const resources = new ResourceReservationManager();
    const controller = new PdfReaderController({
      native,
      resources,
      pdf: { getDocument: vi.fn(() => { throw new Error("PDF_INVALID"); }), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: (status) => statuses.push(status),
    });

    await controller.open(1);
    expect(native.cancelSession).toHaveBeenCalledOnce();
    expect(native.closeSession).toHaveBeenCalledOnce();
    expect(statuses).toContain("Could not read this PDF.");
    resources.assertEmpty();
  });

  it("routes a committed protocol Range failure through once-only candidate teardown", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const largeSession = { ...session("late-range-failure", 1), length: 2 * 1_048_576 + 1 };
    const native = nativeBoundary(vi.fn().mockResolvedValue(largeSession));
    const getDocument = vi.fn((_options: Record<string, unknown>) => task(documentWith(1)));
    const statuses: string[] = [];
    const resources = new ResourceReservationManager();
    const controller = new PdfReaderController({
      native,
      resources,
      pdf: { getDocument, annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: (status) => statuses.push(status),
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("range failed"));

    await controller.open(1);
    const range = getDocument.mock.calls[0]![0]!.range as PdfProtocolRangeTransport;
    range.requestDataRange(0, 4);
    await Promise.all(range.settlements());
    await vi.waitFor(() => expect(native.closeSession).toHaveBeenCalledOnce());
    expect(native.cancelSession).toHaveBeenCalledOnce();
    expect(statuses).toContain("Could not read this PDF.");
    resources.assertEmpty();
  });
  it("prevents commit when the Range transport fails during opening precommit", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const largeSession = { ...session("opening-range-failure", 1), length: 2 * 1_048_576 + 1 };
    const native = nativeBoundary(vi.fn().mockResolvedValue(largeSession));
    const getDocument = vi.fn((_options: Record<string, unknown>) => task(documentWith(1)));
    const entered = deferred<void>();
    const release = deferred<void>();
    const committed = vi.fn();
    const statuses: string[] = [];
    const resources = new ResourceReservationManager();
    const controller = new PdfReaderController({
      native,
      resources,
      pdf: { getDocument, annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: committed,
      onBeforeCommit: async (_rendered, commitCanvas, context) => {
        if (context.opening) {
          entered.resolve();
          await release.promise;
        }
        commitCanvas();
      },
      onPage: vi.fn(),
      onStatus: (status) => statuses.push(status),
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("range failed"));

    const opening = controller.open(1);
    await entered.promise;
    const range = getDocument.mock.calls[0]![0]!.range as PdfProtocolRangeTransport;
    range.requestDataRange(0, 4);
    await Promise.all(range.settlements());
    release.resolve();
    await opening;

    expect(committed).not.toHaveBeenCalled();
    expect(native.cancelSession).toHaveBeenCalledOnce();
    expect(native.closeSession).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toBe("Could not read this PDF.");
    resources.assertEmpty();
  });
  it("commits only after page one renders, preserves a healthy document, and closes with each captured owner", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const first = documentWith(2);
    const failed = documentWith(2, vi.fn(async () => { throw new Error("corrupt"); }));
    const loading = [task(first), task(failed)];
    const native = nativeBoundary(vi.fn().mockResolvedValueOnce(session("one", 1)).mockResolvedValueOnce(session("two", 2)));
    const committed: Array<{ readonly count: number; readonly sessionId: string; readonly documentGeneration: number; readonly ownerGeneration: number }> = [];
    const onPage = vi.fn();
    const host = document.createElement("div");
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => loading.shift()!), annotationMode: 0 },
      canvasHost: host,
      onCommitted: (count, _displayName, _document, openedSession, openedOwnerGeneration) =>
        committed.push({
          count,
          sessionId: openedSession.sessionId,
          documentGeneration: openedSession.documentGeneration,
          ownerGeneration: openedOwnerGeneration,
        }),
      onPage,
      onStatus: vi.fn(),
    });
    await controller.open(10);
    const canvas = publishedCanvas(host);
    await controller.open(11);
    expect(onPage).toHaveBeenCalledWith(1, expect.objectContaining({ scale: 1, rotation: 0 }));

    expect(committed).toEqual([{ count: 2, sessionId: "one", documentGeneration: 1, ownerGeneration: 10 }]);
    expect(publishedCanvas(host)).toBe(canvas);
    expect(native.closeSession).toHaveBeenCalledTimes(1);
    expect(native.closeSession.mock.calls[0]?.[2]).toBe(11);
    await controller.dispose();
    expect(native.closeSession).toHaveBeenCalledTimes(2);
    expect(native.closeSession.mock.calls[1]?.[2]).toBe(10);
  });

  it("closes a dialog session that resolves after controller disposal", async () => {
    const pendingSession = deferred<ReturnType<typeof session>>();
    const native = nativeBoundary(vi.fn(() => pendingSession.promise));
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    const opening = controller.open(42);
    await Promise.resolve();
    await controller.dispose();
    pendingSession.resolve(session("late", 7));
    await opening;

    expect(native.cancelSession).toHaveBeenCalledOnce();
    expect(native.closeSession).toHaveBeenCalledOnce();
    expect(native.closeSession.mock.calls[0]?.[2]).toBe(42);
  });

  it("surfaces cleanup failure instead of masking it behind window teardown", async () => {
    const pendingSession = deferred<ReturnType<typeof session>>();
    const native = nativeBoundary(vi.fn(() => pendingSession.promise));
    native.closeSession.mockRejectedValue(new Error("close failed"));
    const statuses: string[] = [];
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: (message) => statuses.push(message),
    });

    const opening = controller.open(43);
    await Promise.resolve();
    await controller.dispose();
    pendingSession.resolve(session("late-failure", 8));
    await opening;

    expect(statuses.at(-1)).toMatch(/could not be released/i);
  });

  it("retains failed session metadata and retries exact cleanup before another open", async () => {
    const native = nativeBoundary(vi.fn()
      .mockResolvedValueOnce(session("cleanup-retry", 9))
      .mockResolvedValueOnce(null));
    native.closeSession
      .mockRejectedValueOnce(new Error("first close failed"))
      .mockResolvedValueOnce(undefined);
    const rejectedTask: PdfLoadingTask = {
      promise: Promise.reject(new Error("Malformed PDF")),
      destroy: vi.fn(),
    };
    const statuses: string[] = [];
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => rejectedTask), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: (message) => statuses.push(message),
    });

    await controller.open(9);
    expect(native.closeSession).toHaveBeenCalledTimes(1);
    expect(statuses).toContain("A PDF session could not be released. Close and reopen Modeleaf before opening more files.");

    await controller.open(9);
    expect(native.closeSession).toHaveBeenCalledTimes(2);
    expect(statuses.filter((status) => status === "A PDF session could not be released. Close and reopen Modeleaf before opening more files.")).toHaveLength(1);
    expect(native.openPdfDialog).toHaveBeenCalledTimes(2);
    expect(rejectedTask.destroy).toHaveBeenCalledOnce();
    expect(native.closeSession.mock.calls[1]?.[0]).toEqual(native.closeSession.mock.calls[0]?.[0]);
    expect(native.closeSession.mock.invocationCallOrder[1]).toBeLessThan(native.openPdfDialog.mock.invocationCallOrder[1]!);
    await controller.dispose();
  });
  it("quarantines a synchronous PDF.js destroy failure and blocks later opens", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const first = documentWith(1);
    first.destroy = vi.fn(() => { throw new Error("destroy failed"); });
    const second = documentWith(1);
    const native = nativeBoundary(vi.fn()
      .mockResolvedValueOnce(session("destroy-failure", 1))
      .mockResolvedValueOnce(session("healthy-successor", 2))
      .mockResolvedValueOnce(session("must-not-open", 3)));
    const documents = [task(first), task(second)];
    const statuses: string[] = [];
    const resources = new ResourceReservationManager();
    const controller = new PdfReaderController({
      native,
      resources,
      pdf: { getDocument: vi.fn(() => documents.shift()!), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: (message) => statuses.push(message),
    });

    await controller.open(1);
    await controller.open(1);
    await controller.open(1);

    expect(native.openPdfDialog).toHaveBeenCalledTimes(2);
    expect(native.cancelSession).toHaveBeenCalledOnce();
    expect(statuses).toContain("A PDF renderer could not be released. Close and reopen Modeleaf before opening more files.");
    expect(native.closeSession).toHaveBeenCalledOnce();
    expect(resources.snapshot().totals["canvas-bytes"]).toBe(20 * 30 * 4);
  });
  it("waits for content ownership before destroying a replaced PDF", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const first = documentWith(1);
    const second = documentWith(1);
    const releaseContent = deferred<void>();
    const native = nativeBoundary(vi.fn()
      .mockResolvedValueOnce(session("content-owner", 1))
      .mockResolvedValueOnce(session("content-successor", 2)));
    const documents = [task(first), task(second)];
    const committed = vi.fn();
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => documents.shift()!), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: committed,
      onPage: vi.fn(),
      onBeforeDispose: (openedSession) => openedSession.sessionId === "content-owner"
        ? releaseContent.promise
        : Promise.resolve(),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    const replacing = controller.open(1);
    let replacementSettled = false;
    void replacing.then(() => {
      replacementSettled = true;
    });
    await vi.waitFor(() => expect(committed).toHaveBeenCalledTimes(2));
    expect(first.destroy).not.toHaveBeenCalled();

    expect(replacementSettled).toBe(false);
    releaseContent.resolve();
    await replacing;
    expect(first.destroy).toHaveBeenCalledOnce();
    await controller.dispose();
  });
  it("retries the rejected prior content owner before its PDF and native session release", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const first = documentWith(1);
    const second = documentWith(1);
    const third = documentWith(1);
    const documents = [first, second, third];
    const native = nativeBoundary(vi.fn()
      .mockResolvedValueOnce(session("prior-content", 1))
      .mockResolvedValueOnce(session("active-successor", 2))
      .mockResolvedValueOnce(session("retry-successor", 3)));
    let priorUnmountAttempts = 0;
    const priorUnmount = vi.fn<() => Promise<void>>(() => {
      priorUnmountAttempts += 1;
      return priorUnmountAttempts === 1
        ? Promise.reject(new Error("transient prior content teardown failure"))
        : Promise.resolve();
    });
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => task(documents.shift()!)), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onBeforeDispose: (openedSession) => openedSession.sessionId === "prior-content"
        ? priorUnmount()
        : Promise.resolve(),
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    await controller.open(1);
    expect(priorUnmount).toHaveBeenCalledOnce();
    expect(first.destroy).not.toHaveBeenCalled();
    expect(native.cancelSession).not.toHaveBeenCalled();
    expect(native.closeSession).not.toHaveBeenCalled();

    await controller.open(1);
    expect(priorUnmount).toHaveBeenCalledTimes(2);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(native.cancelSession.mock.calls[0]?.[0]).toMatchObject({ sessionId: "prior-content" });
    expect(vi.mocked(first.destroy).mock.invocationCallOrder[0]).toBeLessThan(native.cancelSession.mock.invocationCallOrder[0]!);
    await controller.dispose();
  });
  it("retains a delayed adapter teardown as the sole cancel and close owner until it completes", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
      const close = deferred<undefined>();
      const native = nativeBoundary(vi.fn().mockResolvedValue(session("delayed-cleanup", 1)));
      native.closeSession.mockImplementation(() => close.promise);
      const controller = new PdfReaderController({
        native,
        resources: new ResourceReservationManager(),
        pdf: { getDocument: vi.fn(() => task(documentWith(1))), annotationMode: 0 },
        canvasHost: document.createElement("div"),
        onCommitted: vi.fn(),
        onPage: vi.fn(),
        onStatus: vi.fn(),
      });

      await controller.open(1);
      const disposing = controller.dispose();
      const rejected = expect(disposing).rejects.toThrow("PDF_OWNERSHIP_INCOMPLETE");
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;

      expect(native.cancelSession).toHaveBeenCalledOnce();
      expect(native.closeSession).toHaveBeenCalledOnce();

      close.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
      await vi.runAllTimersAsync();
      await controller.dispose();

      expect(native.cancelSession).toHaveBeenCalledOnce();
      expect(native.closeSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("retains native authority until a timed-out PDF destroy settles", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
      const destroy = deferred<void>();
      const pdf = documentWith(1);
      pdf.destroy = vi.fn(() => destroy.promise);
      const native = nativeBoundary(vi.fn().mockResolvedValue(session("delayed-pdf-destroy", 1)));
      const controller = new PdfReaderController({
        native,
        resources: new ResourceReservationManager(),
        pdf: { getDocument: vi.fn(() => task(pdf)), annotationMode: 0 },
        canvasHost: document.createElement("div"),
        onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(),
      });

      await controller.open(1);
      const disposing = controller.dispose();
      const rejected = expect(disposing).rejects.toThrow("PDF_OWNERSHIP_INCOMPLETE");
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(pdf.destroy).toHaveBeenCalledOnce();
      expect(native.cancelSession).not.toHaveBeenCalled();
      expect(native.closeSession).not.toHaveBeenCalled();

      destroy.resolve(undefined);
      await vi.runAllTimersAsync();
      expect(native.cancelSession).toHaveBeenCalledOnce();
      expect(native.closeSession).toHaveBeenCalledOnce();
      await controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("retries a late rejected adapter teardown with the exact session before opening", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
      const lateClose = deferred<undefined>();
      const native = nativeBoundary(vi.fn()
        .mockResolvedValueOnce(session("adapter-retry", 11))
        .mockResolvedValueOnce(session("replacement", 12))
        .mockResolvedValueOnce(session("healthy-after-retry", 13)));
      native.closeSession
        .mockImplementationOnce(() => lateClose.promise)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);
      const documents = [documentWith(1), documentWith(1), documentWith(1)];
      const statuses: string[] = [];
      const controller = new PdfReaderController({
        native,
        resources: new ResourceReservationManager(),
        pdf: { getDocument: vi.fn(() => task(documents.shift()!)), annotationMode: 0 },
        canvasHost: document.createElement("div"),
        onCommitted: vi.fn(), onPage: vi.fn(), onStatus: (message) => statuses.push(message),
      });

      await controller.open(1);
      const replacement = controller.open(2);
      await vi.advanceTimersByTimeAsync(15_000);
      await replacement;
      expect(native.closeSession).toHaveBeenCalledOnce();

      lateClose.reject(new Error("late close failed"));
      await Promise.resolve();
      await Promise.resolve();

      await controller.open(3);
      expect(native.openPdfDialog).toHaveBeenCalledTimes(3);
      expect(native.closeSession).toHaveBeenCalledTimes(3);
      expect(native.closeSession.mock.calls[1]?.[0]).toEqual(native.closeSession.mock.calls[0]?.[0]);
      expect(native.closeSession.mock.invocationCallOrder[1]).toBeLessThan(native.openPdfDialog.mock.invocationCallOrder[2]!);
      expect(statuses.filter((status) => status === "A PDF session could not be released. Close and reopen Modeleaf before opening more files.")).toHaveLength(1);
      await controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("renders exact pages and prevents a stale render from replacing the newest canvas", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const slow = deferred<void>();
    const cancelSlow = vi.fn(() => {
      const error = Object.assign(new Error("Rendering cancelled, page 2"), { name: "RenderingCancelledException" });
      slow.reject(error);
    });
    const getPage = vi.fn(async (pageNumber: number) =>
      pageNumber === 2 ? page(2, slow.promise, cancelSlow) : page(pageNumber));
    const native = nativeBoundary(vi.fn().mockResolvedValue(session("nav", 1)));
    const host = document.createElement("div");
    const visited: number[] = [];
    const statuses: string[] = [];
    const resources = new ResourceReservationManager();
    const controller = new PdfReaderController({
      native,
      resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(3, getPage))), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onPage: (value) => visited.push(value),
      onStatus: (message) => statuses.push(message),
    });

    await controller.open(3);
    const stale = controller.renderPage(2);
    await vi.waitFor(() => expect(resources.snapshot().totals.render).toBe(1));
    const latest = controller.renderPage(3);
    const latestResult = await latest;
    const staleResult = await stale;

    expect(cancelSlow).toHaveBeenCalledOnce();
    expect(publishedCanvas(host).dataset.page).toBe("3");
    expect(visited).toEqual([1, 3]);
    expect(latestResult).toBe(true);
    expect(staleResult).toBe(false);
    expect(statuses).not.toContain("Opening PDF cancelled.");
    await controller.dispose();
    expect(native.closeSession).toHaveBeenCalledOnce();
  });

  it("synchronizes a visible ±2 continuous window with ordered spacers and zeroes evicted backing stores", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const resources = new ResourceReservationManager();
    const host = document.createElement("div");
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("continuous-window", 1))),
      resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(5))), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(),
    });

    await controller.open(1);
    expect(await controller.synchronizeViewport(84, 30)).toBe(true);
    const frames = [...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")];
    expect(frames.map((frame) => frame.dataset.page)).toEqual(["1", "2", "3", "4", "5"]);
    expect([...host.children].map((child) => child.className)).toEqual([
      "pdf-page-spacer pdf-page-spacer-top",
      "pdf-page-frame", "pdf-page-frame", "pdf-page-frame", "pdf-page-frame", "pdf-page-frame",
      "pdf-page-spacer pdf-page-spacer-bottom",
    ]);
    for (const frame of frames) {
      expect([...frame.children].map((child) => child.className)).toEqual([
        "pdf-page pdf-page-canvas-layer", "pdf-page-text-layer", "pdf-page-annotation-layer",
      ]);
    }
    expect(resources.snapshot().totals["canvas-bytes"]).toBe(5 * 20 * 30 * 4);
    const evicted = [
      host.querySelector<HTMLCanvasElement>(":scope > .pdf-page-frame[data-page='1'] > .pdf-page-canvas-layer")!,
      host.querySelector<HTMLCanvasElement>(":scope > .pdf-page-frame[data-page='2'] > .pdf-page-canvas-layer")!,
    ];

    expect(await controller.synchronizeViewport(168, 30)).toBe(true);
    expect([...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")].map((frame) => frame.dataset.page)).toEqual(["3", "4", "5"]);
    expect(evicted.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
    expect(resources.snapshot().totals["canvas-bytes"]).toBe(3 * 20 * 30 * 4);

    const remaining = [...host.querySelectorAll<HTMLCanvasElement>(":scope > .pdf-page-frame > .pdf-page-canvas-layer")];
    expect(await controller.setViewTransform({ scale: 2, rotation: 90, devicePixelRatio: 1.5 })).toBe(true);
    expect(remaining.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
    const transformed = [...host.querySelectorAll<HTMLCanvasElement>(":scope > .pdf-page-frame > .pdf-page-canvas-layer")];
    expect(transformed).toHaveLength(1);
    expect(transformed[0]?.dataset).toMatchObject({ scale: "2", rotation: "90", devicePixelRatio: "1.5" });
    await controller.dispose();
    expect(transformed.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
    resources.assertEmpty();
  });
  it("keeps the committed resident window when eviction-only native publication fails", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    const resources = new ResourceReservationManager();
    const compensationFinalize = vi.fn();
    const publishResidents = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValueOnce({ rollback: vi.fn(async () => undefined), finalize: compensationFinalize });
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("resident-authority", 1))), resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(5))), annotationMode: 0 }, canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(), onBeforeResidentCommit: publishResidents,
    });
    await controller.open(1);
    expect(await controller.synchronizeViewport(84, 30)).toBe(true);
    const committedPages = ["1", "2", "3", "4", "5"];
    expect([...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")].map((frame) => frame.dataset.page)).toEqual(committedPages);

    await expect(controller.synchronizeViewport(0, 0)).rejects.toThrow("registry unavailable");
    expect([...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")].map((frame) => frame.dataset.page)).toEqual(committedPages);
    expect(publishedCanvas(host).dataset.page).toBe("3");
    expect(publishResidents).toHaveBeenLastCalledWith([1, 2, 3, 4, 5]);
    expect(compensationFinalize).toHaveBeenCalledOnce();
    await controller.dispose();
    resources.assertEmpty();
  });
  it("reports incomplete ownership when committed native authority cannot rollback", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    const resources = new ResourceReservationManager();
    let guardCurrent = true;
    const rollback = vi.fn(async () => { throw new Error("native rollback failed"); });
    const publishResidents = vi.fn()
      .mockResolvedValueOnce({ rollback: vi.fn(async () => undefined), finalize: vi.fn() })
      .mockImplementationOnce(async () => {
        guardCurrent = false;
        return { rollback, finalize: vi.fn() };
      });
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("authority-incomplete", 1))), resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(5))), annotationMode: 0 }, canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(), onBeforeResidentCommit: publishResidents,
    });
    await controller.open(1);
    expect(await controller.synchronizeViewport(84, 30)).toBe(true);

    await expect(controller.synchronizeViewport(0, 0, () => guardCurrent)).rejects.toThrow("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
    expect(rollback).toHaveBeenCalledOnce();
    expect([...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")].map((frame) => frame.dataset.page)).toEqual(["1", "2", "3", "4", "5"]);
    await controller.dispose();
    resources.assertEmpty();
  });
  it("releases forward resident authority before disjoint rollback renders", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    const resources = new ResourceReservationManager();
    const events: string[] = [];
    let guardCurrent = true;
    let rollbackStarted = false;
    const compensationFinalize = vi.fn(() => { events.push("authority-restored"); });
    const publishResidents = vi.fn()
      .mockResolvedValueOnce({ rollback: vi.fn(async () => undefined), finalize: vi.fn() })
      .mockImplementationOnce(async () => {
        guardCurrent = false;
        return { rollback: vi.fn(async () => { rollbackStarted = true; events.push("authority-rolled-back"); }), finalize: vi.fn() };
      })
      .mockResolvedValueOnce({ rollback: vi.fn(async () => undefined), finalize: compensationFinalize });
    const getPage = vi.fn(async (pageNumber: number): Promise<PdfPage> => {
      if (rollbackStarted && pageNumber <= 5) events.push(`rollback-render-${pageNumber}`);
      return page(pageNumber);
    });
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("authority-order", 1))), resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(10, getPage))), annotationMode: 0 }, canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(), onBeforeResidentCommit: publishResidents,
    });
    await controller.open(1);
    expect(await controller.synchronizeViewport(84, 30)).toBe(true);

    expect(await controller.synchronizeViewport(300, 120, () => guardCurrent)).toBe(false);
    expect(events[0]).toBe("authority-rolled-back");
    expect(events.some((event) => event.startsWith("rollback-render-"))).toBe(true);
    expect(events.at(-1)).toBe("authority-restored");
    expect(compensationFinalize).toHaveBeenCalledOnce();
    await controller.dispose();
    resources.assertEmpty();
  });
  it("reconciles the exact physical subset when viewport rollback rendering fails", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    const resources = new ResourceReservationManager();
    let guardCurrent = true;
    let rollbackStarted = false;
    const compensationFinalize = vi.fn();
    const publishResidents = vi.fn()
      .mockResolvedValueOnce({ rollback: vi.fn(async () => undefined), finalize: vi.fn() })
      .mockImplementationOnce(async () => {
        guardCurrent = false;
        return { rollback: vi.fn(async () => { rollbackStarted = true; }), finalize: vi.fn() };
      })
      .mockResolvedValueOnce({ rollback: vi.fn(async () => undefined), finalize: compensationFinalize });
    const getPage = vi.fn(async (pageNumber: number): Promise<PdfPage> => page(
      pageNumber,
      rollbackStarted && pageNumber <= 5 ? Promise.reject(new Error("rollback page failed")) : Promise.resolve(),
    ));
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("authority-subset", 1))), resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(10, getPage))), annotationMode: 0 }, canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(), onBeforeResidentCommit: publishResidents,
    });
    await controller.open(1);
    expect(await controller.synchronizeViewport(84, 30)).toBe(true);

    await expect(controller.synchronizeViewport(300, 120, () => guardCurrent)).rejects.toThrow("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
    expect(publishResidents).toHaveBeenLastCalledWith([]);
    expect(compensationFinalize).toHaveBeenCalledOnce();
    expect([...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")]).toHaveLength(0);
    expect(controller.activePageNumber).toBeUndefined();
    await controller.dispose();
    resources.assertEmpty();
  });

  it("reconciles the exact physical subset when bounded direct recovery also fails", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    const resources = new ResourceReservationManager();
    let failDirect = false;
    const compensationFinalize = vi.fn();
    const publishResidents = vi.fn()
      .mockResolvedValueOnce({ rollback: vi.fn(async () => undefined), finalize: vi.fn() })
      .mockResolvedValueOnce({ rollback: vi.fn(async () => undefined), finalize: compensationFinalize });
    const getPage = vi.fn(async (pageNumber: number): Promise<PdfPage> => page(
      pageNumber,
      failDirect && (pageNumber === 10 || pageNumber === 1) ? Promise.reject(new Error("direct recovery failed")) : Promise.resolve(),
    ));
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("direct-subset", 1))), resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(10, getPage))), annotationMode: 0 }, canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(), onBeforeResidentCommit: publishResidents,
    });
    await controller.open(1);
    expect(await controller.synchronizeViewport(84, 30)).toBe(true);
    failDirect = true;

    await expect(controller.renderPage(10)).rejects.toThrow("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
    expect(publishResidents).toHaveBeenLastCalledWith([2, 3, 4, 5]);
    expect(compensationFinalize).toHaveBeenCalledOnce();
    expect([...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")].map((frame) => frame.dataset.page)).toEqual(["2", "3", "4", "5"]);
    await controller.dispose();
    resources.assertEmpty();
  });
  it("rolls back newly published residents when a later viewport page fails", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const canvases = new Map<number, HTMLCanvasElement>();
    const getPage = vi.fn(async (pageNumber: number): Promise<PdfPage> => ({
      ...page(pageNumber),
      render: ({ canvas }) => {
        canvases.set(pageNumber, canvas);
        return { promise: pageNumber === 3 ? Promise.reject(new Error("page three failed")) : Promise.resolve(), cancel: vi.fn() };
      },
    }));
    const resources = new ResourceReservationManager();
    const host = document.createElement("div");
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("viewport-rollback", 1))),
      resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(5, getPage))), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(),
    });

    await controller.open(1);
    expect(await controller.synchronizeViewport(84, 30)).toBe(false);
    expect([...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")].map((frame) => frame.dataset.page)).toEqual(["1"]);
    expect(canvases.get(2)?.width).toBe(0);
    expect(canvases.get(2)?.height).toBe(0);
    expect(publishedCanvas(host).dataset.page).toBe("1");
    expect(resources.snapshot().totals["canvas-bytes"]).toBe(20 * 30 * 4);

    await controller.dispose();
    resources.assertEmpty();
  });
  it("rematerializes a disjoint full resident checkpoint within the exact peak cap", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    const resources = new ResourceReservationManager();
    let failPageEight = false;
    let peakCanvasBytes = 0;
    const getPage = vi.fn(async (pageNumber: number): Promise<PdfPage> => {
      const source = page(pageNumber, failPageEight && pageNumber === 8 ? Promise.reject(new Error("page eight failed")) : Promise.resolve());
      return { ...source, render: (options) => {
        const operation = source.render(options);
        peakCanvasBytes = Math.max(peakCanvasBytes, resources.snapshot().totals["canvas-bytes"] ?? 0);
        return operation;
      } };
    });
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("rollback-window", 1))), resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(10, getPage))), annotationMode: 0 }, canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(),
    });
    await controller.open(1);
    expect(await controller.synchronizeViewport(84, 30)).toBe(true);
    expect(publishedCanvas(host).dataset.page).toBe("3");
    failPageEight = true;
    peakCanvasBytes = 0;

    expect(await controller.synchronizeViewport(7 * 42, 30)).toBe(false);
    expect([...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")].map((frame) => frame.dataset.page)).toEqual(["1", "2", "3", "4", "5"]);
    expect(publishedCanvas(host).dataset.page).toBe("3");
    expect(peakCanvasBytes).toBeLessThanOrEqual(5 * 20 * 30 * 4);
    await controller.dispose();
    resources.assertEmpty();
  });
  it("serializes an overlapping latest scroll behind stale viewport rollback", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const delayed = deferred<void>();
    const cancel = vi.fn();
    let pageTwoRequests = 0;
    const getPage = vi.fn(async (pageNumber: number) => {
      if (pageNumber !== 2) return page(pageNumber);
      pageTwoRequests += 1;
      return page(pageNumber, pageTwoRequests === 1 ? delayed.promise : Promise.resolve(), cancel);
    });
    const resources = new ResourceReservationManager();
    const host = document.createElement("div");
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("latest-scroll", 1))),
      resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(5, getPage))), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(),
    });

    await controller.open(1);
    let current = true;
    const stale = controller.synchronizeViewport(0, 30, () => current);
    await vi.waitFor(() => expect(resources.snapshot().totals.render).toBe(1));
    current = false;
    const middle = controller.synchronizeViewport(42, 30, () => true);
    const latest = controller.synchronizeViewport(84, 30, () => true);
    expect(cancel).toHaveBeenCalledOnce();
    delayed.resolve();
    expect(await stale).toBe(false);
    expect(await middle).toBe(false);
    expect({ result: await latest, pages: [...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")].map((frame) => frame.dataset.page) }).toEqual({ result: true, pages: ["1", "2", "3", "4", "5"] });
    await controller.dispose();
    resources.assertEmpty();
  });
  it("keeps a stalled direct precommit from replacing a newer no-materialization scroll", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    const resources = new ResourceReservationManager();
    const entered = deferred<void>();
    const release = deferred<void>();
    let stallDirect = false;
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("direct-scroll", 1))), resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(5))), annotationMode: 0 }, canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(),
      onBeforeCommit: async (rendered, commit) => {
        if (stallDirect && rendered.pageNumber === 1) { entered.resolve(); await release.promise; }
        commit();
      },
    });
    await controller.open(1);
    expect(await controller.synchronizeViewport(84, 30)).toBe(true);
    stallDirect = true;
    const direct = controller.renderPage(1);
    await entered.promise;
    const scroll = controller.synchronizeViewport(84, 30);
    let scrollSettled = false;
    void scroll.finally(() => { scrollSettled = true; });
    await Promise.resolve();
    expect(scrollSettled).toBe(false);
    release.resolve();

    expect(await direct).toBe(false);
    expect(await scroll).toBe(true);
    expect(publishedCanvas(host).dataset.page).toBe("3");
    await controller.dispose();
    resources.assertEmpty();
  });
  it("uses explicit available host width for the opening Fit Width transform", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const resources = new ResourceReservationManager();
    const onPage = vi.fn();
    const fitted = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("fit-width", 1))),
      resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(1))), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      availableContentSize: () => ({ width: 50, height: 100 }),
      onCommitted: vi.fn(), onPage, onStatus: vi.fn(),
    });
    await fitted.open(1);
    expect(onPage).toHaveBeenCalledWith(1, expect.objectContaining({ scale: 2.5, rotation: 0 }));
    await fitted.dispose();
    resources.assertEmpty();
  });
  it("positions the host explicitly after direct far-page navigation", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    const resources = new ResourceReservationManager();
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("direct-far", 1))), resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(300))), annotationMode: 0 }, canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(),
    });
    await controller.open(1);
    expect(await controller.renderPage(200)).toBe(true);
    expect(host.scrollTop).toBe(199 * 42);
    expect(publishedCanvas(host).dataset.page).toBe("200");
    await controller.dispose();
    resources.assertEmpty();
  });
  it("synchronizes a far 300-page viewport and refreshes every backing across DPR-only rerender", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    const onPage = vi.fn();
    const resources = new ResourceReservationManager();
    let peakCanvasBytes = 0;
    const getPage = vi.fn(async (pageNumber: number): Promise<PdfPage> => {
      const source = page(pageNumber);
      return {
        ...source,
        render: (options) => {
          const operation = source.render(options);
          peakCanvasBytes = Math.max(peakCanvasBytes, resources.snapshot().totals["canvas-bytes"] ?? 0);
          return operation;
        },
      };
    });
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("far-window", 1))), resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(300, getPage))), annotationMode: 0 }, canvasHost: host,
      onCommitted: vi.fn(), onPage, onStatus: vi.fn(),
    });
    await controller.open(1);
    peakCanvasBytes = 0;
    expect(await controller.synchronizeViewport(199 * 42, 30)).toBe(true);
    const plannedPages = [...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")].map((frame) => frame.dataset.page);
    const spacerHeights = [...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-spacer")].map((spacer) => spacer.style.height);
    expect(plannedPages).toEqual(["198", "199", "200", "201", "202"]);
    expect(peakCanvasBytes).toBeLessThanOrEqual(5 * 20 * 30 * 4);
    expect(onPage).toHaveBeenLastCalledWith(200, expect.objectContaining({ scale: 1, rotation: 0 }));
    peakCanvasBytes = 0;
    expect(await controller.setViewTransform({ scale: 1, rotation: 0, devicePixelRatio: 2 })).toBe(true);
    expect([...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")].map((frame) => frame.dataset.page)).toEqual(plannedPages);
    expect([...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-spacer")].map((spacer) => spacer.style.height)).toEqual(spacerHeights);
    const residentCanvases = host.querySelectorAll<HTMLCanvasElement>(":scope > .pdf-page-frame > .pdf-page-canvas-layer");
    expect(residentCanvases).toHaveLength(5);
    for (const canvas of residentCanvases) {
      expect(canvas.width).toBe(40);
      expect(canvas.height).toBe(60);
    }
    expect(peakCanvasBytes).toBeLessThanOrEqual(5 * 40 * 60 * 4);
    await controller.dispose();
    resources.assertEmpty();
  });

  it("serializes a scroll behind cancelled all-resident DPR rollback", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    const resources = new ResourceReservationManager();
    const delayed = deferred<void>();
    const cancellation = Object.assign(new Error("Rendering cancelled"), { name: "RenderingCancelledException" });
    let delayRollback = false;
    const rollbackDelay = deferred<void>();
    const rollbackEntered = deferred<void>();
    const cancelRollback = vi.fn();
    const cancel = vi.fn(() => { delayRollback = true; delayed.reject(cancellation); });
    let delayNextPageOne = false;
    const getPage = vi.fn(async (pageNumber: number): Promise<PdfPage> => {
      if (delayNextPageOne && pageNumber === 1) {
        delayNextPageOne = false;
        return page(pageNumber, delayed.promise, cancel);
      }
      if (delayRollback && pageNumber === 1) {
        delayRollback = false;
        rollbackEntered.resolve();
        return page(pageNumber, rollbackDelay.promise, cancelRollback);
      }
      return page(pageNumber);
    });
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("dpr-scroll", 1))), resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(5, getPage))), annotationMode: 0 }, canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(),
    });
    await controller.open(1);
    expect(await controller.synchronizeViewport(84, 30)).toBe(true);
    delayNextPageOne = true;
    const dpr = controller.setViewTransform({ scale: 1, rotation: 0, devicePixelRatio: 2 });
    await vi.waitFor(() => expect(resources.snapshot().totals.render).toBe(1));
    const scroll = controller.synchronizeViewport(84, 30);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await rollbackEntered.promise;
    const latest = controller.synchronizeViewport(84, 30);
    expect(cancelRollback).not.toHaveBeenCalled();
    rollbackDelay.resolve();

    expect(await dpr).toBe(false);
    expect(await scroll).toBe(false);
    expect(await latest).toBe(true);
    const canvases = host.querySelectorAll<HTMLCanvasElement>(":scope > .pdf-page-frame > .pdf-page-canvas-layer");
    expect(canvases).toHaveLength(5);
    expect([...canvases].every((canvas) => canvas.dataset.devicePixelRatio === "1")).toBe(true);
    await controller.dispose();
    resources.assertEmpty();
  });
  it("reconciles and rejects a partial DPR rollback before a truthful retry", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    const resources = new ResourceReservationManager();
    let failDpr = false;
    let failedPageOneCalls = 0;
    const compensationFinalize = vi.fn();
    const publishResidents = vi.fn()
      .mockResolvedValueOnce({ rollback: vi.fn(async () => undefined), finalize: vi.fn() })
      .mockResolvedValueOnce({ rollback: vi.fn(async () => undefined), finalize: compensationFinalize });
    const getPage = vi.fn(async (pageNumber: number): Promise<PdfPage> => {
      let rendering = Promise.resolve();
      if (failDpr && pageNumber === 1) {
        failedPageOneCalls += 1;
        if (failedPageOneCalls === 2) rendering = Promise.reject(new Error("DPR rollback failed"));
      }
      if (failDpr && pageNumber === 2) rendering = Promise.reject(new Error("DPR forward failed"));
      return page(pageNumber, rendering);
    });
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("dpr-subset", 1))), resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(5, getPage))), annotationMode: 0 }, canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(), onBeforeResidentCommit: publishResidents,
    });
    await controller.open(1);
    expect(await controller.synchronizeViewport(84, 30)).toBe(true);
    failDpr = true;

    await expect(controller.setViewTransform({ scale: 1, rotation: 0, devicePixelRatio: 2 })).rejects.toThrow("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
    expect(publishResidents).toHaveBeenLastCalledWith([3, 4, 5]);
    expect(compensationFinalize).toHaveBeenCalledOnce();
    expect(controller.activePageNumber).toBe(3);
    expect([...host.querySelectorAll<HTMLCanvasElement>(":scope > .pdf-page-frame > .pdf-page-canvas-layer")].map((canvas) => canvas.dataset.devicePixelRatio)).toEqual(["1", "1", "1"]);

    failDpr = false;
    expect(await controller.setViewTransform({ scale: 1, rotation: 0, devicePixelRatio: 2 })).toBe(true);
    expect([...host.querySelectorAll<HTMLCanvasElement>(":scope > .pdf-page-frame > .pdf-page-canvas-layer")].every((canvas) => canvas.dataset.devicePixelRatio === "2")).toBe(true);
    await controller.dispose();
    resources.assertEmpty();
  });
  it("keeps full-window direct and transform replacement within five backing stores", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    const resources = new ResourceReservationManager();
    let peakCanvasBytes = 0;
    let trackActiveFrame = false;
    let activeFramePreserved = true;
    const getPage = vi.fn(async (pageNumber: number): Promise<PdfPage> => {
      const source = page(pageNumber);
      return { ...source, render: (options) => {
        const operation = source.render(options);
        peakCanvasBytes = Math.max(peakCanvasBytes, resources.snapshot().totals["canvas-bytes"] ?? 0);
        if (trackActiveFrame) activeFramePreserved &&= host.querySelector(":scope > .pdf-page-frame[data-active-page='true']") !== null;
        return operation;
      } };
    });
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("bounded-direct", 1))), resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(10, getPage))), annotationMode: 0 }, canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(),
    });
    await controller.open(1);
    expect(await controller.synchronizeViewport(84, 30)).toBe(true);
    peakCanvasBytes = 0;
    expect(await controller.renderPage(10)).toBe(true);
    expect(peakCanvasBytes).toBeLessThanOrEqual(5 * 20 * 30 * 4);

    expect(await controller.synchronizeViewport(84, 30)).toBe(true);
    peakCanvasBytes = 0;
    trackActiveFrame = true;
    expect(await controller.setViewTransform({ scale: 2, rotation: 90, devicePixelRatio: 1 })).toBe(true);
    expect(peakCanvasBytes).toBeLessThanOrEqual(5 * 40 * 60 * 4);
    expect(activeFramePreserved).toBe(true);
    await controller.dispose();
    resources.assertEmpty();
  });
  it("restores a canonical PDF-space anchor within half a point through zoom and rotation", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    Object.defineProperties(host, {
      clientWidth: { configurable: true, value: 100 }, clientHeight: { configurable: true, value: 80 },
      scrollWidth: { configurable: true, value: 2_000 }, scrollHeight: { configurable: true, value: 2_000 },
    });
    const anchoredPage: PdfPage = {
      getViewport: ({ scale, rotation }) => ({ ...pdfViewport(20 * scale, 30 * scale, scale), rotation,
        convertToPdfPoint: (x: number, y: number) => [x / scale, y / scale] as const,
        convertToViewportPoint: (x: number, y: number) => [x * scale, y * scale] as const }),
      getTextContent: async () => ({ items: [] }), getAnnotations: async () => [],
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    };
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("canonical-anchor", 1))), resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => task(documentWith(1, vi.fn(async () => anchoredPage)))), annotationMode: 0 },
      canvasHost: host, onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(),
    });
    const installOffsets = () => {
      const frame = host.querySelector<HTMLElement>(":scope > .pdf-page-frame")!;
      const canvas = frame.querySelector<HTMLCanvasElement>(":scope > .pdf-page-canvas-layer")!;
      Object.defineProperties(frame, { offsetLeft: { configurable: true, value: 10 }, offsetTop: { configurable: true, value: 20 } });
      Object.defineProperties(canvas, { offsetLeft: { configurable: true, value: 0 }, offsetTop: { configurable: true, value: 0 } });
    };
    await controller.open(1);
    installOffsets();
    host.scrollLeft = 100;
    host.scrollTop = 200;
    const anchor = controller.captureScrollAnchor()!;
    expect(await controller.setViewTransform({ scale: 2, rotation: 90, devicePixelRatio: 1 })).toBe(true);
    installOffsets();
    controller.restoreScrollAnchor(anchor);
    const restored = controller.captureScrollAnchor()!;
    expect(Math.hypot(restored.pagePoint.x - anchor.pagePoint.x, restored.pagePoint.y - anchor.pagePoint.y)).toBeLessThanOrEqual(0.5);
    expect(controller.captureViewportLanding()).toMatchObject({ pageIndex: 0 });
    const landingOutcome = await controller.restoreViewportLanding({ pageIndex: 0, x: 5, y: 5 });
    const negativeOriginOutcome = await controller.restoreViewportLanding({ pageIndex: 0, x: -5, y: -5 });
    const restoreAnchor = vi.spyOn(controller, "restoreScrollAnchor");
    const pageTopOutcome = await controller.restoreViewportLanding({ pageIndex: 0, x: 5, y: 5 }, undefined, undefined, "page-top");
    expect(restoreAnchor.mock.calls.at(-1)?.[0].viewportOffset).toEqual({ x: 50, y: 0 });
    expect(["verified", "constrainedEdgeVerified"]).toContain(pageTopOutcome.kind);
    restoreAnchor.mockRestore();
    expect(negativeOriginOutcome.kind).not.toBe("preflightRejected");
    expect(["verified", "constrainedEdgeVerified"]).toContain(landingOutcome.kind);
    await expect(controller.restoreViewportLanding({ pageIndex: 1, x: 0, y: 0 })).resolves.toEqual({ kind: "preflightRejected" });
    await expect(controller.restoreViewportLanding({ pageIndex: 0, x: 5, y: 5 }, () => false)).resolves.toEqual({ kind: "staleOrCancelled" });
    const rejectedRender = vi.spyOn(controller, "renderPage").mockRejectedValueOnce(new Error("render failed"));
    await expect(controller.restoreViewportLanding({ pageIndex: 0, x: 5, y: 5 })).resolves.toEqual({ kind: "failed" });
    rejectedRender.mockRestore();
    const rejectedGeometry = vi.spyOn(controller, "restoreScrollAnchor").mockImplementationOnce(() => { throw new Error("geometry failed"); });
    await expect(controller.restoreViewportLanding({ pageIndex: 0, x: 5, y: 5 })).resolves.toEqual({ kind: "failed" });
    rejectedGeometry.mockRestore();
    await controller.dispose();
  });
  it("admits one print job and releases its hidden surface after completion", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["png"])));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:print-test") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const resources = new ResourceReservationManager();
    const host = document.createElement("div");
    document.body.append(host);
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("single-print", 1))),
      resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(1))), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });
    await controller.open(1);
    const printGate = deferred<void>();
    const first = controller.printCurrent(() => printGate.promise);
    await vi.waitFor(() => expect(document.querySelectorAll(".pdf-print-page")).toHaveLength(1));

    expect(await controller.printCurrent(vi.fn())).toBe(false);
    printGate.resolve();
    expect(await first).toBe(true);
    expect(document.querySelector(".pdf-print-surface")).toBeNull();

    await controller.dispose();
    resources.assertEmpty();
    host.remove();
  });

  it("aborts and releases an in-flight print before disposing the document", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:print-test") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const printRender = deferred<void>();
    const cancelPrint = vi.fn(() => printRender.reject(Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" })));
    let renderCount = 0;
    let printCanvas: HTMLCanvasElement | undefined;
    const printablePage: PdfPage = {
      getViewport: () => pdfViewport(20, 30),
      getTextContent: async () => ({ items: [] }),
      getAnnotations: async () => [],
      render: ({ canvas }) => {
        renderCount += 1;
        if (renderCount === 1) return { promise: Promise.resolve(), cancel: vi.fn() };
        printCanvas = canvas;
        return { promise: printRender.promise, cancel: cancelPrint };
      },
    };
    const documentBoundary = documentWith(1, vi.fn(async () => printablePage));
    const resources = new ResourceReservationManager();
    const host = document.createElement("div");
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("cancel-print", 1))),
      resources,
      pdf: { getDocument: vi.fn(() => task(documentBoundary)), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });
    await controller.open(1);
    const printing = controller.printCurrent(vi.fn());
    await vi.waitFor(() => expect(printCanvas).toBeDefined());

    await controller.suspend();
    expect(await printing).toBe(false);
    expect(cancelPrint).toHaveBeenCalled();
    expect(printCanvas).toMatchObject({ width: 0, height: 0 });
    expect(document.querySelector(".pdf-print-surface")).toBeNull();

    await controller.dispose();
    resources.assertEmpty();
  });
  it("holds the render slot until cancelled work settles and cannot cancel its successor", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const cancelled = deferred<void>();
    const cancelSlow = vi.fn();
    const renderLatest = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
    const getPage = vi.fn(async (pageNumber: number) => {
      if (pageNumber === 2) return page(2, cancelled.promise, cancelSlow);
      if (pageNumber === 3) {
        return {
          getViewport: () => pdfViewport(20, 30),
          getTextContent: async () => ({ items: [] }),
          getAnnotations: async () => [],
          render: renderLatest,
        } satisfies PdfPage;
      }
      return page(pageNumber);
    });
    const resources = new ResourceReservationManager();
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("render-race", 1))),
      resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(3, getPage))), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    const stale = controller.renderPage(2);
    await vi.waitFor(() => expect(resources.snapshot().totals.render).toBe(1));
    const latest = controller.renderPage(3);
    await vi.waitFor(() => expect(cancelSlow).toHaveBeenCalledOnce());

    expect(renderLatest).not.toHaveBeenCalled();
    expect(resources.snapshot().totals.render).toBe(1);
    const cancellation = Object.assign(new Error("Rendering cancelled, page 2"), { name: "RenderingCancelledException" });
    cancelled.reject(cancellation);

    expect(await latest).toBe(true);
    expect(await stale).toBe(false);
    expect(renderLatest).toHaveBeenCalledOnce();
    expect(resources.snapshot().totals.render).toBe(0);
    await controller.dispose();
    resources.assertEmpty();
  });
  it("rejects a zero-page PDF as empty and closes its native session", async () => {
    const native = nativeBoundary(vi.fn().mockResolvedValue(session("empty", 1)));
    const statuses: string[] = [];
    const committed = vi.fn();
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => task(documentWith(0))), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: committed,
      onPage: vi.fn(),
      onStatus: (message) => statuses.push(message),
    });
    await controller.open(1);
    expect(statuses.at(-1)).toBe("PDF contains no pages.");
    expect(committed).not.toHaveBeenCalled();
    expect(native.closeSession).toHaveBeenCalledOnce();
    await controller.dispose();
  });
  it("rejects a locked PDF without replacing the healthy document", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const healthy = task(documentWith(1));
    const pending = deferred<PdfDocument>();
    const protectedTask: PdfLoadingTask = {
      promise: pending.promise,
      destroy: vi.fn(async () => undefined),
    };
    const loading = [healthy, protectedTask];
    const native = nativeBoundary(vi.fn()
      .mockResolvedValueOnce(session("healthy-password", 1))
      .mockResolvedValueOnce(session("cancel-password", 2)));
    const host = document.createElement("div");
    const statuses: string[] = [];
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => loading.shift()!), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: (message) => statuses.push(message),
    });

    await controller.open(1);
    const healthyCanvas = publishedCanvas(host);
    const replacement = controller.open(2);
    await vi.waitFor(() => expect(protectedTask.onPassword).toBeTypeOf("function"));
    protectedTask.onPassword!(() => undefined, 1);
    await replacement;

    expect(publishedCanvas(host)).toBe(healthyCanvas);
    expect(statuses.at(-1)).toBe("Password-protected PDFs are not supported.");
    expect(protectedTask.destroy).toHaveBeenCalledOnce();
    expect(native.closeSession).toHaveBeenCalledOnce();
    await controller.dispose();
  });
  it("rejects a locked candidate and releases all resources", async () => {
    const pending = deferred<PdfDocument>();
    const protectedTask: PdfLoadingTask = {
      promise: pending.promise,
      destroy: vi.fn(async () => undefined),
    };
    const native = nativeBoundary(vi.fn().mockResolvedValue(session("rejected-password-ui", 1)));
    const statuses: string[] = [];
    const resources = new ResourceReservationManager();
    const controller = new PdfReaderController({
      native,
      resources,
      pdf: { getDocument: vi.fn(() => protectedTask), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: (message) => statuses.push(message),
    });

    const opening = controller.open(1);
    await vi.waitFor(() => expect(protectedTask.onPassword).toBeTypeOf("function"));
    protectedTask.onPassword!(() => undefined, 1);
    await opening;

    expect(statuses.at(-1)).toBe("Password-protected PDFs are not supported.");
    expect(protectedTask.destroy).toHaveBeenCalledOnce();
    expect(native.closeSession).toHaveBeenCalledOnce();
    await controller.dispose();
    resources.assertEmpty();
  });
  it("keeps repeated locked callbacks idempotent while releasing the native session", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const pending = deferred<PdfDocument>();
    const loadingTask: PdfLoadingTask = {
      promise: pending.promise,
      destroy: vi.fn(() => {
        pending.reject(new Error("PASSWORD_INCORRECT"));
      }),
    };
    const native = nativeBoundary(vi.fn().mockResolvedValue(session("protected", 1)));
    const statuses: string[] = [];
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => loadingTask), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: (message) => statuses.push(message),
    });

    const opening = controller.open(5);
    await vi.waitFor(() => expect(loadingTask.onPassword).toBeTypeOf("function"));
    loadingTask.onPassword!(() => undefined, 1);
    await Promise.resolve();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      loadingTask.onPassword!(() => undefined, 2);
      await Promise.resolve();
    }
    await opening;

    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toMatch(/password/i);
    expect(native.closeSession).toHaveBeenCalledOnce();
  });

  it("maps locality rejection without disturbing the committed canvas", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const native = nativeBoundary(vi.fn()
      .mockResolvedValueOnce(session("healthy", 1))
      .mockRejectedValueOnce({ tag: "REMOTE_PATH" })
      .mockRejectedValueOnce({ tag: "PATH_REJECTED" }));
    const statuses: string[] = [];
    const host = document.createElement("div");
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => task(documentWith(2))), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: (message) => statuses.push(message),
    });

    await controller.open(1);
    const canvas = publishedCanvas(host);
    await controller.open(2);
    expect(publishedCanvas(host)).toBe(canvas);
    expect(statuses.at(-1)).toBe("Network PDFs are not supported. Copy the PDF to a local drive and open the local copy.");

    await controller.open(3);
    expect(publishedCanvas(host)).toBe(canvas);
    expect(statuses.at(-1)).toBe("This PDF path cannot be opened safely.");
    await controller.dispose();
  });
  it("enforces aggregate canvas reservations while preserving the healthy document", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const hugePage: PdfPage = {
      getViewport: () => pdfViewport(7_000, 7_000),
      getTextContent: async () => ({ items: [] }),
      getAnnotations: async () => [],
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    };
    const loading = [
      task(documentWith(1, vi.fn(async () => hugePage))),
      task(documentWith(1, vi.fn(async () => hugePage))),
    ];
    const resources = new ResourceReservationManager();
    const native = nativeBoundary(vi.fn()
      .mockResolvedValueOnce(session("large-one", 1))
      .mockResolvedValueOnce(session("large-two", 2)));
    const host = document.createElement("div");
    const statuses: string[] = [];
    const controller = new PdfReaderController({
      native,
      resources,
      pdf: { getDocument: vi.fn(() => loading.shift()!), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: (message) => statuses.push(message),
    });

    await controller.open(1);
    const healthyCanvas = publishedCanvas(host);
    await controller.open(2);

    expect(publishedCanvas(host)).toBe(healthyCanvas);
    expect(statuses.at(-1)).toMatch(/resource limits/i);
    expect(resources.snapshot().totals["canvas-bytes"]).toBe(7_000 * 7_000 * 4);
    await controller.dispose();
    resources.assertEmpty();
  });
  it("times out stalled metadata loading and closes the candidate", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<PdfDocument>();
      const loadingTask: PdfLoadingTask = { promise: pending.promise, destroy: vi.fn() };
      const native = nativeBoundary(vi.fn().mockResolvedValue(session("stalled", 1)));
      const statuses: string[] = [];
      const controller = new PdfReaderController({
        native,
        resources: new ResourceReservationManager(),
        pdf: { getDocument: vi.fn(() => loadingTask), annotationMode: 0 },
        canvasHost: document.createElement("div"),
        onCommitted: vi.fn(),
        onPage: vi.fn(),
        onStatus: (message) => statuses.push(message),
      });

      const opening = controller.open(9);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_000);
      await opening;

      expect(statuses.at(-1)).toBe("The PDF operation timed out.");
      expect(loadingTask.destroy).toHaveBeenCalledOnce();
      expect(native.closeSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("renders transforms in CSS pixels while reserving DPR backing bytes and rerenders after resize", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const viewport = vi.fn(({ scale, rotation }: { scale: number; rotation: number }) =>
      pdfViewport(
        20.25 * scale,
        rotation === 90 ? 40.5 * scale : 30.25 * scale,
        scale,
      ));
    const rendered = vi.fn((_options: Parameters<PdfPage["render"]>[0]) => ({ promise: Promise.resolve(), cancel: vi.fn() }));
    const pdfPage: PdfPage = {
      getViewport: viewport,
      getTextContent: async () => ({ items: [] }),
      getAnnotations: async () => [],
      render: rendered,
    };
    const resources = new ResourceReservationManager();
    const host = document.createElement("div");
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("transform", 1))),
      resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(1, vi.fn(async () => pdfPage)))), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    const initialCanvas = publishedCanvas(host);
    await controller.setViewTransform({ scale: 2, rotation: 90, devicePixelRatio: 3 });
    expect(initialCanvas.width).toBe(0);
    expect(initialCanvas.height).toBe(0);
    const canvas = publishedCanvas(host);
    const frame = canvas.parentElement!;
    expect(frame.classList.contains("pdf-page-frame")).toBe(true);
    expect(frame.style.width).toBe("40.5px");
    expect(frame.style.height).toBe("81px");

    expect(viewport).toHaveBeenLastCalledWith({ scale: 2, rotation: 90 });
    expect(canvas.width).toBe(81);
    expect(canvas.height).toBe(162);
    expect(canvas.style.width).toBe("40.5px");
    expect(canvas.style.height).toBe("81px");
    expect(canvas.dataset).toMatchObject({
      page: "1",
      scale: "2",
      rotation: "90",
      devicePixelRatio: "2",
      naturalWidth: "20.25",
      naturalHeight: "40.5",
    });
    expect(rendered.mock.calls.at(-1)?.[0].transform).toEqual([2, 0, 0, 2, 0, 0]);
    expect(resources.snapshot().totals["canvas-bytes"]).toBe(81 * 162 * 4);

    const replacedCanvas = publishedCanvas(host);
    await controller.rerenderForResize();
    expect(viewport).toHaveBeenCalledTimes(4);
    expect(replacedCanvas.width).toBe(0);
    expect(replacedCanvas.height).toBe(0);
    const finalCanvas = publishedCanvas(host);
    await controller.dispose();
    expect(finalCanvas.width).toBe(0);
    expect(finalCanvas.height).toBe(0);
    resources.assertEmpty();
  });

  it("cancels an obsolete transform generation before it can replace the current canvas", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const stalled = deferred<void>();
    const cancel = vi.fn(() => stalled.reject(Object.assign(new Error("Rendering cancelled"), {
      name: "RenderingCancelledException",
    })));
    let renders = 0;
    const pdfPage: PdfPage = {
      getViewport: ({ scale }) => pdfViewport(20 * scale, 30 * scale, scale),
      getTextContent: async () => ({ items: [] }),
      getAnnotations: async () => [],
      render: () => {
        renders += 1;
        return renders === 2 ? { promise: stalled.promise, cancel } : { promise: Promise.resolve(), cancel: vi.fn() };
      },
    };
    const resources = new ResourceReservationManager();
    const host = document.createElement("div");
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("transform-stale", 1))),
      resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(1, vi.fn(async () => pdfPage)))), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    const stale = controller.setViewTransform({ scale: 2, rotation: 0, devicePixelRatio: 1 });
    await vi.waitFor(() => expect(resources.snapshot().totals.render).toBe(1));
    const latest = controller.setViewTransform({ scale: 3, rotation: 90, devicePixelRatio: 1 });

    expect(await latest).toBe(true);
    expect(await stale).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(publishedCanvas(host).dataset).toMatchObject({ scale: "3", rotation: "90" });
    expect(resources.snapshot().totals["canvas-bytes"]).toBe(60 * 90 * 4);
    await controller.dispose();
    resources.assertEmpty();
  });
  it("does not publish page or transform renders whose guard becomes stale during async precommit", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const resources = new ResourceReservationManager();
    const host = document.createElement("div");
    let guardCurrent = true;
    let delay: ReturnType<typeof deferred<void>> | undefined;
    let entered: (() => void) | undefined;
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("guarded", 1))),
      resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(2))), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onBeforeCommit: async (_rendered, commitCanvas, context) => {
        if (!context.opening && delay !== undefined) {
          entered?.();
          await delay.promise;
        }
        commitCanvas();
      },
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    const originalCanvas = publishedCanvas(host);
    const originalBytes = resources.snapshot().totals["canvas-bytes"];

    delay = deferred<void>();
    const pageEntered = deferred<void>();
    entered = () => pageEntered.resolve();
    const stalePage = controller.renderPage(2, undefined, () => guardCurrent);
    await pageEntered.promise;
    guardCurrent = false;
    delay.resolve();
    expect(await stalePage).toBe(false);
    expect(publishedCanvas(host)).toBe(originalCanvas);
    expect(resources.snapshot().totals["canvas-bytes"]).toBe(originalBytes);

    guardCurrent = true;
    delay = deferred<void>();
    const transformEntered = deferred<void>();
    entered = () => transformEntered.resolve();
    const staleTransform = controller.renderPageWithTransform(1, { scale: 2, rotation: 90, devicePixelRatio: 1 }, () => guardCurrent);
    await transformEntered.promise;
    guardCurrent = false;
    delay.resolve();
    expect(await staleTransform).toBe(false);
    expect(publishedCanvas(host)).toBe(originalCanvas);
    expect(publishedCanvas(host).dataset).toMatchObject({ page: "1", scale: "1", rotation: "0" });
    expect(resources.snapshot().totals["canvas-bytes"]).toBe(originalBytes);

    await controller.dispose();
    resources.assertEmpty();
  });
  it("rejects an older async precommit after a newer render commits without an external guard", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const resources = new ResourceReservationManager();
    const host = document.createElement("div");
    const pageTwoEntered = deferred<void>();
    const releasePageTwo = deferred<void>();
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("internal-render-generation", 1))),
      resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(3))), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onBeforeCommit: async (rendered, commitCanvas, context) => {
        if (!context.opening && rendered.pageNumber === 2) {
          pageTwoEntered.resolve();
          await releasePageTwo.promise;
        }
        commitCanvas();
      },
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    const older = controller.renderPage(2);
    await pageTwoEntered.promise;
    expect(await controller.renderPage(3)).toBe(true);
    releasePageTwo.resolve();
    expect(await older).toBe(false);
    expect(publishedCanvas(host).dataset.page).toBe("3");
    await controller.dispose();
    resources.assertEmpty();
  });
  it("keeps a committed canvas reservation and state when its precommit hook becomes stale", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const resources = new ResourceReservationManager();
    const host = document.createElement("div");
    const afterCommit = deferred<void>();
    const committed = deferred<void>();
    let guardCurrent = true;
    const pages: number[] = [];
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("post-commit-guard", 1))),
      resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(2))), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onBeforeCommit: async (rendered, commitCanvas, context) => {
        commitCanvas();
        if (!context.opening && rendered.pageNumber === 2) {
          committed.resolve();
          await afterCommit.promise;
        }
      },
      onPage: (pageNumber) => pages.push(pageNumber),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    const first = controller.renderPage(2, { scale: 2, rotation: 0, devicePixelRatio: 1 }, () => guardCurrent);
    await committed.promise;
    const committedCanvas = publishedCanvas(host);
    expect(committedCanvas.dataset).toMatchObject({ page: "2", scale: "2" });

    guardCurrent = false;
    const successor = controller.renderPageWithTransform(1, { scale: 3, rotation: 90, devicePixelRatio: 1 });
    expect(await successor).toBe(true);
    const successorCanvas = publishedCanvas(host);
    expect(successorCanvas.dataset).toMatchObject({ page: "1", scale: "3", rotation: "90" });

    afterCommit.resolve();
    expect(await first).toBe(true);
    expect(publishedCanvas(host)).toBe(successorCanvas);
    expect(resources.snapshot().totals["canvas-bytes"]).toBe(20 * 30 * 4);
    expect(pages).toEqual([1, 2, 1]);

    await controller.dispose();
    resources.assertEmpty();
  });
  it("commits a replacement canvas only after its overlay transaction succeeds", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const resources = new ResourceReservationManager();
    const host = document.createElement("div");
    let rejectOverlay = true;
    const beforeCommit = vi.fn(async (_rendered, commitCanvas: (accessory?: HTMLElement) => boolean, context: { readonly opening: boolean }) => {
      if (!context.opening && rejectOverlay) throw new Error("overlay failed");
      const overlay = document.createElement("div");
      overlay.dataset.opening = String(context.opening);
      commitCanvas(overlay);
    });
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("atomic-overlay", 1))),
      resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(2))), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onBeforeCommit: beforeCommit,
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    const originalCanvas = publishedCanvas(host);
    const initialAccessory = host.querySelector<HTMLElement>(":scope > .pdf-page-frame[data-active-page='true'] > .pdf-page-text-layer > :only-child");
    expect(initialAccessory?.dataset.opening).toBe("true");
    expect(await controller.renderPage(2)).toBe(false);
    expect(publishedCanvas(host)).toBe(originalCanvas);
    rejectOverlay = false;
    expect(await controller.renderPage(2)).toBe(true);
    expect(publishedCanvas(host)).not.toBe(originalCanvas);
    expect(publishedCanvas(host).dataset.page).toBe("2");
    expect(host.querySelectorAll(":scope > .pdf-page-frame")).toHaveLength(2);
    expect(host.querySelectorAll(":scope > .pdf-page-spacer")).toHaveLength(2);
    const replacementAccessory = host.querySelector<HTMLElement>(":scope > .pdf-page-frame[data-active-page='true'] > .pdf-page-text-layer > :only-child");
    expect(replacementAccessory?.dataset.opening).toBe("false");
    expect(replacementAccessory?.parentElement?.classList.contains("pdf-page-text-layer")).toBe(true);
    expect(replacementAccessory?.closest(".pdf-page-frame")).toBe(publishedCanvas(host).parentElement);
    await controller.dispose();
    resources.assertEmpty();
  });
  it("preserves the healthy raster when a candidate initial overlay fails", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const first = documentWith(1);
    const second = documentWith(1);
    const loading = [task(first), task(second)];
    const host = document.createElement("div");
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn()
        .mockResolvedValueOnce(session("healthy-overlay", 1))
        .mockResolvedValueOnce(session("failed-overlay", 2))),
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => loading.shift()!), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onBeforeCommit: async (_rendered, commitCanvas, context) => {
        if (context.session.sessionId === "failed-overlay") throw new Error("overlay failed");
        commitCanvas();
      },
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    const healthyCanvas = publishedCanvas(host);
    await controller.open(1);

    expect(publishedCanvas(host)).toBe(healthyCanvas);
    expect(first.destroy).not.toHaveBeenCalled();
    expect(second.destroy).toHaveBeenCalledOnce();
    await controller.dispose();
  });
  it("restores the controller transform after a failed precommit", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const getViewport = vi.fn(({ scale, rotation }) => pdfViewport(20 * scale, 30 * scale, scale));
    const pdfPage = page(1);
    pdfPage.getViewport = getViewport;
    let rejectTransform = false;
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("view-rollback", 1))),
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => task(documentWith(1, vi.fn(async () => pdfPage)))), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onBeforeCommit: async (_rendered, commitCanvas, context) => {
        if (!context.opening && rejectTransform) throw new Error("overlay failed");
        commitCanvas();
      },
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    rejectTransform = true;
    await expect(controller.setViewTransform({ scale: 2, rotation: 90, devicePixelRatio: 1 })).rejects.toThrow("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
    rejectTransform = false;
    expect(await controller.renderPage(1)).toBe(true);

    expect(getViewport).toHaveBeenLastCalledWith({ scale: 1, rotation: 0 });
    await controller.dispose();
  });
  it("settles a superseded opening overlay before destroying its PDF", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const overlay = deferred<void>();
    const first = documentWith(1);
    const second = documentWith(1);
    const documents = [task(first), task(second)];
    let staged = false;
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn()
        .mockResolvedValueOnce(session("staged-first", 1))
        .mockResolvedValueOnce(session("staged-second", 2))),
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => documents.shift()!), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onBeforeCommit: async (_rendered, commitCanvas, context) => {
        if (context.session.sessionId === "staged-first") {
          let settlement: Promise<void> | undefined;
          if (!context.opening) throw new Error("Expected opening commit context");
          context.registerStagedTeardown(() => settlement ??= overlay.promise);
          staged = true;
          await overlay.promise;
        }
        commitCanvas();
      },
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    const firstOpen = controller.open(1);
    await vi.waitFor(() => expect(staged).toBe(true));
    const successor = controller.open(2);
    await Promise.resolve();
    expect(first.destroy).not.toHaveBeenCalled();
    overlay.resolve();
    await Promise.all([firstOpen, successor]);
    expect(first.destroy).toHaveBeenCalledOnce();
    await controller.dispose();
  });
  it("settles an opening overlay before disposal destroys its PDF", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const overlay = deferred<void>();
    const pdf = documentWith(1);
    let staged = false;
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("staged-dispose", 1))),
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => task(pdf)), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onBeforeCommit: async (_rendered, _commitCanvas, context) => {
        let settlement: Promise<void> | undefined;
        if (!context.opening) throw new Error("Expected opening commit context");
        context.registerStagedTeardown(() => settlement ??= overlay.promise);
        staged = true;
        await overlay.promise;
      },
      onPage: vi.fn(), onStatus: vi.fn(),
    });

    const opening = controller.open(1);
    await vi.waitFor(() => expect(staged).toBe(true));
    const disposing = controller.dispose();
    await Promise.resolve();
    expect(pdf.destroy).not.toHaveBeenCalled();
    overlay.resolve();
    await Promise.all([opening, disposing]);
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });
  it("retries a late staged teardown fulfillment once without retaining settled ownership", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
      const overlay = deferred<void>();
      const teardown = vi.fn(() => overlay.promise);
      const pdf = documentWith(1);
      let staged = false;
      const controller = new PdfReaderController({
        native: nativeBoundary(vi.fn().mockResolvedValue(session("staged-timeout", 1))),
        resources: new ResourceReservationManager(),
        pdf: { getDocument: vi.fn(() => task(pdf)), annotationMode: 0 },
        canvasHost: document.createElement("div"),
        onCommitted: vi.fn(),
        onBeforeCommit: async (_rendered, _commitCanvas, context) => {
          if (!context.opening) throw new Error("Expected opening commit context");
          context.registerStagedTeardown(teardown);
          staged = true;
          await overlay.promise;
        },
        onPage: vi.fn(), onStatus: vi.fn(),
      });

      const opening = controller.open(1);
      await vi.waitFor(() => expect(staged).toBe(true));
      const disposing = controller.dispose();
      const rejected = expect(disposing).rejects.toThrow("PDF_OWNERSHIP_INCOMPLETE");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(teardown).toHaveBeenCalledOnce();
      expect(pdf.destroy).not.toHaveBeenCalled();

      overlay.resolve();
      await vi.runAllTimersAsync();
      await opening;
      expect(teardown).toHaveBeenCalledOnce();
      await controller.dispose();
      expect(pdf.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("retries a rejected staged teardown before a later open", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const first = documentWith(1);
    const second = documentWith(1);
    const documents = [task(first), task(second)];
    let teardownReady = false;
    const teardown = vi.fn(() => teardownReady
      ? Promise.resolve()
      : Promise.reject(new Error("transient overlay teardown failure")));
    const committed = vi.fn();
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn()
        .mockResolvedValueOnce(session("staged-retry-first", 1))
        .mockResolvedValueOnce(session("staged-retry-second", 2))),
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => documents.shift()!), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: committed,
      onBeforeCommit: async (_rendered, commitCanvas, context) => {
        if (context.session.sessionId === "staged-retry-first") {
          if (!context.opening) throw new Error("Expected opening commit context");
          context.registerStagedTeardown(teardown);
          throw new Error("opening overlay failed");
        }
        commitCanvas();
      },
      onPage: vi.fn(), onStatus: vi.fn(),
    });

    await controller.open(1);
    expect(teardown).toHaveBeenCalledOnce();
    expect(first.destroy).not.toHaveBeenCalled();

    teardownReady = true;
    await controller.open(2);
    expect(teardown).toHaveBeenCalledTimes(2);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(committed).toHaveBeenCalledOnce();
    await controller.dispose();
  });
  it("quarantines timed-out page ownership and retries destruction after settlement", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
      const rawPage = deferred<PdfPage>();
      const pdf = documentWith(2, vi.fn(async (pageNumber: number) => pageNumber === 1 ? page(pageNumber) : rawPage.promise));
      const controller = new PdfReaderController({
        native: nativeBoundary(vi.fn().mockResolvedValue(session("natural-size", 1))),
        resources: new ResourceReservationManager(),
        pdf: { getDocument: vi.fn(() => task(pdf)), annotationMode: 0 },
        canvasHost: document.createElement("div"),
        onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(),
      });
      await controller.open(1);
      const naturalSize = controller.getPageNaturalSize(2, 0);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(naturalSize).resolves.toBeUndefined();
      const disposing = controller.dispose();
      const rejected = expect(disposing).rejects.toThrow("PDF_OWNERSHIP_INCOMPLETE");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      rawPage.resolve(page(2));
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(pdf.destroy).toHaveBeenCalledOnce();
      await controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an opening handoff committed when observers throw and withholds staged teardown from rerenders", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const first = documentWith(2);
    const second = documentWith(2);
    const contexts: Array<{ readonly opening: boolean; readonly registerStagedTeardown?: unknown }> = [];
    const loading = [task(first), task(second)];
    const native = nativeBoundary(vi.fn()
      .mockResolvedValueOnce(session("observer-first", 1))
      .mockResolvedValueOnce(session("observer-second", 2)));
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => loading.shift()!), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: () => { throw new Error("committed observer failed"); },
      onPage: (pageNumber) => {
        if (pageNumber === 1) throw new Error("page observer failed");
      },
      onBeforeCommit: async (_rendered, commitCanvas, context) => {
        contexts.push(context);
        commitCanvas();
      },
      onStatus: vi.fn(),
    });

    await controller.open(1);
    expect(await controller.renderPage(2)).toBe(true);
    const rerenderContext = contexts.find((context) => !context.opening);
    expect(rerenderContext).toBeDefined();
    expect(rerenderContext).not.toHaveProperty("registerStagedTeardown");
    await controller.open(1);
    expect(first.destroy).toHaveBeenCalledOnce();
    await controller.dispose();
  });
  it("does not enter PDF cleanup when content teardown fails", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const pdf = documentWith(1);
    const native = nativeBoundary(vi.fn().mockResolvedValue(session("content-teardown-failure", 1)));
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => task(pdf)), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onBeforeDispose: async () => { throw new Error("content teardown failed"); },
      onStatus: vi.fn(),
    });

    await controller.open(1);
    await expect(controller.dispose()).rejects.toThrow("PDF_OWNERSHIP_INCOMPLETE");

    expect(pdf.destroy).not.toHaveBeenCalled();
    expect(native.cancelSession).not.toHaveBeenCalled();
  });
  it("adopts an opaque session without reopening the dialog", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const native = nativeBoundary(vi.fn());
    const committed = vi.fn();
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => task(documentWith(1))), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: committed,
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    await controller.adopt(session("opaque-adopted", 71), 14);

    expect(native.openPdfDialog).not.toHaveBeenCalled();
    expect(committed).toHaveBeenCalledWith(1, "opaque-adopted.pdf", expect.anything(), expect.objectContaining({ sessionId: "opaque-adopted" }), 14);
    await controller.dispose();
  });

  it("rejects a failed adopted candidate after cleaning it up and preserving the committed document", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const healthy = documentWith(1);
    const failed = documentWith(1, vi.fn(async () => { throw new Error("corrupt"); }));
    const native = nativeBoundary(vi.fn().mockResolvedValue(session("healthy", 1)));
    const host = document.createElement("div");
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn().mockReturnValueOnce(task(healthy)).mockReturnValueOnce(task(failed)), annotationMode: 0 },
      canvasHost: host,
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    const committedCanvas = publishedCanvas(host);
    await expect(controller.adopt(session("failed-adoption", 2), 2)).rejects.toThrow("PDF_ADOPTION_NOT_COMMITTED");

    expect(publishedCanvas(host)).toBe(committedCanvas);
    expect(healthy.destroy).not.toHaveBeenCalled();
    expect(native.openPdfDialog).toHaveBeenCalledOnce();
    expect(failed.destroy).toHaveBeenCalledOnce();
    expect(native.closeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "failed-adoption" }), 7, 2);
    await controller.dispose();
  });

  it("clears physical activity when inactive eviction releases every resident", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    const resources = new ResourceReservationManager();
    let failRestore = false;
    const getPage = vi.fn(async (pageNumber: number): Promise<PdfPage> => page(pageNumber,
      failRestore && pageNumber === 3 ? Promise.reject(new Error("restore failed")) : Promise.resolve()));
    const controller = new PdfReaderController({
      native: nativeBoundary(vi.fn().mockResolvedValue(session("inactive-eviction", 1))), resources,
      pdf: { getDocument: vi.fn(() => task(documentWith(3, getPage))), annotationMode: 0 }, canvasHost: host,
      onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(),
    });
    await controller.open(1);
    expect(await controller.synchronizeViewport(84, 30)).toBe(true);
    expect(controller.activePageNumber).toBe(3);

    expect(controller.evictInactiveCanvas()).toBe(true);
    expect(controller.activePageNumber).toBeUndefined();
    expect(host.querySelectorAll(":scope > .pdf-page-frame")).toHaveLength(0);
    failRestore = true;
    expect(await controller.renderPage(3)).toBe(false);
    expect(controller.activePageNumber).toBeUndefined();
    failRestore = false;
    expect(await controller.renderPage(3)).toBe(true);
    expect(controller.activePageNumber).toBe(3);
    await controller.dispose();
    resources.assertEmpty();
  });
  it("makes duplicate disposal close a native session exactly once", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const native = nativeBoundary(vi.fn().mockResolvedValue(session("duplicate-close", 1)));
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => task(documentWith(1))), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: vi.fn(),
    });

    await controller.open(1);
    await Promise.all([controller.dispose(), controller.dispose()]);

    expect(native.cancelSession).toHaveBeenCalledOnce();
    expect(native.closeSession).toHaveBeenCalledOnce();
  });
});
