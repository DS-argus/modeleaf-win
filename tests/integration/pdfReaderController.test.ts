/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { PdfReaderController, type PdfDocument, type PdfLoadingTask, type PdfPage } from "../../src/pdf/PdfReaderController";
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
  convertToViewportRectangle: (rectangle: readonly number[]) => rectangle,
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

function task(document: PdfDocument): PdfLoadingTask {
  return { promise: Promise.resolve(document), destroy: vi.fn() };
}

function nativeBoundary(openPdfDialog: ReturnType<typeof vi.fn>) {
  return {
    openPdfDialog,
    readRange: vi.fn(async () => new Uint8Array()),
    cancelSession: vi.fn(async (_session: unknown, _ownerGeneration: number) => ({ barrierId: 7 })),
    closeSession: vi.fn(async (_session: unknown, _barrierId: number, _ownerGeneration: number) => undefined),
  };
}

describe("PdfReaderController", () => {
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
      requestPassword: vi.fn(),
    });
    await controller.open(10);
    const canvas = host.firstElementChild;
    await controller.open(11);
    expect(onPage).toHaveBeenCalledWith(1, expect.objectContaining({ scale: 1.25, rotation: 0 }));

    expect(committed).toEqual([{ count: 2, sessionId: "one", documentGeneration: 1, ownerGeneration: 10 }]);
    expect(host.firstElementChild).toBe(canvas);
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
      requestPassword: vi.fn(),
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
      requestPassword: vi.fn(),
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
      requestPassword: vi.fn(),
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
      requestPassword: vi.fn(),
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
      requestPassword: vi.fn(),
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
      requestPassword: vi.fn(),
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
        requestPassword: vi.fn(),
      });

      await controller.open(1);
      const disposing = controller.dispose();
      await vi.advanceTimersByTimeAsync(15_000);
      await disposing;

      expect(native.cancelSession).toHaveBeenCalledOnce();
      expect(native.closeSession).toHaveBeenCalledOnce();

      close.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
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
        onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(), requestPassword: vi.fn(),
      });

      await controller.open(1);
      const disposing = controller.dispose();
      await vi.advanceTimersByTimeAsync(15_000);
      await disposing;
      expect(pdf.destroy).toHaveBeenCalledOnce();
      expect(native.cancelSession).not.toHaveBeenCalled();
      expect(native.closeSession).not.toHaveBeenCalled();

      destroy.resolve(undefined);
      await vi.runAllTimersAsync();
      expect(native.cancelSession).toHaveBeenCalledOnce();
      expect(native.closeSession).toHaveBeenCalledOnce();
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
        onCommitted: vi.fn(), onPage: vi.fn(), onStatus: (message) => statuses.push(message), requestPassword: vi.fn(),
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
      requestPassword: vi.fn(),
    });

    await controller.open(3);
    const stale = controller.renderPage(2);
    await vi.waitFor(() => expect(resources.snapshot().totals.render).toBe(1));
    const latest = controller.renderPage(3);
    const latestResult = await latest;
    const staleResult = await stale;

    expect(cancelSlow).toHaveBeenCalledOnce();
    expect((host.firstElementChild as HTMLCanvasElement).dataset.page).toBe("3");
    expect(visited).toEqual([1, 3]);
    expect(latestResult).toBe(true);
    expect(staleResult).toBe(false);
    expect(statuses).not.toContain("Opening PDF cancelled.");
    await controller.dispose();
    expect(native.closeSession).toHaveBeenCalledOnce();
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
      requestPassword: vi.fn(),
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
  it("cancels a password prompt without replacing the healthy document", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const healthy = task(documentWith(1));
    const pending = deferred<PdfDocument>();
    const protectedTask: PdfLoadingTask = {
      promise: pending.promise,
      destroy: vi.fn(() => pending.reject(new Error("PASSWORD_CANCELLED"))),
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
      requestPassword: vi.fn(async () => null),
    });

    await controller.open(1);
    const healthyCanvas = host.firstElementChild;
    const replacement = controller.open(2);
    await vi.waitFor(() => expect(protectedTask.onPassword).toBeTypeOf("function"));
    protectedTask.onPassword!(() => undefined, 1);
    await replacement;

    expect(host.firstElementChild).toBe(healthyCanvas);
    expect(statuses.at(-1)).toBe("Opening PDF cancelled.");
    expect(protectedTask.destroy).toHaveBeenCalledOnce();
    expect(native.closeSession).toHaveBeenCalledOnce();
    await controller.dispose();
  });
  it("caps incorrect password attempts, destroys the candidate, and releases its native session", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const pending = deferred<PdfDocument>();
    const loadingTask: PdfLoadingTask = {
      promise: pending.promise,
      destroy: vi.fn(() => {
        pending.reject(new Error("PASSWORD_INCORRECT"));
      }),
    };
    const native = nativeBoundary(vi.fn().mockResolvedValue(session("protected", 1)));
    const requestPassword = vi.fn(async () => "wrong");
    const statuses: string[] = [];
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => loadingTask), annotationMode: 0 },
      canvasHost: document.createElement("div"),
      onCommitted: vi.fn(),
      onPage: vi.fn(),
      onStatus: (message) => statuses.push(message),
      requestPassword,
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

    expect(requestPassword).toHaveBeenCalledTimes(5);
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
      requestPassword: vi.fn(),
    });

    await controller.open(1);
    const canvas = host.firstElementChild;
    await controller.open(2);
    expect(host.firstElementChild).toBe(canvas);
    expect(statuses.at(-1)).toBe("Network PDFs are not supported. Copy the PDF to a local drive and open the local copy.");

    await controller.open(3);
    expect(host.firstElementChild).toBe(canvas);
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
      requestPassword: vi.fn(),
    });

    await controller.open(1);
    const healthyCanvas = host.firstElementChild;
    await controller.open(2);

    expect(host.firstElementChild).toBe(healthyCanvas);
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
        requestPassword: vi.fn(),
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
      requestPassword: vi.fn(),
    });

    await controller.open(1);
    await controller.setViewTransform({ scale: 2, rotation: 90, devicePixelRatio: 3 });
    const canvas = host.firstElementChild as HTMLCanvasElement;

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

    await controller.rerenderForResize();
    expect(viewport).toHaveBeenCalledTimes(3);
    await controller.dispose();
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
      requestPassword: vi.fn(),
    });

    await controller.open(1);
    const stale = controller.setViewTransform({ scale: 2, rotation: 0, devicePixelRatio: 1 });
    await vi.waitFor(() => expect(resources.snapshot().totals.render).toBe(1));
    const latest = controller.setViewTransform({ scale: 3, rotation: 90, devicePixelRatio: 1 });

    expect(await latest).toBe(true);
    expect(await stale).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect((host.firstElementChild as HTMLCanvasElement).dataset).toMatchObject({ scale: "3", rotation: "90" });
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
      requestPassword: vi.fn(),
    });

    await controller.open(1);
    const originalCanvas = host.firstElementChild;
    const originalBytes = resources.snapshot().totals["canvas-bytes"];

    delay = deferred<void>();
    const pageEntered = deferred<void>();
    entered = () => pageEntered.resolve();
    const stalePage = controller.renderPage(2, undefined, () => guardCurrent);
    await pageEntered.promise;
    guardCurrent = false;
    delay.resolve();
    expect(await stalePage).toBe(false);
    expect(host.firstElementChild).toBe(originalCanvas);
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
    expect(host.firstElementChild).toBe(originalCanvas);
    expect((host.firstElementChild as HTMLCanvasElement).dataset).toMatchObject({ page: "1", scale: "1.25", rotation: "0" });
    expect(resources.snapshot().totals["canvas-bytes"]).toBe(originalBytes);

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
      requestPassword: vi.fn(),
    });

    await controller.open(1);
    const first = controller.renderPage(2, { scale: 2, rotation: 0, devicePixelRatio: 1 }, () => guardCurrent);
    await committed.promise;
    const committedCanvas = host.firstElementChild as HTMLCanvasElement;
    expect(committedCanvas.dataset).toMatchObject({ page: "2", scale: "2" });

    guardCurrent = false;
    const successor = controller.renderPageWithTransform(1, { scale: 3, rotation: 90, devicePixelRatio: 1 });
    expect(await successor).toBe(true);
    const successorCanvas = host.firstElementChild as HTMLCanvasElement;
    expect(successorCanvas.dataset).toMatchObject({ page: "1", scale: "3", rotation: "90" });

    afterCommit.resolve();
    expect(await first).toBe(true);
    expect(host.firstElementChild).toBe(successorCanvas);
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
      requestPassword: vi.fn(),
    });

    await controller.open(1);
    const originalCanvas = host.firstElementChild;
    const original = [...host.children];
    expect(host.children).toHaveLength(2);
    const initialAccessory = host.querySelector<HTMLElement>(":scope > :nth-child(2)");
    expect(initialAccessory?.dataset.opening).toBe("true");
    expect(await controller.renderPage(2)).toBe(false);
    expect(host.firstElementChild).toBe(originalCanvas);
    expect([...host.children]).toEqual(original);
    rejectOverlay = false;
    expect(await controller.renderPage(2)).toBe(true);
    expect(host.firstElementChild).not.toBe(originalCanvas);
    expect((host.firstElementChild as HTMLCanvasElement).dataset.page).toBe("2");
    expect(host.children).toHaveLength(2);
    const replacementAccessory = host.querySelector<HTMLElement>(":scope > :nth-child(2)");
    expect(replacementAccessory?.dataset.opening).toBe("false");

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
      requestPassword: vi.fn(),
    });

    await controller.open(1);
    const healthyCanvas = host.firstElementChild;
    await controller.open(1);

    expect(host.firstElementChild).toBe(healthyCanvas);
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
      requestPassword: vi.fn(),
    });

    await controller.open(1);
    rejectTransform = true;
    expect(await controller.setViewTransform({ scale: 2, rotation: 90, devicePixelRatio: 1 })).toBe(false);
    rejectTransform = false;
    expect(await controller.renderPage(1)).toBe(true);

    expect(getViewport).toHaveBeenLastCalledWith({ scale: 1.25, rotation: 0 });
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
      requestPassword: vi.fn(),
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
      onPage: vi.fn(), onStatus: vi.fn(), requestPassword: vi.fn(),
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
        onPage: vi.fn(), onStatus: vi.fn(), requestPassword: vi.fn(),
      });

      const opening = controller.open(1);
      await vi.waitFor(() => expect(staged).toBe(true));
      const disposing = controller.dispose();
      await vi.advanceTimersByTimeAsync(10_000);
      await disposing;
      expect(teardown).toHaveBeenCalledOnce();
      expect(pdf.destroy).not.toHaveBeenCalled();

      overlay.resolve();
      await vi.runAllTimersAsync();
      await opening;
      expect(teardown).toHaveBeenCalledOnce();
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
      onPage: vi.fn(), onStatus: vi.fn(), requestPassword: vi.fn(),
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
        onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(), requestPassword: vi.fn(),
      });
      await controller.open(1);
      const naturalSize = controller.getPageNaturalSize(2, 0);
      const naturalSizeFailure = expect(naturalSize).rejects.toThrow("RENDER_FAILED");
      await vi.advanceTimersByTimeAsync(10_000);
      await naturalSizeFailure;
      const disposing = controller.dispose();
      await vi.advanceTimersByTimeAsync(10_000);
      await disposing;
      expect(pdf.destroy).not.toHaveBeenCalled();
      rawPage.resolve(page(2));
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(pdf.destroy).toHaveBeenCalledOnce();
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
      requestPassword: vi.fn(),
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
      requestPassword: vi.fn(),
    });

    await controller.open(1);
    await controller.dispose();

    expect(pdf.destroy).not.toHaveBeenCalled();
    expect(native.cancelSession).not.toHaveBeenCalled();
  });
});
