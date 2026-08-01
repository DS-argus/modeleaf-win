import { createPdfDataRangeAdapter, type NativePdfSessionLifecycle, type OpaquePdfSessionMetadata } from "./PdfDataRangeAdapter";
import { PDFJS_POLICY } from "./PdfJsPolicy";
import {
  checkedCanvasBytes,
  validateDocumentBytes,
  type ResourceReservation,
  ResourceReservationManager,
} from "./ResourceBudget";

export interface OpenPdfResult {
  readonly sessionId: string;
  readonly documentGeneration: number;
  readonly length: number;
  readonly displayName: string;
}

export interface ReaderNativeBoundary {
  openPdfDialog(request: { readonly ownerGeneration: number }): Promise<OpenPdfResult | null>;
  readRange(request: { readonly sessionId: string; readonly documentGeneration: number; readonly requestId: string; readonly offset: number; readonly length: number }, signal: AbortSignal, ownerGeneration: number): Promise<Uint8Array>;
  cancelSession(session: OpaquePdfSessionMetadata, ownerGeneration: number): Promise<{ readonly barrierId: number }>;
  closeSession(session: OpaquePdfSessionMetadata, barrierId: number, ownerGeneration: number): Promise<void>;
}

export interface PdfRenderTask { promise: Promise<void>; cancel(): void; }
export interface PdfPage { getViewport(options: { readonly scale: number; readonly rotation: number }): { readonly width: number; readonly height: number }; render(options: { readonly canvas: HTMLCanvasElement; readonly canvasContext: CanvasRenderingContext2D; readonly viewport: unknown; readonly transform?: readonly [number, number, number, number, number, number]; readonly annotationMode: number }): PdfRenderTask; }
export interface PdfDocument { numPages: number; getPage(page: number): Promise<PdfPage>; destroy(): Promise<void> | void; }
export interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void> | void;
  onPassword?: (updatePassword: (password: string) => void, reason: number) => void;
}
export interface PdfBoundary { getDocument(options: Record<string, unknown>): PdfLoadingTask; annotationMode: number; }

export interface PdfReaderControllerOptions {
  readonly native: ReaderNativeBoundary;
  readonly pdf: PdfBoundary;
  readonly resources: ResourceReservationManager;
  readonly canvasHost: HTMLElement;
  readonly onCommitted: (pageCount: number, displayName: string) => void;
  readonly onPage: (page: number) => void;
  readonly onStatus: (message: string) => void;
  readonly requestPassword: (reason: "need" | "incorrect") => Promise<string | null>;
}
export interface PdfViewTransform {
  readonly scale: number;
  readonly rotation: number;
  readonly devicePixelRatio: number;
}

export interface PdfScrollAnchor {
  readonly x: number;
  readonly y: number;
}

interface Candidate {
  readonly session: OpenPdfResult;
  readonly adapter: ReturnType<typeof createPdfDataRangeAdapter>;
  readonly task: PdfLoadingTask;
  passwordFailures: number;
  readonly ownerGeneration: number;
  document?: PdfDocument;
  canvasReservation?: ResourceReservation;
  pageNumber?: number;
}
interface ActiveRender {
  readonly task: PdfRenderTask;
  readonly settled: Promise<void>;
}
interface PendingCleanup {
  readonly session: OpenPdfResult;
  readonly ownerGeneration: number;
}
const METADATA_DEADLINE_MS = 15_000;
const RENDER_DEADLINE_MS = 10_000;

async function withDeadline<T>(operation: Promise<T>, milliseconds: number, tag: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(tag)), milliseconds);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

const errorTag = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "tag" in error && typeof error.tag === "string") return error.tag;
  return error instanceof Error ? error.message : String(error);
};
const isRenderCancellation = (error: unknown): boolean =>
  error instanceof Error
  && (error.name === "RenderingCancelledException"
    || /render(?:ing)? cancelled/i.test(error.message));


