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

function page(pageNumber: number, renderPromise: Promise<void> = Promise.resolve(), cancel = vi.fn()): PdfPage {
  return {
    getViewport: () => ({ width: 20, height: 30 }),
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
    const committed: number[] = [];
    const host = document.createElement("div");
    const controller = new PdfReaderController({
      native,
      resources: new ResourceReservationManager(),
      pdf: { getDocument: vi.fn(() => loading.shift()!), annotationMode: 0 },
      canvasHost: host,
      onCommitted: (count) => committed.push(count),
      onPage: vi.fn(),
      onStatus: vi.fn(),
      requestPassword: vi.fn(),
    });

    await controller.open(10);
    const canvas = host.firstElementChild;
    await controller.open(11);

    expect(committed).toEqual([2]);
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
      .mockRejectedValueOnce(new Error("immediate retry failed"))
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
    expect(native.closeSession).toHaveBeenCalledTimes(2);
    expect(statuses).toContain("A PDF session could not be released. Close and reopen Modeleaf before opening more files.");

    await controller.open(9);
    expect(native.closeSession).toHaveBeenCalledTimes(3);
    expect(native.openPdfDialog).toHaveBeenCalledTimes(2);
    await controller.dispose();
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
          getViewport: () => ({ width: 20, height: 30 }),
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
    expect(loadingTask.destroy).toHaveBeenCalled();
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
      getViewport: () => ({ width: 7_000, height: 7_000 }),
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
      expect(loadingTask.destroy).toHaveBeenCalled();
      expect(native.closeSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
