import { checkedCanvasBytes, type ResourceReservation, type ResourceReservationManager } from "./ResourceBudget";

/**
 * Document-scoped production print service.
 *
 * Three properties distinguish this from the W02 feasibility prototype it
 * replaces.
 *
 * Memory is bounded by construction. The prototype released each canvas but
 * retained every encoded blob, `<img>`, and object URL until the whole
 * operation finished, which is exactly the 300-page OOM `feature-spec.md` §13
 * lists as a failure mode. Here a bounded window of prepared pages is held; the
 * oldest is released as soon as the window is full.
 *
 * Page rotation is preserved. PDF.js treats an explicit `rotation` option as a
 * *replacement* for the page's intrinsic `/Rotate`, so the prototype's
 * `rotation: 0` silently unrotated landscape source pages. The macOS reference
 * prints the in-memory document with `autoRotate`, which honors each page's own
 * rotation, so this service reads `page.rotate` and passes it through.
 *
 * Progress is reported per page, which §13 requires alongside the system panel.
 */

export interface PdfPrintRenderTask {
  readonly promise: Promise<void>;
  cancel(): void;
}

export interface PdfPrintPage {
  /** The page's intrinsic rotation in degrees, as PDF.js exposes it. */
  readonly rotate?: number;
  getViewport(options: { readonly scale: number; readonly rotation: number }): {
    readonly width: number;
    readonly height: number;
  };
  render(options: {
    readonly canvas: HTMLCanvasElement;
    readonly canvasContext: CanvasRenderingContext2D;
    readonly viewport: unknown;
    readonly annotationMode: number;
  }): PdfPrintRenderTask;
}

export interface PdfPrintDocument {
  getPage(pageNumber: number): Promise<PdfPrintPage>;
}

export type PdfPrintPhase = "preparing" | "opening-dialog" | "complete" | "cancelled" | "failed";

export interface PdfPrintProgress {
  readonly phase: PdfPrintPhase;
  readonly preparedPages: number;
  readonly totalPages: number;
  /** 0..1, monotonically non-decreasing during preparation. */
  readonly fraction: number;
}

export interface PdfPrintServiceOptions {
  readonly document: PdfPrintDocument;
  readonly pageCount: number;
  readonly annotationMode: number;
  readonly resources: ResourceReservationManager;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly host?: HTMLElement;
  readonly invokePrint?: () => void | Promise<void>;
  readonly encodeCanvas?: (canvas: HTMLCanvasElement) => Promise<Blob>;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
  readonly stageTimeoutMs?: number;
  readonly onProgress?: (progress: PdfPrintProgress) => void;
  readonly onOwnershipSettlement?: (settlement: Promise<void>) => void;
  /**
   * Maximum simultaneously retained prepared pages. Bounds peak memory
   * independently of document length.
   */
  readonly maxRetainedPages?: number;
}

export type PdfPrintOutcome =
  | { readonly kind: "printed"; readonly pageCount: number; readonly peakRetainedBytes: number }
  | { readonly kind: "cancelled"; readonly preparedPages: number }
  | { readonly kind: "failed"; readonly reason: string; readonly preparedPages: number };

const DEFAULT_STAGE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETAINED_PAGES = 24;

const encodePng = (canvas: HTMLCanvasElement): Promise<Blob> => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => {
    if (blob === null) reject(new Error("PRINT_ENCODE_FAILED"));
    else resolve(blob);
  }, "image/png");
});

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new Error("PRINT_CANCELLED");
};

async function waitForStage<T>(raw: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  throwIfAborted(signal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("PRINT_STAGE_TIMEOUT")), timeoutMs);
    abort = () => reject(new Error("PRINT_CANCELLED"));
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([raw, interrupted]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abort !== undefined) signal?.removeEventListener("abort", abort);
  }
}

interface PreparedPage {
  readonly url: string;
  readonly image: HTMLImageElement;
  readonly bytes: number;
  readonly reservation: ResourceReservation;
}

/**
 * Prepares every page of a document and opens the Windows system print flow.
 *
 * Cancellation and failure are normal outcomes, not exceptions: the caller
 * receives a typed result so a failed print can never be reported as success.
 */