const safeMessage = (error: unknown): string => {
  const tag = errorTag(error);
  if (/PASSWORD_CANCELLED/i.test(tag)) return "Opening PDF cancelled.";
  if (/PASSWORD/i.test(tag)) return "The PDF password was not accepted.";
  if (/CANCEL|ABORT/i.test(tag)) return "Opening PDF cancelled.";
  if (/WORKER|ASSET/i.test(tag)) return "The local PDF renderer could not start.";
  if (/TIMEOUT/i.test(tag)) return "The PDF operation timed out.";
  if (/REMOTE_PATH|remote|UNC|network/i.test(tag)) return "Network PDFs are not supported. Copy the PDF to a local drive and open the local copy.";
  if (/PATH_REJECTED|local|drive/i.test(tag)) return "This PDF path cannot be opened safely.";
  if (/DOCUMENT_TOO_LARGE|_LIMIT|_CAPACITY|large|resource|canvas|memory/i.test(tag)) return "This PDF exceeds reader resource limits.";
  if (/FILE_UNREADABLE|PDF_INVALID|PDF_EMPTY|RANGE|read|malformed|invalid|corrupt/i.test(tag)) return "Could not read this PDF.";
  return "The PDF could not be opened.";
};

/** Owns opaque sessions and PDFs. A candidate is invisible until its first page has rendered. */
export class PdfReaderController {
  private current: Candidate | undefined;
  private readonly liveSessions = new Set<string>();
  private opening: Candidate | undefined;
  private activeRender: ActiveRender | undefined;
  private renderSequence = 0;
  private disposed = false;
  private openSequence = 0;
  private readonly pendingCleanups = new Map<string, PendingCleanup>();
  private viewTransform: PdfViewTransform = {
    scale: 1.25,
    rotation: 0,
    devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
  };

  public constructor(private readonly options: PdfReaderControllerOptions) {}

