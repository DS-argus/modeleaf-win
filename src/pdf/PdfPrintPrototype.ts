import {
  checkedCanvasBytes,
  type ResourceReservation,
  ResourceReservationManager,
} from "./ResourceBudget";

export interface PdfPrintRenderTask {
  readonly promise: Promise<void>;
  cancel(): void;
}

export interface PdfPrintPage {
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

export interface PdfPrintPrototypeOptions {
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
  readonly onOwnershipSettlement?: (settlement: Promise<void>) => void;
}
export interface PdfPrintPrototypeResult {
  readonly pageCount: number;
  readonly peakCanvasBytes: number;
  readonly encodedImageBytes: number;
  readonly decodedImageBytes: number;
}

const DEFAULT_STAGE_TIMEOUT_MS = 15_000;

const encodePng = (canvas: HTMLCanvasElement): Promise<Blob> => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => {
    if (blob === null) reject(new Error("PRINT_ENCODE_FAILED"));
    else resolve(blob);
  }, "image/png");
});

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new Error("PRINT_CANCELLED");
};

async function waitForStage<T>(
  raw: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
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

export async function printPdfPrototype(
  options: PdfPrintPrototypeOptions,
): Promise<PdfPrintPrototypeResult> {
  if (!Number.isSafeInteger(options.pageCount) || options.pageCount < 1) {
    throw new Error("PRINT_PAGE_LIMIT");
  }
  const stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  if (!Number.isFinite(stageTimeoutMs) || stageTimeoutMs <= 0) throw new Error("PRINT_STAGE_TIMEOUT");
  throwIfAborted(options.signal);

  const host = options.host ?? document.body;
  const invokePrint = options.invokePrint ?? (() => window.print());
  const encodeCanvas = options.encodeCanvas ?? encodePng;
  const createObjectUrl = options.createObjectUrl ?? URL.createObjectURL.bind(URL);
  const revokeObjectUrl = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);
  const surface = document.createElement("section");
  surface.className = "pdf-print-surface";
  surface.setAttribute("aria-hidden", "true");
  const objectUrls: string[] = [];
  const images: HTMLImageElement[] = [];
  const ownerships = new Set<Promise<void>>();
  const reservations = new Set<ResourceReservation>();
  let activeCanvas: HTMLCanvasElement | undefined;
  let activeCanvasReservation: ResourceReservation | undefined;
  let activeTask: PdfPrintRenderTask | undefined;
  let peakCanvasBytes = 0;
  let encodedImageBytes = 0;
  let decodedImageBytes = 0;

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
  const cancel = (): void => activeTask?.cancel();
  options.signal?.addEventListener("abort", cancel);
  host.append(surface);

  try {
    for (let pageNumber = 1; pageNumber <= options.pageCount; pageNumber += 1) {
      throwIfAborted(options.signal);
      const page = await register(Promise.resolve().then(() => options.document.getPage(pageNumber)));
      throwIfAborted(options.signal);
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      const canvasBytes = checkedCanvasBytes(width, height, 1);
      if (typeof canvasBytes === "string") throw new Error("PRINT_CANVAS_LIMIT");
      activeCanvasReservation = reserve(canvasBytes);
      peakCanvasBytes = Math.max(peakCanvasBytes, canvasBytes);
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
      reserve(blob.size);
      encodedImageBytes += blob.size;
      reserve(canvasBytes);
      decodedImageBytes += canvasBytes;
      const url = createObjectUrl(blob);
      objectUrls.push(url);
      const image = document.createElement("img");
      image.className = "pdf-print-page";
      image.alt = "";
      image.src = url;
      image.style.width = `${viewport.width}px`;
      image.style.height = `${viewport.height}px`;
      surface.append(image);
      images.push(image);
      canvas.width = 0;
      canvas.height = 0;
      activeCanvas = undefined;
      release(activeCanvasReservation);
      activeCanvasReservation = undefined;
    }

    await register(Promise.all(images.map((image) => typeof image.decode === "function"
      ? image.decode()
      : Promise.resolve())).then(() => undefined));
    throwIfAborted(options.signal);
    await register(Promise.resolve().then(invokePrint));
    return { pageCount: options.pageCount, peakCanvasBytes, encodedImageBytes, decodedImageBytes };
  } finally {
    activeTask?.cancel();
    const cleanup = Promise.allSettled([...ownerships]).then(() => {
      options.signal?.removeEventListener("abort", cancel);
      if (activeCanvas !== undefined) {
        activeCanvas.width = 0;
        activeCanvas.height = 0;
      }
      surface.remove();
      for (const url of objectUrls) {
        try { revokeObjectUrl(url); } catch { /* cleanup remains best-effort and bounded */ }
      }
      release(activeCanvasReservation);
      for (const reservation of [...reservations]) release(reservation);
    });
    options.onOwnershipSettlement?.(cleanup);
    void cleanup.catch(() => {});
  }
}