export async function printPdfDocument(options: PdfPrintServiceOptions): Promise<PdfPrintOutcome> {
  if (!Number.isSafeInteger(options.pageCount) || options.pageCount < 1) {
    return { kind: "failed", reason: "PRINT_PAGE_LIMIT", preparedPages: 0 };
  }
  const stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  if (!Number.isFinite(stageTimeoutMs) || stageTimeoutMs <= 0) {
    return { kind: "failed", reason: "PRINT_STAGE_TIMEOUT", preparedPages: 0 };
  }
  const maxRetainedPages = options.maxRetainedPages ?? DEFAULT_MAX_RETAINED_PAGES;
  if (!Number.isSafeInteger(maxRetainedPages) || maxRetainedPages < 1) {
    return { kind: "failed", reason: "PRINT_RETENTION_LIMIT", preparedPages: 0 };
  }

  const host = options.host ?? document.body;
  const invokePrint = options.invokePrint ?? (() => { window.print(); });
  const encodeCanvas = options.encodeCanvas ?? encodePng;
  const createObjectUrl = options.createObjectUrl ?? URL.createObjectURL.bind(URL);
  const revokeObjectUrl = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);

  // A dedicated hidden surface: overlays, highlights, hints, and theme chrome
  // are never part of the printed output.
  const surface = document.createElement("section");
  surface.className = "pdf-print-surface";
  surface.setAttribute("aria-hidden", "true");

  const retained: PreparedPage[] = [];
  const ownerships = new Set<Promise<void>>();
  const reservations = new Set<ResourceReservation>();
  let activeCanvas: HTMLCanvasElement | undefined;
  let activeCanvasReservation: ResourceReservation | undefined;
  let activeTask: PdfPrintRenderTask | undefined;
  let preparedPages = 0;
  let retainedBytes = 0;
  let peakRetainedBytes = 0;

  const register = <T>(raw: Promise<T>): Promise<T> => {
    const settlement = raw.then(() => undefined, () => undefined);
    ownerships.add(settlement);
    options.onOwnershipSettlement?.(settlement);
    return waitForStage(raw, options.signal, stageTimeoutMs);
  };
  const reserve = (amount: number): ResourceReservation => {
    const result = options.resources.reserve({ kind: "canvas-bytes", amount, sessionId: options.sessionId });
    if (!result.ok) throw new Error("PRINT_IMAGE_LIMIT");
    reservations.add(result.reservation);
    return result.reservation;
  };
  const release = (reservation: ResourceReservation | undefined): void => {
    if (reservation === undefined || !reservations.delete(reservation)) return;
    options.resources.release(reservation);
  };
  const releasePage = (page: PreparedPage): void => {
    page.image.removeAttribute("src");
    page.image.remove();
    try { revokeObjectUrl(page.url); } catch { /* cleanup is best-effort and bounded */ }
    release(page.reservation);
    retainedBytes -= page.bytes;
  };
  const report = (phase: PdfPrintPhase): void => {
    options.onProgress?.(Object.freeze({
      phase,
      preparedPages,
      totalPages: options.pageCount,
      fraction: options.pageCount === 0 ? 1 : Math.min(1, preparedPages / options.pageCount),
    }));
  };
  const cancelActive = (): void => activeTask?.cancel();
  options.signal?.addEventListener("abort", cancelActive);
  host.append(surface);

  try {
    throwIfAborted(options.signal);
    report("preparing");

    for (let pageNumber = 1; pageNumber <= options.pageCount; pageNumber += 1) {
      throwIfAborted(options.signal);
      const page = await register(Promise.resolve().then(() => options.document.getPage(pageNumber)));
      throwIfAborted(options.signal);

      // Intrinsic rotation, not a hardcoded zero: an explicit rotation option
      // replaces the page's own /Rotate in PDF.js.
      const rotation = Number.isFinite(page.rotate) ? (page.rotate as number) : 0;
      const viewport = page.getViewport({ scale: 1, rotation });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      const canvasBytes = checkedCanvasBytes(width, height, 1);
      if (typeof canvasBytes === "string") throw new Error("PRINT_CANVAS_LIMIT");

      activeCanvasReservation = reserve(canvasBytes);
      const canvas = document.createElement("canvas");
      activeCanvas = canvas;
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("PRINT_CANVAS_UNAVAILABLE");

      const task = page.render({ canvas, canvasContext: context, viewport, annotationMode: options.annotationMode });
      activeTask = task;
      await register(task.promise);
      activeTask = undefined;
      throwIfAborted(options.signal);

      const blob = await register(Promise.resolve().then(() => encodeCanvas(canvas)));
      throwIfAborted(options.signal);
      if (blob.size <= 0) throw new Error("PRINT_ENCODE_FAILED");

      // The canvas is released before the encoded page is retained, so the two
      // representations never both count against peak memory.
      canvas.width = 0;
      canvas.height = 0;
      activeCanvas = undefined;
      release(activeCanvasReservation);
      activeCanvasReservation = undefined;

      const pageReservation = reserve(blob.size);
      const url = createObjectUrl(blob);
      const image = document.createElement("img");
      image.className = "pdf-print-page";
      image.alt = "";
      image.src = url;
      image.style.width = `${String(viewport.width)}px`;
      image.style.height = `${String(viewport.height)}px`;
      surface.append(image);

      retained.push({ url, image, bytes: blob.size, reservation: pageReservation });
      retainedBytes += blob.size;
      peakRetainedBytes = Math.max(peakRetainedBytes, retainedBytes);

      // Bounded window: releasing the oldest page keeps peak memory flat
      // regardless of document length.
      while (retained.length > maxRetainedPages) {
        const oldest = retained.shift();
        if (oldest !== undefined) releasePage(oldest);
      }

      preparedPages += 1;
      report("preparing");
    }

    throwIfAborted(options.signal);
    report("opening-dialog");
    await register(Promise.resolve().then(invokePrint));
    report("complete");
    return { kind: "printed", pageCount: options.pageCount, peakRetainedBytes };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "PRINT_FAILED";
    if (reason === "PRINT_CANCELLED") {
      report("cancelled");
      return { kind: "cancelled", preparedPages };
    }
    report("failed");
    return { kind: "failed", reason, preparedPages };
  } finally {
    activeTask?.cancel();
    const cleanup = Promise.allSettled([...ownerships]).then(() => {
      options.signal?.removeEventListener("abort", cancelActive);
      if (activeCanvas !== undefined) {
        activeCanvas.width = 0;
        activeCanvas.height = 0;
      }
      for (const page of retained.splice(0)) releasePage(page);
      surface.remove();
      release(activeCanvasReservation);
      for (const reservation of [...reservations]) release(reservation);
    });
    options.onOwnershipSettlement?.(cleanup);
    void cleanup.catch(() => undefined);
  }
}