  public async open(ownerGeneration: number): Promise<void> {
    if (this.disposed) return;
    if (!(await this.retryPendingCleanups())) return;
    const openSequence = ++this.openSequence;
    await this.disposeCandidate(this.opening);
    this.opening = undefined;
    let session: OpenPdfResult | null;
    try {
      session = await this.options.native.openPdfDialog({ ownerGeneration });
    } catch (error) {
      this.options.onStatus(safeMessage(error));
      return;
    }
    if (session === null) return;
    if (this.disposed) {
      await this.closeUnloadedSession(session, ownerGeneration);
      return;
    }
    if (openSequence !== this.openSequence) {
      await this.closeUnloadedSession(session, ownerGeneration);
      return;
    }
    if (validateDocumentBytes(session.length) !== undefined) {
      await this.closeUnloadedSession(session, ownerGeneration);
      this.options.onStatus("This PDF exceeds reader resource limits.");
      return;
    }

    const metadata: OpaquePdfSessionMetadata = {
      sessionId: session.sessionId,
      documentGeneration: session.documentGeneration,
      byteLength: session.length,
    };
    const barriers = new Map<string, number>();
    const lifecycle: NativePdfSessionLifecycle = {
      cancel: async (sessionMetadata) => {
        const result = await this.options.native.cancelSession(sessionMetadata, ownerGeneration);
        barriers.set(sessionMetadata.sessionId, result.barrierId);
      },
      waitForBarrier: async () => undefined,
      close: async (sessionMetadata) => {
        const barrierId = barriers.get(sessionMetadata.sessionId);
        if (barrierId === undefined) throw new Error("Missing cancellation barrier");
        await this.options.native.closeSession(sessionMetadata, barrierId, ownerGeneration);
      },
    };
    this.liveSessions.add(session.sessionId);
    const adapter = createPdfDataRangeAdapter({
      session: metadata,
      invoker: { invoke: (request, signal) => this.options.native.readRange(request, signal, ownerGeneration) },
      isGenerationCurrent: (generation) => this.liveSessions.has(session.sessionId) && generation === session.documentGeneration,
      nativeLifecycle: lifecycle,
      onFailure: (tag) => {
        const currentOwnsStatus = this.current?.session.sessionId === session.sessionId;
        const openingOwnsStatus = openSequence === this.openSequence
          && (this.opening === undefined || this.opening.session.sessionId === session.sessionId);
        if (currentOwnsStatus || openingOwnsStatus) this.options.onStatus(safeMessage({ tag }));
      },
    });
    const task = this.options.pdf.getDocument({
      ...PDFJS_POLICY.getDocument,
      range: adapter.transport,
      cMapUrl: PDFJS_POLICY.assets.cMapUrl,
      cMapPacked: PDFJS_POLICY.assets.cMapPacked,
      standardFontDataUrl: PDFJS_POLICY.assets.standardFontDataUrl,
      wasmUrl: PDFJS_POLICY.assets.wasmUrl,
      iccUrl: PDFJS_POLICY.assets.iccUrl,
    });
    const candidate: Candidate = { session, adapter, task, ownerGeneration, passwordFailures: 0 };
    task.onPassword = (updatePassword, reason) => {
      if (reason === 2) candidate.passwordFailures += 1;
      if (candidate.passwordFailures >= 5) {
        this.options.onStatus("The PDF password was not accepted after five attempts.");
        void task.destroy();
        return;
      }
      void this.options.requestPassword(reason === 2 ? "incorrect" : "need").then((password) => {
        if (password === null || this.disposed || this.opening !== candidate) {
          void task.destroy();
          return;
        }
        updatePassword(password);
      });
    };
    this.opening = candidate;
    this.options.onStatus(`Opening ${session.displayName}`);
    try {
      const document = await withDeadline(task.promise, METADATA_DEADLINE_MS, "PDF_TIMEOUT");
      candidate.document = document;
      if (document.numPages < 1) throw new Error("Malformed PDF");
      const openingTransform = this.normalizeViewTransform({
        scale: 1.25,
        rotation: 0,
        devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
      });
      const rendered = await this.renderCandidatePage(candidate, 1, openingTransform);
      candidate.canvasReservation = rendered.reservation;
      candidate.pageNumber = 1;
      if (this.disposed || this.opening !== candidate) throw new Error("Opening PDF cancelled");
      const prior = this.current;
      this.current = candidate;
      this.viewTransform = openingTransform;
      this.opening = undefined;
      this.canvasReplace(rendered.canvas);
      this.options.onCommitted(document.numPages, session.displayName);
      this.options.onPage(1);
      await this.disposeCandidate(prior);
    } catch (error) {
      if (this.opening === candidate) this.opening = undefined;
      await this.disposeCandidate(candidate);
      if (!this.disposed) {
        this.options.onStatus(candidate.passwordFailures >= 5
          ? "The PDF password was not accepted after five attempts."
          : safeMessage(error));
      }
    }
  }
  public async setViewTransform(transform: PdfViewTransform): Promise<boolean> {
    const normalized = this.normalizeViewTransform(transform);
    if (normalized.scale === this.viewTransform.scale
      && normalized.rotation === this.viewTransform.rotation
      && normalized.devicePixelRatio === this.viewTransform.devicePixelRatio) return true;
    this.viewTransform = normalized;
    const pageNumber = this.current?.pageNumber;
    return pageNumber === undefined ? true : this.renderPage(pageNumber);
  }

  public async rerenderForResize(): Promise<boolean> {
    const pageNumber = this.current?.pageNumber;
    return pageNumber === undefined ? false : this.renderPage(pageNumber);
  }

  public captureScrollAnchor(): PdfScrollAnchor {
    const canvas = this.options.canvasHost.firstElementChild as HTMLCanvasElement | null;
    if (canvas === null) return { x: 0, y: 0 };
    const width = canvas.getBoundingClientRect().width || canvas.width;
    const height = canvas.getBoundingClientRect().height || canvas.height;
    return {
      x: width === 0
        ? 0
        : (this.options.canvasHost.scrollLeft + this.options.canvasHost.clientWidth / 2 - canvas.offsetLeft) / width,
      y: height === 0
        ? 0
        : (this.options.canvasHost.scrollTop + this.options.canvasHost.clientHeight / 2 - canvas.offsetTop) / height,
    };
  }

  public restoreScrollAnchor(anchor: PdfScrollAnchor): void {
    const canvas = this.options.canvasHost.firstElementChild as HTMLCanvasElement | null;
    if (canvas === null) return;
    const width = canvas.getBoundingClientRect().width || canvas.width;
    const height = canvas.getBoundingClientRect().height || canvas.height;
    this.options.canvasHost.scrollLeft = Math.max(
      0,
      canvas.offsetLeft + anchor.x * width - this.options.canvasHost.clientWidth / 2,
    );
    this.options.canvasHost.scrollTop = Math.max(
      0,
      canvas.offsetTop + anchor.y * height - this.options.canvasHost.clientHeight / 2,
    );
  }

