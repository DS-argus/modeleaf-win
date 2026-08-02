import { createPdfDataRangeAdapter, type NativePdfSessionLifecycle, type OpaquePdfSessionMetadata } from "./PdfDataRangeAdapter";
import type {
  PdfContentDocument,
  PdfContentPage,
  PdfContentViewport,
} from "./PdfContentController";
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
export interface PdfViewport extends PdfContentViewport {}
export interface PdfPage extends PdfContentPage {
  getViewport(options: { readonly scale: number; readonly rotation: number }): PdfViewport;
  render(options: { readonly canvas: HTMLCanvasElement; readonly canvasContext: CanvasRenderingContext2D; readonly viewport: unknown; readonly transform?: readonly [number, number, number, number, number, number]; readonly annotationMode: number }): PdfRenderTask;
}
export interface PdfDocument extends PdfContentDocument {
  getPage(page: number): Promise<PdfPage>;
  destroy(): Promise<void> | void;
}
export interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void> | void;
  onPassword?: (updatePassword: (password: string) => void, reason: number) => void;
}
export interface PdfBoundary { getDocument(options: Record<string, unknown>): PdfLoadingTask; annotationMode: number; }
export interface PdfRenderedPage {
  readonly pageNumber: number;
  readonly page: PdfPage;
  readonly viewport: PdfViewport;
  readonly canvas: HTMLCanvasElement;
}
export type PdfCommitContext = {
  readonly document: PdfDocument;
  readonly session: Pick<OpenPdfResult, "sessionId" | "documentGeneration">;
  readonly ownerGeneration: number;
} & ({
  readonly opening: true;
  registerStagedTeardown(teardown: () => Promise<void>): void;
} | {
  readonly opening: false;
});


export type PdfRequestCommitGuard = () => boolean;