  public async renderPage(page: number): Promise<boolean> {
    const current = this.current;
    if (current === undefined || current.document === undefined || this.disposed) return false;
    try {
      const rendered = await this.renderCandidatePage(current, page);
      if (this.current !== current || this.disposed) {
        this.options.resources.release(rendered.reservation);
        return false;
      }
      const anchor = current.pageNumber === page ? this.captureScrollAnchor() : undefined;
      this.canvasReplace(rendered.canvas, anchor);
      if (current.canvasReservation !== undefined) this.options.resources.release(current.canvasReservation);
      current.canvasReservation = rendered.reservation;
      current.pageNumber = page;
      this.options.onPage(page);
      return true;
    } catch (error) {
      if (isRenderCancellation(error)) return false;
      if (!this.disposed && this.current === current) this.options.onStatus(safeMessage(error));
      return false;
    }
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    this.renderSequence += 1;
    try {
      await this.cancelActiveRender();
    } catch {
      this.options.onStatus("A PDF render could not be stopped. Close and reopen Modeleaf before opening more files.");
    }
    await this.disposeCandidate(this.opening);
    await this.disposeCandidate(this.current);
    this.opening = undefined;
    this.current = undefined;
    await this.retryPendingCleanups();
  }

  private async renderCandidatePage(
    candidate: Candidate,
    pageNumber: number,
    transform = this.viewTransform,
  ): Promise<{ readonly canvas: HTMLCanvasElement; readonly reservation: ResourceReservation }> {
    return this.renderPageUnchecked(candidate, pageNumber, transform);
  }