export interface PdfReaderControllerOptions {
  readonly native: ReaderNativeBoundary;
  readonly pdf: PdfBoundary;
  readonly resources: ResourceReservationManager;
  readonly canvasHost: HTMLElement;
  readonly onCommitted: (
    pageCount: number,
    displayName: string,
    document: PdfDocument,
    session: Pick<OpenPdfResult, "sessionId" | "documentGeneration">,
    ownerGeneration: number,
  ) => void;
  readonly onPage: (page: number, transform: PdfViewTransform) => void;
  readonly onBeforeCommit?: (
    rendered: PdfRenderedPage,
    commitCanvas: (accessory?: HTMLElement) => boolean,
    context: PdfCommitContext,
  ) => Promise<void>;
  readonly onOpenAborted?: (
    session: Pick<OpenPdfResult, "sessionId" | "documentGeneration">,
    ownerGeneration: number,
  ) => void;
  readonly onBeforeDispose?: (
    session: Pick<OpenPdfResult, "sessionId" | "documentGeneration">,
    ownerGeneration: number,
  ) => Promise<void>;
  readonly onStatus: (message: string) => void;
  readonly requestPassword: (reason: "need" | "incorrect") => Promise<string | null>;
}
interface RenderedCanvas extends PdfRenderedPage {
  readonly reservation: ResourceReservation;
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
  adapterDestroyHandedOff?: boolean;
  readonly ownerGeneration: number;
  passwordFailures: number;
  closed: boolean;
  cleanup?: Promise<void>;
  ownershipRetry?: Promise<void>;
  stagedTeardown?: () => Promise<void>;
  stagedTeardownSettlement?: Promise<void>;
  stagedTeardownCompleted?: boolean;
  stagedTeardownRejected?: boolean;
  beforeDisposePhase?: CleanupPhase;
  pdfDestroyPhase?: CleanupPhase;
  adapterDestroyPhase?: CleanupPhase;
  readonly ownedPagePromises: Set<Promise<PdfPage>>;
  readonly ownedRenderSettlements: Set<Promise<void>>;
  document?: PdfDocument;
  canvasReservation?: ResourceReservation;
  pageNumber?: number;

}
interface CleanupPhase {
  readonly raw: Promise<void>;
  settled: boolean;
  rejected: boolean;
  retryable?: boolean;
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
const OWNERSHIP_DEADLINE_MS = 10_000;

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
  private readonly quarantinedCandidates = new Set<Candidate>();
  private readonly pendingCleanups = new Map<string, PendingCleanup>();
  private readonly teardownSessions = new Map<string, Promise<void>>();
  private viewTransform: PdfViewTransform = {
    scale: 1.25,
    rotation: 0,
    devicePixelRatio: typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1),
  };

  public constructor(private readonly options: PdfReaderControllerOptions) {}

  private evictedScrollAnchor: { readonly pageNumber: number; readonly anchor: PdfScrollAnchor } | undefined;
  public async open(ownerGeneration: number, adoptedSession?: OpenPdfResult): Promise<void> {
    if (this.disposed) return;
    if (!(await this.retryPendingCleanups())) {
      if (adoptedSession !== undefined) await this.closeUnloadedSession(adoptedSession, ownerGeneration);
      return;
    }
    await this.retryQuarantinedCandidates();
    if (this.quarantinedCandidates.size > 0) {
      this.options.onStatus("A PDF renderer could not be released. Close and reopen Modeleaf before opening more files.");
      if (adoptedSession !== undefined) await this.closeUnloadedSession(adoptedSession, ownerGeneration);
      return;
    }
    const openSequence = ++this.openSequence;
    await this.disposeCandidate(this.opening);
    if (this.quarantinedCandidates.size > 0) {
      this.options.onStatus("A PDF renderer could not be released. Close and reopen Modeleaf before opening more files.");
      if (adoptedSession !== undefined) await this.closeUnloadedSession(adoptedSession, ownerGeneration);
      return;
    }
    this.opening = undefined;
    let session: OpenPdfResult | null = adoptedSession ?? null;
    if (adoptedSession === undefined) {
      try {
        session = await this.options.native.openPdfDialog({ ownerGeneration });
      } catch (error) {
        this.options.onStatus(safeMessage(error));
        return;
      }
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
    const lifecycle: NativePdfSessionLifecycle = {
      cancel: async () => {
        await this.startSessionTeardown(session, ownerGeneration);
      },
      waitForBarrier: async () => undefined,
      close: async () => undefined,
    };

    this.liveSessions.add(session.sessionId);
    const adapter = createPdfDataRangeAdapter({
      session: metadata,
      invoker: { invoke: (request, signal) => this.options.native.readRange(request, signal, ownerGeneration) },
      isGenerationCurrent: (generation) => this.liveSessions.has(session.sessionId) && generation === session.documentGeneration,
      nativeLifecycle: lifecycle,

      onFailure: (tag) => {
        const currentOwnsStatus = this.current?.session.sessionId === session.sessionId;
        const openingOwnsStatus = this.opening?.session.sessionId === session.sessionId && openSequence === this.openSequence;
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
    const candidate: Candidate = {
      session, adapter, task, ownerGeneration, passwordFailures: 0, closed: false, ownedPagePromises: new Set(), ownedRenderSettlements: new Set(),
    };
    task.onPassword = (updatePassword, reason) => {
      if (reason === 2) candidate.passwordFailures += 1;
      if (candidate.passwordFailures >= 5) {
        this.options.onStatus("The PDF password was not accepted after five attempts.");
        void this.disposeCandidate(candidate);
        return;
      }
      void this.options.requestPassword(reason === 2 ? "incorrect" : "need").then((password) => {
        if (password === null || this.disposed || this.opening !== candidate) {
          void this.disposeCandidate(candidate);
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
        devicePixelRatio: typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1),
      });
      const rendered = await this.renderCandidatePage(candidate, 1, openingTransform);
      if (candidate.cleanup !== undefined || this.disposed || this.opening !== candidate) {
        this.options.resources.release(rendered.reservation);
        throw new Error("Opening PDF cancelled");
      }
      candidate.canvasReservation = rendered.reservation;
      candidate.pageNumber = 1;
      if (this.disposed || this.opening !== candidate) throw new Error("Opening PDF cancelled");
      let priorCleanup: Promise<void> | undefined;
      let canvasCommitted = false;
      const commitCanvas = (accessory?: HTMLElement): boolean => {
        if (canvasCommitted || this.disposed || this.opening !== candidate) return false;
        const prior = this.current;
        this.current = candidate;
        this.opening = undefined;
        this.viewTransform = openingTransform;
        this.canvasReplace(rendered.canvas, accessory);
        canvasCommitted = true;
        delete candidate.stagedTeardown;
        priorCleanup = this.disposeCandidate(prior);
        this.notifyObserver(() => this.options.onCommitted(document.numPages, session.displayName, document, session, ownerGeneration));
        this.notifyObserver(() => this.options.onPage(1, openingTransform));
        return true;
      };
      if (this.options.onBeforeCommit === undefined) commitCanvas();
      else {
        await this.options.onBeforeCommit(rendered, commitCanvas, {
          document,
          session,
          ownerGeneration,
          opening: true,
          registerStagedTeardown: (teardown) => {
            if (candidate.stagedTeardown !== undefined) throw new Error("Opening overlay teardown already registered");
            candidate.stagedTeardown = teardown;
          },
        });
      }
      if (!canvasCommitted) throw new Error("Opening PDF cancelled");
      await priorCleanup;
    } catch (error) {
      this.options.onOpenAborted?.(session, ownerGeneration);
      if (this.opening === candidate) this.opening = undefined;
      await this.disposeCandidate(candidate);
      if (!this.disposed) {
        this.options.onStatus(candidate.passwordFailures >= 5
          ? "The PDF password was not accepted after five attempts."
          : safeMessage(error));
      }
    }
  }
  /** Adopts an opaque native session without reopening the dialog. */
  public async adopt(session: OpenPdfResult, ownerGeneration: number): Promise<true> {
    await this.open(ownerGeneration, session);
    const committed = this.current;
    if (
      committed?.session.sessionId !== session.sessionId
      || committed.session.documentGeneration !== session.documentGeneration
    ) {
      throw new Error("PDF_ADOPTION_NOT_COMMITTED");
    }
    return true;
  }

  /** Returns the target page's CSS size at unit scale and the requested rotation. */
  public async getPageNaturalSize(
    pageNumber: number,
    rotation: number,
    requestCommitGuard?: PdfRequestCommitGuard,
  ): Promise<{ readonly width: number; readonly height: number } | undefined> {
    const current = this.current;
    if (current === undefined || current.document === undefined || this.disposed
      || (requestCommitGuard !== undefined && !requestCommitGuard())) return undefined;
    try {
      const page = await this.getOwnedPage(current, pageNumber);
      if (this.current !== current || this.disposed || (requestCommitGuard !== undefined && !requestCommitGuard())) return undefined;
      const viewport = page.getViewport({ scale: 1, rotation });
      return Number.isFinite(viewport.width) && viewport.width > 0 && Number.isFinite(viewport.height) && viewport.height > 0
        ? { width: viewport.width, height: viewport.height }
        : undefined;
    } catch {
      return undefined;
    }
  }

  public async setViewTransform(transform: PdfViewTransform, requestCommitGuard?: PdfRequestCommitGuard): Promise<boolean> {
    const normalized = this.normalizeViewTransform(transform);
    if (normalized.scale === this.viewTransform.scale
      && normalized.rotation === this.viewTransform.rotation
      && normalized.devicePixelRatio === this.viewTransform.devicePixelRatio) return requestCommitGuard?.() ?? true;
    const pageNumber = this.current?.pageNumber;
    if (pageNumber === undefined) {
      if (requestCommitGuard !== undefined && !requestCommitGuard()) return false;
      this.viewTransform = normalized;
      return true;
    }
    return this.renderPageWithTransform(pageNumber, normalized, requestCommitGuard);
  }

  public async renderPageWithTransform(
    page: number,
    transform: PdfViewTransform,
    requestCommitGuard?: PdfRequestCommitGuard,
  ): Promise<boolean> {
    const normalized = this.normalizeViewTransform(transform);
    const rendered = await this.renderPage(page, normalized, requestCommitGuard);
    if (!rendered) return false;
    return true;
  }


  public async rerenderForResize(requestCommitGuard?: PdfRequestCommitGuard): Promise<boolean> {
    const pageNumber = this.current?.pageNumber;
    return pageNumber === undefined ? false : this.renderPage(pageNumber, this.viewTransform, requestCommitGuard);
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

  public async renderPage(
    page: number,
    transform = this.viewTransform,
    requestCommitGuard?: PdfRequestCommitGuard,
  ): Promise<boolean> {
    const current = this.current;
    if (current === undefined || current.document === undefined || this.disposed) return false;
    try {
      const rendered = await this.renderCandidatePage(current, page, transform);
      if (this.current !== current || this.disposed) {
        this.options.resources.release(rendered.reservation);
        return false;
      }
      if (requestCommitGuard !== undefined && !requestCommitGuard()) {
        this.options.resources.release(rendered.reservation);
        return false;
      }
      const capturedAnchor = current.pageNumber === page ? this.captureScrollAnchor() : undefined;
      const evictedAnchor = this.evictedScrollAnchor?.pageNumber === page ? this.evictedScrollAnchor.anchor : undefined;
      const anchor = evictedAnchor ?? capturedAnchor;
      let canvasCommitted = false;
      const commitCanvas = (accessory?: HTMLElement): boolean => {
        if (canvasCommitted || this.current !== current || this.disposed
          || (requestCommitGuard !== undefined && !requestCommitGuard())) return false;
        const priorReservation = current.canvasReservation;
        current.canvasReservation = rendered.reservation;
        current.pageNumber = page;
        this.viewTransform = transform;
        this.canvasReplace(rendered.canvas, accessory, anchor);
        canvasCommitted = true;
        this.evictedScrollAnchor = undefined;
        if (priorReservation !== undefined) this.options.resources.release(priorReservation);
        this.notifyObserver(() => this.options.onPage(page, transform));
        return true;
      };
      try {
        if (this.options.onBeforeCommit === undefined) commitCanvas();
        else await this.options.onBeforeCommit(rendered, commitCanvas, {
          document: current.document,
          session: current.session,
          ownerGeneration: current.ownerGeneration,
          opening: false,
        });
      } catch (error) {
        if (!canvasCommitted) {
          this.options.resources.release(rendered.reservation);
          throw error;
        }
      }
      if (!canvasCommitted) {
        this.options.resources.release(rendered.reservation);
        return false;
      }
      return true;
    } catch (error) {
      if (isRenderCancellation(error)) return false;
      if (!this.disposed && this.current === current) this.options.onStatus(safeMessage(error));
      return false;
    }
  }

  /** Cancels foreground rendering without releasing the owned document session. */
  public async suspend(): Promise<void> {
    this.renderSequence += 1;
    await this.cancelActiveRender();
  }

  /** Releases a suspended tab's committed canvas without closing its native PDF session. */
  public evictInactiveCanvas(): boolean {
    const current = this.current;
    if (current === undefined || current.canvasReservation === undefined || this.activeRender !== undefined) return false;
    this.evictedScrollAnchor = { pageNumber: current.pageNumber ?? 1, anchor: this.captureScrollAnchor() };
    this.options.resources.release(current.canvasReservation);
    delete current.canvasReservation;
    this.options.canvasHost.replaceChildren();
    return true;
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    this.renderSequence += 1;
    try {
      await this.cancelActiveRender();
    } catch {
      this.options.onStatus("A PDF render could not be stopped. Close and reopen Modeleaf before opening more files.");
    }
    await this.retryQuarantinedCandidates();
    await this.disposeCandidate(this.opening);
    await this.disposeCandidate(this.current);
    this.opening = undefined;
    this.current = undefined;
    if (!(await this.retryPendingCleanups(false)) || this.quarantinedCandidates.size > 0) {
      throw new Error("PDF_OWNERSHIP_INCOMPLETE");
    }
  }
  private async getOwnedPage(candidate: Candidate, pageNumber: number): Promise<PdfPage> {
    const document = candidate.document;
    if (document === undefined || candidate.closed) throw new Error("Render cancelled");
    const rawPage = Promise.resolve().then(() => {
      if (candidate.closed) throw new Error("Render cancelled");
      return document.getPage(pageNumber);
    }).then((page) => {
      if (candidate.closed) throw new Error("Render cancelled");
      return page;
    });
    candidate.ownedPagePromises.add(rawPage);
    void rawPage.finally(() => {
      candidate.ownedPagePromises.delete(rawPage);
      this.retryQuarantinedCandidate(candidate);
    }).catch(() => undefined);
    return withDeadline(rawPage, RENDER_DEADLINE_MS, "RENDER_FAILED");
  }

  private async renderCandidatePage(
    candidate: Candidate,
    pageNumber: number,
    transform = this.viewTransform,
  ): Promise<RenderedCanvas> {
    return this.renderPageUnchecked(candidate, pageNumber, transform);
  }

  private async renderPageUnchecked(
    candidate: Candidate,
    pageNumber: number,
    transform: PdfViewTransform,
  ): Promise<RenderedCanvas> {
    if (candidate.document === undefined || candidate.closed) throw new Error("Render cancelled");
    const sequence = ++this.renderSequence;
    const page = await this.getOwnedPage(candidate, pageNumber);
    if (candidate.closed || sequence !== this.renderSequence) throw new Error("Render cancelled");
    await this.cancelActiveRender();
    if (candidate.closed || sequence !== this.renderSequence) throw new Error("Render cancelled");

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
      const cssWidth = Math.max(1, viewport.width);
      const cssHeight = Math.max(1, viewport.height);
      const naturalWidth = cssWidth / transform.scale;
      const naturalHeight = cssHeight / transform.scale;
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
      canvas.dataset.naturalWidth = String(naturalWidth);
      canvas.dataset.naturalHeight = String(naturalHeight);
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
        candidate.ownedRenderSettlements.delete(settled);
        this.retryQuarantinedCandidate(candidate);
      });
      operation = { task, settled };
      this.activeRender = operation;
      candidate.ownedRenderSettlements.add(settled);
      try {
        await withDeadline(task.promise, RENDER_DEADLINE_MS, "RENDER_FAILED");
      } catch (error) {
        if (!isRenderCancellation(error)) task.cancel();
        await withDeadline(settled, RENDER_DEADLINE_MS, "RENDER_CANCEL_TIMEOUT");
        throw error;
      }

      await settled;
      if (candidate.closed || sequence !== this.renderSequence) throw new Error("Render cancelled");
      return { pageNumber, page, viewport, canvas, reservation: canvasReservation };
    } catch (error) {
      if (canvasReservation !== undefined && operation !== undefined) {
        const reservation = canvasReservation;
        canvasReservation = undefined;
        void operation.settled.finally(() => this.options.resources.release(reservation));
      }
      if (canvasReservation !== undefined) this.options.resources.release(canvasReservation);
      if (operation === undefined) this.options.resources.release(renderReservation.reservation);
      throw error;
    }
  }

  private notifyObserver(observer: () => void): void {
    try {
      observer();
    } catch (error) {
      try {
        this.options.onStatus(safeMessage(error));
      } catch {
        // Observer failures cannot roll back an already-published canvas.
      }
    }
  }
  private canvasReplace(canvas: HTMLCanvasElement, accessory?: HTMLElement, anchor?: PdfScrollAnchor): void {
    this.options.canvasHost.replaceChildren(canvas, ...(accessory === undefined ? [] : [accessory]));
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
      devicePixelRatio: Math.min(2, transform.devicePixelRatio),
    };
  }

  private disposeCandidate(candidate: Candidate | undefined): Promise<void> {
    if (candidate === undefined) return Promise.resolve();
    candidate.closed = true;
    if (candidate.cleanup !== undefined) return candidate.cleanup;
    if (this.opening === candidate) this.opening = undefined;
    if (this.current === candidate) this.current = undefined;
    const cleanup = this.disposeCandidateOnce(candidate);
    candidate.cleanup = cleanup;
    return cleanup;
  }

  private async disposeCandidateOnce(candidate: Candidate): Promise<void> {
    if (!await this.waitForCandidateOwnership(candidate)) return;
    if (this.options.onBeforeDispose !== undefined
      && !await this.awaitPhase(candidate, "beforeDisposePhase", () => this.options.onBeforeDispose!(candidate.session, candidate.ownerGeneration))) return;
    const pdfDestroyed = await this.awaitPhase(candidate, "pdfDestroyPhase", () => candidate.document === undefined
      ? Promise.resolve().then(() => candidate.task.destroy())
      : Promise.resolve().then(() => candidate.document!.destroy()));
    if (!pdfDestroyed && !candidate.pdfDestroyPhase?.settled) return;
    const adapterDestroyed = await this.awaitPhase(candidate, "adapterDestroyPhase", () => candidate.adapter.destroy());
    this.releaseCandidateOwnership(candidate);
    if (pdfDestroyed && adapterDestroyed) {
      this.quarantinedCandidates.delete(candidate);
      this.pendingCleanups.delete(candidate.session.sessionId);
    }
  }

  private releaseCandidateOwnership(candidate: Candidate): void {
    if (candidate.canvasReservation !== undefined) {
      this.options.resources.release(candidate.canvasReservation);
      delete candidate.canvasReservation;
    }
    this.liveSessions.delete(candidate.session.sessionId);
  }

  private handoffRejectedAdapterDestroy(candidate: Candidate): void {
    if (candidate.adapterDestroyHandedOff) return;
    candidate.adapterDestroyHandedOff = true;
    this.pendingCleanups.set(candidate.session.sessionId, {
      session: candidate.session,
      ownerGeneration: candidate.ownerGeneration,
    });
    this.quarantinedCandidates.delete(candidate);
    this.releaseCandidateOwnership(candidate);
    this.options.onStatus("A PDF session could not be released. Close and reopen Modeleaf before opening more files.");
  }

  private async awaitPhase(candidate: Candidate, key: "beforeDisposePhase" | "pdfDestroyPhase" | "adapterDestroyPhase", operation: () => Promise<void>): Promise<boolean> {
    let phase = candidate[key];
    if (phase === undefined) {
      const raw = Promise.resolve().then(operation);
      phase = { raw, settled: false, rejected: false };
      candidate[key] = phase;
      void raw.then(
        () => {
          phase!.settled = true;
          if (key === "beforeDisposePhase" && phase!.retryable && candidate[key] === phase) delete candidate[key];
          this.retryQuarantinedCandidate(candidate);
        },
        () => {
          phase!.settled = true;
          phase!.rejected = true;
          if (key === "adapterDestroyPhase") this.handoffRejectedAdapterDestroy(candidate);
          else {
            this.quarantine(candidate);
            if (key === "beforeDisposePhase" && candidate[key] === phase) delete candidate[key];
          }
          if (key !== "beforeDisposePhase") this.retryQuarantinedCandidate(candidate);
        },
      );
    }
    if (phase.rejected) {
      if (key === "adapterDestroyPhase") this.handoffRejectedAdapterDestroy(candidate);
      else this.quarantine(candidate);
      return false;
    }
    try {
      await withDeadline(phase.raw, METADATA_DEADLINE_MS, "PDF_CLEANUP_TIMEOUT");
      return true;
    } catch {
      if (key === "beforeDisposePhase") phase.retryable = true;
      if (phase.rejected && key === "adapterDestroyPhase") this.handoffRejectedAdapterDestroy(candidate);
      else this.quarantine(candidate);
      return false;
    }
  }

  private async waitForCandidateOwnership(candidate: Candidate): Promise<boolean> {
    const staged = this.beginStagedTeardown(candidate);
    const owned = [...candidate.ownedPagePromises, ...candidate.ownedRenderSettlements, ...(staged === undefined ? [] : [staged])];
    try {
      await withDeadline(Promise.allSettled(owned).then(() => undefined), OWNERSHIP_DEADLINE_MS, "PDF_OWNERSHIP_TIMEOUT");
      if (candidate.stagedTeardownRejected) {
        this.quarantine(candidate);
        return false;
      }
      return true;
    } catch {
      this.quarantine(candidate);
      this.retryQuarantinedCandidate(candidate);
      return false;
    }
  }

  private quarantine(candidate: Candidate): void {
    if (this.quarantinedCandidates.has(candidate)) return;
    this.quarantinedCandidates.add(candidate);
    this.options.onStatus("A PDF renderer could not be released. Close and reopen Modeleaf before opening more files.");
  }

  private retryQuarantinedCandidate(candidate: Candidate): void {
    if (!this.quarantinedCandidates.has(candidate) || candidate.ownershipRetry !== undefined || candidate.stagedTeardownRejected
      || (candidate.beforeDisposePhase !== undefined && (!candidate.beforeDisposePhase.settled || candidate.beforeDisposePhase.rejected))
      || (candidate.pdfDestroyPhase !== undefined && (!candidate.pdfDestroyPhase.settled || candidate.pdfDestroyPhase.rejected))
      || (candidate.adapterDestroyPhase !== undefined && (!candidate.adapterDestroyPhase.settled || candidate.adapterDestroyPhase.rejected))) return;
    const staged = candidate.stagedTeardownSettlement;
    const owned = [...candidate.ownedPagePromises, ...candidate.ownedRenderSettlements, ...(staged === undefined ? [] : [staged])];
    if (owned.length > 0) {
      candidate.ownershipRetry = Promise.allSettled(owned).then(() => {
        delete candidate.ownershipRetry;
        this.retryQuarantinedCandidate(candidate);
      });
      return;
    }
    candidate.ownershipRetry = Promise.resolve().then(async () => {
      delete candidate.cleanup;
      await this.disposeCandidate(candidate);
    }).finally(() => {
      delete candidate.ownershipRetry;
    });
  }

  private async retryQuarantinedCandidates(): Promise<void> {
    for (const candidate of [...this.quarantinedCandidates]) {
      delete candidate.stagedTeardownRejected;
      if (candidate.ownershipRetry !== undefined
        || (candidate.beforeDisposePhase !== undefined && (!candidate.beforeDisposePhase.settled || candidate.beforeDisposePhase.rejected))
        || (candidate.pdfDestroyPhase !== undefined && (!candidate.pdfDestroyPhase.settled || candidate.pdfDestroyPhase.rejected))
        || (candidate.adapterDestroyPhase !== undefined && (!candidate.adapterDestroyPhase.settled || candidate.adapterDestroyPhase.rejected))) continue;
      delete candidate.cleanup;
      await this.disposeCandidate(candidate);
    }
  }

  private beginStagedTeardown(candidate: Candidate): Promise<void> | undefined {
    if (candidate.stagedTeardown === undefined || candidate.stagedTeardownCompleted) return undefined;
    const existing = candidate.stagedTeardownSettlement;
    if (existing !== undefined) return existing;
    const settlement = Promise.resolve().then(candidate.stagedTeardown);
    candidate.stagedTeardownSettlement = settlement;
    void settlement.then(
      () => {
        if (candidate.stagedTeardownSettlement !== settlement) return;
        candidate.stagedTeardownCompleted = true;
        delete candidate.stagedTeardownSettlement;
        this.retryQuarantinedCandidate(candidate);
      },
      () => {
        if (candidate.stagedTeardownSettlement !== settlement) return;
        candidate.stagedTeardownRejected = true;
        delete candidate.stagedTeardownSettlement;
        this.quarantine(candidate);
      },
    );
    return settlement;
  }
  private async closeUnloadedSession(session: OpenPdfResult, ownerGeneration: number): Promise<void> {
    await this.cleanupSession(session, ownerGeneration);
  }

  private async cleanupSession(session: OpenPdfResult, ownerGeneration: number): Promise<boolean> {
    try {
      await withDeadline(
        this.startSessionTeardown(session, ownerGeneration),
        METADATA_DEADLINE_MS,
        "PDF_CLEANUP_TIMEOUT",
      );
      this.pendingCleanups.delete(session.sessionId);
      return true;
    } catch {
      this.pendingCleanups.set(session.sessionId, { session, ownerGeneration });
      this.options.onStatus("A PDF session could not be released. Close and reopen Modeleaf before opening more files.");
      return false;
    }
  }

  private startSessionTeardown(session: OpenPdfResult, ownerGeneration: number): Promise<void> {
    const existing = this.teardownSessions.get(session.sessionId);
    if (existing !== undefined) return existing;

    const metadata: OpaquePdfSessionMetadata = {
      sessionId: session.sessionId,
      documentGeneration: session.documentGeneration,
      byteLength: session.length,
    };
    const teardown = (async () => {
      const { barrierId } = await this.options.native.cancelSession(metadata, ownerGeneration);
      await this.options.native.closeSession(metadata, barrierId, ownerGeneration);
    })();
    this.teardownSessions.set(session.sessionId, teardown);
    void teardown.then(
      () => {
        if (this.teardownSessions.get(session.sessionId) !== teardown) return;
        this.teardownSessions.delete(session.sessionId);
        this.pendingCleanups.delete(session.sessionId);
      },
      () => {
        if (this.teardownSessions.get(session.sessionId) !== teardown) return;
        this.teardownSessions.delete(session.sessionId);
        this.pendingCleanups.set(session.sessionId, { session, ownerGeneration });
      },
    );
    return teardown;
  }

  private async retryPendingCleanups(waitForInFlight = true): Promise<boolean> {
    for (const pending of [...this.pendingCleanups.values()]) {
      if (!waitForInFlight && this.teardownSessions.has(pending.session.sessionId)) continue;
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