  private async renderPageUnchecked(
    candidate: Candidate,
    pageNumber: number,
    transform: PdfViewTransform,
  ): Promise<{ readonly canvas: HTMLCanvasElement; readonly reservation: ResourceReservation }> {
    if (candidate.document === undefined) throw new Error("PDF is not loaded");
    const sequence = ++this.renderSequence;
    const page = await withDeadline(candidate.document.getPage(pageNumber), RENDER_DEADLINE_MS, "RENDER_FAILED");
    if (sequence !== this.renderSequence) throw new Error("Render cancelled");
    await this.cancelActiveRender();
    if (sequence !== this.renderSequence) throw new Error("Render cancelled");

    const renderReservation = this.options.resources.reserve({
      kind: "render",
      amount: 1,
      sessionId: candidate.session.sessionId,
    });
    if (!renderReservation.ok) throw new Error(renderReservation.tag);

    let canvasReservation: ResourceReservation | undefined;
    let operation: ActiveRender | undefined;
    try {
      const viewport = page.getViewport({ scale: transform.scale, rotation: transform.rotation });
      const cssWidth = Math.max(1, Math.ceil(viewport.width));
      const cssHeight = Math.max(1, Math.ceil(viewport.height));
      const width = Math.max(1, Math.ceil(cssWidth * transform.devicePixelRatio));
      const height = Math.max(1, Math.ceil(cssHeight * transform.devicePixelRatio));
      const canvasBytes = checkedCanvasBytes(width, height, 1);
      if (typeof canvasBytes === "string") throw new Error(canvasBytes);
      const reservation = this.options.resources.reserve({
        kind: "canvas-bytes",
        amount: canvasBytes,
        sessionId: candidate.session.sessionId,
      });
      if (!reservation.ok) throw new Error(reservation.tag);
      canvasReservation = reservation.reservation;
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      canvas.dataset.page = String(pageNumber);
      canvas.dataset.scale = String(transform.scale);
      canvas.dataset.rotation = String(transform.rotation);
      canvas.dataset.devicePixelRatio = String(transform.devicePixelRatio);
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `PDF page ${pageNumber}`);
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Canvas unavailable");
      const task = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: [transform.devicePixelRatio, 0, 0, transform.devicePixelRatio, 0, 0],
        annotationMode: this.options.pdf.annotationMode,
      });
      const settled = task.promise.then(
        () => undefined,
        () => undefined,
      ).finally(() => {
        this.options.resources.release(renderReservation.reservation);
        if (this.activeRender === operation) this.activeRender = undefined;
      });
      operation = { task, settled };
      this.activeRender = operation;
      try {
        await withDeadline(task.promise, RENDER_DEADLINE_MS, "RENDER_FAILED");
      } catch (error) {
        if (!isRenderCancellation(error)) task.cancel();
        await withDeadline(settled, RENDER_DEADLINE_MS, "RENDER_CANCEL_TIMEOUT");
        throw error;
      }
      await settled;
      if (sequence !== this.renderSequence) throw new Error("Render cancelled");
      return { canvas, reservation: canvasReservation };
    } catch (error) {
      if (canvasReservation !== undefined) this.options.resources.release(canvasReservation);
      if (operation === undefined) this.options.resources.release(renderReservation.reservation);
      throw error;
    }
  }

  private canvasReplace(canvas: HTMLCanvasElement, anchor?: PdfScrollAnchor): void {
    this.options.canvasHost.replaceChildren(canvas);
    if (anchor !== undefined) {
      this.restoreScrollAnchor(anchor);
    } else {
      this.options.canvasHost.scrollLeft = 0;
      this.options.canvasHost.scrollTop = 0;
    }
  }

  private normalizeViewTransform(transform: PdfViewTransform): PdfViewTransform {
    if (!Number.isFinite(transform.scale) || transform.scale <= 0) throw new Error("Invalid PDF scale");
    if (!Number.isFinite(transform.devicePixelRatio) || transform.devicePixelRatio <= 0) {
      throw new Error("Invalid device pixel ratio");
    }
    if (!Number.isFinite(transform.rotation) || transform.rotation % 90 !== 0) {
      throw new Error("Rotation must be a quarter turn");
    }
    return {
      scale: transform.scale,
      rotation: ((transform.rotation % 360) + 360) % 360,
      devicePixelRatio: transform.devicePixelRatio,
    };
  }

  private async disposeCandidate(candidate: Candidate | undefined): Promise<void> {
    if (candidate === undefined) return;
    if (this.opening === candidate) this.opening = undefined;
    if (this.current === candidate) this.current = undefined;
    try { await candidate.task.destroy(); } catch { /* adapter teardown remains authoritative */ }
    try { await candidate.document?.destroy(); } catch { /* best effort PDF.js teardown */ }
    try {
      await candidate.adapter.destroy();
      this.pendingCleanups.delete(candidate.session.sessionId);
    } catch {
      await this.cleanupSession(candidate.session, candidate.ownerGeneration);
    }
    if (candidate.canvasReservation !== undefined) {
      this.options.resources.release(candidate.canvasReservation);
      delete candidate.canvasReservation;
    }
    this.liveSessions.delete(candidate.session.sessionId);
  }

  private async closeUnloadedSession(session: OpenPdfResult, ownerGeneration: number): Promise<void> {
    await this.cleanupSession(session, ownerGeneration);
  }

  private async cleanupSession(session: OpenPdfResult, ownerGeneration: number): Promise<boolean> {
    const metadata: OpaquePdfSessionMetadata = {
      sessionId: session.sessionId,
      documentGeneration: session.documentGeneration,
      byteLength: session.length,
    };
    try {
      const { barrierId } = await this.options.native.cancelSession(metadata, ownerGeneration);
      await this.options.native.closeSession(metadata, barrierId, ownerGeneration);
      this.pendingCleanups.delete(session.sessionId);
      return true;
    } catch {
      this.pendingCleanups.set(session.sessionId, { session, ownerGeneration });
      this.options.onStatus("A PDF session could not be released. Close and reopen Modeleaf before opening more files.");
      return false;
    }
  }

  private async retryPendingCleanups(): Promise<boolean> {
    for (const pending of [...this.pendingCleanups.values()]) {
      await this.cleanupSession(pending.session, pending.ownerGeneration);
    }
    return this.pendingCleanups.size === 0;
  }

  private async cancelActiveRender(): Promise<void> {
    const operation = this.activeRender;
    if (operation === undefined) return;
    operation.task.cancel();
    await withDeadline(operation.settled, RENDER_DEADLINE_MS, "RENDER_CANCEL_TIMEOUT");
  }
}
