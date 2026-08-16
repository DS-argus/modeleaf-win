import { PDFDataRangeTransport } from "pdfjs-dist";
import type { OpaquePdfSessionMetadata } from "./PdfDataRangeAdapter";
import type {
  PdfContentDocument,
  PdfContentPage,
  PdfContentViewport,
} from "./PdfContentController";
import { PDFJS_POLICY } from "./PdfJsPolicy";
import { printPdfPrototype } from "./PdfPrintPrototype";
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

export function pdfProtocolSourceUrl(
  session: Pick<OpenPdfResult, "sessionId" | "documentGeneration">,
): string {
  if (session.sessionId.length === 0
    || session.sessionId.length > 128
    || /[\u0000-\u001f\u007f]/u.test(session.sessionId)
    || !Number.isSafeInteger(session.documentGeneration)
    || session.documentGeneration < 1) {
    throw new Error("Invalid PDF protocol session");
  }
  return `http://modeleaf-pdf.localhost/${encodeURIComponent(session.sessionId)}/${session.documentGeneration}`;
}

export class PdfProtocolRangeTransport extends PDFDataRangeTransport {
  private readonly active = new Set<Promise<void>>();
  private stopped = false;
  private failed = false;

  public constructor(
    length: number,
    private readonly url: string,
    private readonly onFailure: (error: Error) => void,
  ) {
    super(length, null, true);
  }

  public override requestDataRange(begin: number, end: number): void {
    const cappedEnd = Math.min(end, this.length);
    if (this.stopped
      || !Number.isSafeInteger(begin)
      || !Number.isSafeInteger(end)
      || begin < 0
      || cappedEnd <= begin
      || cappedEnd - begin > 4 * PDFJS_POLICY.getDocument.rangeChunkSize) {
      this.fail(new Error("PDF_RANGE_INVALID"));
      return;
    }
    const abort = new AbortController();
    const operation = this.fetchRange(begin, cappedEnd, abort.signal);
    const settlement = operation.then(() => undefined, (error: unknown) => {
      if (!this.stopped) this.fail(error instanceof Error ? error : new Error("PDF_RANGE_FAILED"));
    }).finally(() => {
      this.active.delete(settlement);
    });
    this.active.add(settlement);
    if (this.stopped) abort.abort();
    else {
      const cancel = (): void => abort.abort();
      settlement.finally(() => this.abortCallbacks.delete(cancel)).catch(() => {});
      this.abortCallbacks.add(cancel);
    }
  }

  private readonly abortCallbacks = new Set<() => void>();

  public override abort(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const cancel of this.abortCallbacks) cancel();
    this.abortCallbacks.clear();
  }

  public settlements(): readonly Promise<void>[] {
    return [...this.active];
  }

  private async fetchRange(begin: number, end: number, signal: AbortSignal): Promise<void> {
    const response = await fetch(this.url, {
      headers: { Range: `bytes=${begin}-${end - 1}` },
      signal,
    });
    const expectedRange = `bytes ${begin}-${end - 1}/${this.length}`;
    if (response.status !== 206
      || response.headers.get("content-range") !== expectedRange
      || response.headers.get("content-length") !== String(end - begin)) {
      throw new Error("PDF_RANGE_RESPONSE_INVALID");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== end - begin || this.stopped) {
      if (!this.stopped) throw new Error("PDF_RANGE_RESPONSE_INVALID");
      return;
    }
    this.onDataRange(begin, bytes);
  }

  private fail(error: Error): void {
    if (this.failed || this.stopped) return;
    this.failed = true;
    this.onFailure(error);
    this.abort();
  }
}
export interface ReaderNativeBoundary {
  openPdfDialog(request: { readonly ownerGeneration: number }): Promise<OpenPdfResult | null>;
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
}
interface RenderedCanvas extends PdfRenderedPage {
  readonly transform: PdfViewTransform;
  readonly reservation: ResourceReservation;
}
const sameTransform = (left: PdfViewTransform, right: PdfViewTransform): boolean =>
  left.scale === right.scale
  && left.rotation === right.rotation
  && left.devicePixelRatio === right.devicePixelRatio;
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
  readonly transport: { destroy(): Promise<void> };
  readonly task: PdfLoadingTask;
  readonly rangeTransport?: PdfProtocolRangeTransport;
  transportDestroyHandedOff?: boolean;
  readonly ownerGeneration: number;
  transportFailure?: Error;
  closed: boolean;
  cleanup?: Promise<void>;
  ownershipRetry?: Promise<void>;
  stagedTeardown?: () => Promise<void>;
  stagedTeardownSettlement?: Promise<void>;
  stagedTeardownCompleted?: boolean;
  stagedTeardownRejected?: boolean;
  beforeDisposePhase?: CleanupPhase;
  pdfDestroyPhase?: CleanupPhase;
  transportDestroyPhase?: CleanupPhase;
  readonly ownedPagePromises: Set<Promise<PdfPage>>;
  readonly ownedRenderSettlements: Set<Promise<void>>;
  readonly ownedPrintSettlements: Set<Promise<void>>;
  document?: PdfDocument;
  readonly residentRasters: Map<number, RenderedCanvas>;
  activePageNumber?: number;

}
interface CleanupPhase {
  readonly raw: Promise<void>;
  settled: boolean;
  rejected: boolean;
  retryable?: boolean;
}
interface ActivePrint {
  readonly owner: Candidate;
  readonly abort: AbortController;
  readonly settlement: Promise<void>;
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
  if (/LOCKED_DOCUMENT/i.test(tag)) return "Password-protected PDFs are not supported.";
  if (/PASSWORD_CANCELLED/i.test(tag)) return "Opening PDF cancelled.";
  if (/PASSWORD/i.test(tag)) return "The PDF password was not accepted.";
  if (/CANCEL|ABORT/i.test(tag)) return "Opening PDF cancelled.";
  if (/WORKER|ASSET/i.test(tag)) return "The local PDF renderer could not start.";
  if (/TIMEOUT/i.test(tag)) return "The PDF operation timed out.";
  if (/REMOTE_PATH/i.test(tag)) return "Network PDFs are not supported. Copy the PDF to a local drive and open the local copy.";
  if (/PATH_REJECTED/i.test(tag)) return "This PDF path cannot be opened safely.";
  if (/DOCUMENT_TOO_LARGE|_LIMIT|_CAPACITY|large|resource|canvas|memory/i.test(tag)) return "This PDF exceeds reader resource limits.";
  if (/EMPTY_DOCUMENT|PDF_EMPTY/i.test(tag)) return "PDF contains no pages.";
  if (/FILE_UNREADABLE|PDF_INVALID|PDF_EMPTY|RANGE|read|malformed|invalid|corrupt/i.test(tag)) return "Could not read this PDF.";
  return "The PDF could not be opened.";
};

/** Owns opaque sessions and PDFs. A candidate is invisible until its first page has rendered. */
export class PdfReaderController {
  private current: Candidate | undefined;
  private opening: Candidate | undefined;
  private activeRender: ActiveRender | undefined;
  private activePrint: ActivePrint | undefined;
  private readonly releasedRasters = new WeakSet<RenderedCanvas>();
  private renderSequence = 0;
  private disposed = false;
  private openSequence = 0;
  private readonly quarantinedCandidates = new Set<Candidate>();
  private prefetchSequence = 0;
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

    const transport = {
      destroy: () => this.startSessionTeardown(session, ownerGeneration),
    };
    let rejectRangeFailure!: (error: Error) => void;
    const rangeFailure = new Promise<never>((_resolve, reject) => {
      rejectRangeFailure = reject;
    });
    void rangeFailure.catch(() => {});
    let candidateRef: Candidate | undefined;
    let rangeTransport: PdfProtocolRangeTransport | undefined;
    let task: PdfLoadingTask;
    try {
      const sourceUrl = pdfProtocolSourceUrl(session);
      rangeTransport = session.length > 2 * PDFJS_POLICY.getDocument.rangeChunkSize
        ? new PdfProtocolRangeTransport(session.length, sourceUrl, (error) => {
            rejectRangeFailure(error);
            if (candidateRef !== undefined
              && (this.current === candidateRef || this.opening === candidateRef)
              && !candidateRef.closed) {
              candidateRef.transportFailure = error;
              this.options.onStatus(safeMessage(error));
              void this.disposeCandidate(candidateRef);
            }
          })
        : undefined;
      task = this.options.pdf.getDocument({
        ...PDFJS_POLICY.getDocument,
        ...(rangeTransport === undefined
          ? { url: sourceUrl }
          : { range: rangeTransport, length: session.length }),
        cMapUrl: PDFJS_POLICY.assets.cMapUrl,
        cMapPacked: PDFJS_POLICY.assets.cMapPacked,
        standardFontDataUrl: PDFJS_POLICY.assets.standardFontDataUrl,
        wasmUrl: PDFJS_POLICY.assets.wasmUrl,
        iccUrl: PDFJS_POLICY.assets.iccUrl,
      });
    } catch (error) {
      rangeTransport?.abort();
      await this.closeUnloadedSession(session, ownerGeneration);
      if (!this.disposed) this.options.onStatus(safeMessage(error));
      return;
    }
    const candidate: Candidate = {
      session,
      transport,
      task,
      ...(rangeTransport === undefined ? {} : { rangeTransport }),
      ownerGeneration,
      closed: false,
      ownedPagePromises: new Set(),
      ownedRenderSettlements: new Set(),
      ownedPrintSettlements: new Set(),
      residentRasters: new Map(),
    };
    candidateRef = candidate;
    let rejectDocumentPolicy!: (error: Error) => void;
    const documentPolicyFailure = new Promise<never>((_resolve, reject) => {
      rejectDocumentPolicy = reject;
    });
    this.opening = candidate;
    task.onPassword = () => {
      rejectDocumentPolicy(new Error("LOCKED_DOCUMENT"));
      void this.disposeCandidate(candidate);
    };
    this.options.onStatus(`Opening ${session.displayName}`);
    try {
      const document = await withDeadline(
        Promise.race([task.promise, documentPolicyFailure, rangeFailure]),
        METADATA_DEADLINE_MS,
        "PDF_TIMEOUT",
      );
      candidate.document = document;
      if (document.numPages < 1) throw new Error("EMPTY_DOCUMENT");
      const openingTransform = this.normalizeViewTransform({
        scale: 1.25,
        rotation: 0,
        devicePixelRatio: typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1),
      });
      const rendered = await this.renderCandidatePage(candidate, 1, openingTransform);
      if (candidate.cleanup !== undefined || this.disposed || this.opening !== candidate) {
        this.releaseRaster(rendered);
        throw new Error("Opening PDF cancelled");
      }
      candidate.residentRasters.set(1, rendered);
      candidate.activePageNumber = 1;
      if (this.disposed || this.opening !== candidate) throw new Error("Opening PDF cancelled");
      let priorCleanup: Promise<void> | undefined;
      let canvasCommitted = false;
      const commitCanvas = (accessory?: HTMLElement): boolean => {
        if (canvasCommitted || this.disposed || this.opening !== candidate) return false;
        const prior = this.current;
        this.current = candidate;
        this.opening = undefined;
        this.viewTransform = openingTransform;
        this.canvasReplace(rendered.canvas, accessory, undefined, true);
        canvasCommitted = true;
        delete candidate.stagedTeardown;
        priorCleanup = this.disposeCandidate(prior);
        this.notifyObserver(() => this.options.onCommitted(document.numPages, session.displayName, document, session, ownerGeneration));
        this.notifyObserver(() => this.options.onPage(1, openingTransform));
        this.scheduleAdjacentRasters(candidate, 1, openingTransform);
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
        this.options.onStatus(safeMessage(candidate.transportFailure ?? error));
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

  public async printCurrent(invokePrint?: () => void | Promise<void>): Promise<boolean> {
    const current = this.current;
    if (current === undefined || current.document === undefined || current.closed || this.disposed
      || this.activePrint !== undefined) return false;
    const activePageNumber = current.activePageNumber;
    const transform = this.viewTransform;
    const abort = new AbortController();
    const printOwnerships = new Set<Promise<void>>();
    const operation = printPdfPrototype({
      document: current.document,
      pageCount: current.document.numPages,
      annotationMode: this.options.pdf.annotationMode,
      resources: this.options.resources,
      sessionId: current.session.sessionId,
      signal: abort.signal,
      onOwnershipSettlement: (raw) => printOwnerships.add(raw),
      ...(invokePrint === undefined ? {} : { invokePrint }),
    });
    const operationSettlement = operation.then(() => undefined, () => undefined);
    const settlement = operationSettlement
      .then(() => Promise.allSettled([...printOwnerships]))
      .then(() => undefined);
    const activePrint = { owner: current, abort, settlement };
    this.activePrint = activePrint;
    current.ownedPrintSettlements.add(settlement);
    void settlement.then(() => {
      if (this.activePrint === activePrint) this.activePrint = undefined;
      current.ownedPrintSettlements.delete(settlement);
      this.retryQuarantinedCandidate(current);
    });
    try {
      await operation;
      return this.current === current
        && !current.closed
        && current.activePageNumber === activePageNumber
        && this.viewTransform === transform;
    } catch {
      if (!abort.signal.aborted && this.current === current && !this.disposed) this.options.onStatus("Printing failed.");
      return false;
    }
  }

  public cancelPrint(): void {
    this.activePrint?.abort.abort();
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
    const pageNumber = this.current?.activePageNumber;
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
    const pageNumber = this.current?.activePageNumber;
    return pageNumber === undefined ? false : this.renderPage(pageNumber, this.viewTransform, requestCommitGuard);
  }

  public captureScrollAnchor(): PdfScrollAnchor {
    const canvas = this.publishedCanvas();
    if (canvas === null) return { x: 0, y: 0 };
    const width = canvas.getBoundingClientRect().width || canvas.width;
    const height = canvas.getBoundingClientRect().height || canvas.height;
    const frame = canvas.parentElement!;
    return {
      x: width === 0
        ? 0
        : (this.options.canvasHost.scrollLeft + this.options.canvasHost.clientWidth / 2 - frame.offsetLeft - canvas.offsetLeft) / width,
      y: height === 0
        ? 0
        : (this.options.canvasHost.scrollTop + this.options.canvasHost.clientHeight / 2 - frame.offsetTop - canvas.offsetTop) / height,
    };
  }

  public restoreScrollAnchor(anchor: PdfScrollAnchor): void {
    const canvas = this.publishedCanvas();
    if (canvas === null) return;
    const width = canvas.getBoundingClientRect().width || canvas.width;
    const height = canvas.getBoundingClientRect().height || canvas.height;
    const frame = canvas.parentElement!;
    this.options.canvasHost.scrollLeft = Math.max(
      0,
      frame.offsetLeft + canvas.offsetLeft + anchor.x * width - this.options.canvasHost.clientWidth / 2,
    );
    this.options.canvasHost.scrollTop = Math.max(
      0,
      frame.offsetTop + canvas.offsetTop + anchor.y * height - this.options.canvasHost.clientHeight / 2,
    );
  }

  public async renderPage(
    page: number,
    transform = this.viewTransform,
    requestCommitGuard?: PdfRequestCommitGuard,
  ): Promise<boolean> {
    const current = this.current;
    if (current === undefined || current.document === undefined || this.disposed) return false;
    this.prefetchSequence += 1;
    try {
      const rendered = await this.renderCandidatePage(current, page, transform);
      const commitSequence = this.renderSequence;
      if (this.current !== current || this.disposed) {
        this.releaseRaster(rendered);
        return false;
      }
      if (requestCommitGuard !== undefined && !requestCommitGuard()) {
        this.releaseRaster(rendered);
        return false;
      }
      const capturedAnchor = current.activePageNumber === page ? this.captureScrollAnchor() : undefined;
      const evictedAnchor = this.evictedScrollAnchor?.pageNumber === page ? this.evictedScrollAnchor.anchor : undefined;
      const anchor = evictedAnchor ?? capturedAnchor;
      let canvasCommitted = false;
      const commitCanvas = (accessory?: HTMLElement): boolean => {
        if (canvasCommitted || commitSequence !== this.renderSequence || this.current !== current || this.disposed
          || (requestCommitGuard !== undefined && !requestCommitGuard())) return false;
        const priorReservation = current.residentRasters.get(page);
        current.residentRasters.set(page, rendered);
        current.activePageNumber = page;
        this.viewTransform = transform;
        if (priorReservation !== undefined) this.releaseRaster(priorReservation);
        this.canvasReplace(rendered.canvas, accessory, anchor);
        canvasCommitted = true;
        this.evictedScrollAnchor = undefined;
        this.notifyObserver(() => this.options.onPage(page, transform));
        this.pruneResidentRasters(current, page);
        this.scheduleAdjacentRasters(current, page, transform);
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
          this.releaseRaster(rendered);
          throw error;
        }
      }
      if (!canvasCommitted) {
        this.releaseRaster(rendered);
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
    const print = this.activePrint;
    print?.abort.abort();
    if (print !== undefined) {
      try {
        await withDeadline(print.settlement, OWNERSHIP_DEADLINE_MS, "PRINT_OWNERSHIP_TIMEOUT");
      } catch {
        if (!this.disposed) this.options.onStatus("A PDF print operation could not be stopped.");
      }
    }
    this.renderSequence += 1;
    this.prefetchSequence += 1;
    await this.cancelActiveRender();
  }

  /** Releases a suspended tab's committed canvas without closing its native PDF session. */
  public evictInactiveCanvas(): boolean {
    const current = this.current;
    if (current === undefined || current.residentRasters.size === 0 || this.activeRender !== undefined) return false;
    this.evictedScrollAnchor = { pageNumber: current.activePageNumber ?? 1, anchor: this.captureScrollAnchor() };
    for (const raster of current.residentRasters.values()) this.releaseRaster(raster);
    current.residentRasters.clear();
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
    let raster: RenderedCanvas | undefined;
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
      canvas.setAttribute("aria-label", `PDF page ${pageNumber} of ${candidate.document?.numPages ?? pageNumber}`);
      raster = { pageNumber, page, viewport, canvas, reservation: canvasReservation, transform };
      canvasReservation = undefined;
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
      if (raster === undefined) throw new Error("Canvas unavailable");

      await settled;
      if (candidate.closed || sequence !== this.renderSequence) throw new Error("Render cancelled");
      return raster;
    } catch (error) {
      if (raster !== undefined && operation !== undefined) {
        const ownedRaster = raster;
        raster = undefined;
        void operation.settled.finally(() => this.releaseRaster(ownedRaster));
      }
      if (raster !== undefined) this.releaseRaster(raster);
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
  private publishedCanvas(): HTMLCanvasElement | null {
    return this.options.canvasHost.querySelector<HTMLCanvasElement>(":scope > .pdf-page-frame[data-active-page='true'] > canvas");
  }

  private releaseRaster(raster: RenderedCanvas): void {
    if (this.releasedRasters.has(raster)) return;
    this.releasedRasters.add(raster);
    raster.canvas.width = 0;
    raster.canvas.height = 0;
    raster.canvas.parentElement?.remove();
    this.options.resources.release(raster.reservation);
  }

  private createPageFrame(canvas: HTMLCanvasElement, accessory?: HTMLElement): HTMLElement {
    const frame = document.createElement("div");
    frame.className = "pdf-page-frame";
    frame.dataset.page = canvas.dataset.page;
    frame.style.width = canvas.style.width;
    frame.style.height = canvas.style.height;
    frame.append(canvas);
    if (accessory !== undefined) frame.append(accessory);
    return frame;
  }

  private publishPageFrame(
    canvas: HTMLCanvasElement,
    accessory?: HTMLElement,
    replaceDocument = false,
    activate = true,
  ): HTMLElement {
    const frame = this.createPageFrame(canvas, accessory);
    const pageNumber = Number(canvas.dataset.page);
    if (replaceDocument) this.options.canvasHost.replaceChildren();
    const existing = this.options.canvasHost.querySelector<HTMLElement>(
      `:scope > .pdf-page-frame[data-page='${pageNumber}']`,
    );
    if (existing !== null) {
      existing.replaceWith(frame);
    } else {
      const successor = [...this.options.canvasHost.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")]
        .find((candidate) => Number(candidate.dataset.page) > pageNumber);
      if (successor === undefined) this.options.canvasHost.append(frame);
      else this.options.canvasHost.insertBefore(frame, successor);
    }
    if (activate) {
      for (const candidate of this.options.canvasHost.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")) {
        candidate.dataset.activePage = String(candidate === frame);
      }
    }
    return frame;
  }
  private canvasReplace(
    canvas: HTMLCanvasElement,
    accessory?: HTMLElement,
    anchor?: PdfScrollAnchor,
    replaceDocument = false,
  ): void {
    this.publishPageFrame(canvas, accessory, replaceDocument);
    if (anchor !== undefined) {
      this.restoreScrollAnchor(anchor);
    } else if (replaceDocument) {
      this.options.canvasHost.scrollLeft = 0;
      this.options.canvasHost.scrollTop = 0;
    }
  }

  private pruneResidentRasters(candidate: Candidate, centerPage: number): void {
    const minimum = Math.max(1, centerPage - 2);
    const maximum = Math.min(candidate.document?.numPages ?? centerPage, centerPage + 2);
    for (const [page, reservation] of [...candidate.residentRasters]) {
      if (page >= minimum && page <= maximum) continue;
      this.releaseRaster(reservation);
      candidate.residentRasters.delete(page);
      this.options.canvasHost.querySelector<HTMLElement>(`:scope > .pdf-page-frame[data-page='${page}']`)?.remove();
    }
  }

  private scheduleAdjacentRasters(candidate: Candidate, centerPage: number, transform: PdfViewTransform): void {
    const document = candidate.document;
    if (document === undefined || candidate.closed || this.disposed) return;
    const pages = [centerPage - 2, centerPage - 1, centerPage + 1, centerPage + 2]
      .filter((page) => page >= 1 && page <= document.numPages);
    const generation = ++this.prefetchSequence;
    void (async () => {
      for (const page of pages) {
        const resident = candidate.residentRasters.get(page);
        if (resident !== undefined) {
          if (sameTransform(resident.transform, transform)) continue;
          this.releaseRaster(resident);
          candidate.residentRasters.delete(page);
          this.options.canvasHost.querySelector<HTMLElement>(`:scope > .pdf-page-frame[data-page='${page}']`)?.remove();
        }
        let rendered: RenderedCanvas | undefined;
        try {
          rendered = await this.renderPageUnchecked(candidate, page, transform);
          if (generation !== this.prefetchSequence || this.current !== candidate || candidate.closed || this.disposed
            || candidate.activePageNumber !== centerPage) {
            this.releaseRaster(rendered);
            return;
          }
          candidate.residentRasters.set(page, rendered);
          this.publishPageFrame(rendered.canvas, undefined, false, false);
          rendered = undefined;
        } catch {
          if (rendered !== undefined) this.releaseRaster(rendered);
          return;
        }
      }
      this.pruneResidentRasters(candidate, centerPage);
    })();
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
    candidate?.rangeTransport?.abort();
    if (candidate !== undefined && this.activePrint?.owner === candidate) this.activePrint.abort.abort();
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
    const transportDestroyed = await this.awaitPhase(candidate, "transportDestroyPhase", () => candidate.transport.destroy());
    this.releaseCandidateOwnership(candidate);
    if (pdfDestroyed && transportDestroyed) {
      this.quarantinedCandidates.delete(candidate);
      this.pendingCleanups.delete(candidate.session.sessionId);
    }
  }

  private releaseCandidateOwnership(candidate: Candidate): void {
    for (const reservation of candidate.residentRasters.values()) {
      this.releaseRaster(reservation);
    }
    candidate.residentRasters.clear();
  }

  private handoffRejectedTransportDestroy(candidate: Candidate): void {
    if (candidate.transportDestroyHandedOff) return;
    candidate.transportDestroyHandedOff = true;
    this.pendingCleanups.set(candidate.session.sessionId, {
      session: candidate.session,
      ownerGeneration: candidate.ownerGeneration,
    });
    this.quarantinedCandidates.delete(candidate);
    this.releaseCandidateOwnership(candidate);
    this.options.onStatus("A PDF session could not be released. Close and reopen Modeleaf before opening more files.");
  }

  private async awaitPhase(candidate: Candidate, key: "beforeDisposePhase" | "pdfDestroyPhase" | "transportDestroyPhase", operation: () => Promise<void>): Promise<boolean> {
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
          if (key === "transportDestroyPhase") this.handoffRejectedTransportDestroy(candidate);
          else {
            this.quarantine(candidate);
            if (key === "beforeDisposePhase" && candidate[key] === phase) delete candidate[key];
          }
          if (key !== "beforeDisposePhase") this.retryQuarantinedCandidate(candidate);
        },
      );
    }
    if (phase.rejected) {
      if (key === "transportDestroyPhase") this.handoffRejectedTransportDestroy(candidate);
      else this.quarantine(candidate);
      return false;
    }
    try {
      await withDeadline(phase.raw, METADATA_DEADLINE_MS, "PDF_CLEANUP_TIMEOUT");
      return true;
    } catch {
      if (key === "beforeDisposePhase") phase.retryable = true;
      if (phase.rejected && key === "transportDestroyPhase") this.handoffRejectedTransportDestroy(candidate);
      else this.quarantine(candidate);
      return false;
    }
  }

  private async waitForCandidateOwnership(candidate: Candidate): Promise<boolean> {
    const staged = this.beginStagedTeardown(candidate);
    const owned = [
      ...candidate.ownedPagePromises,
      ...candidate.ownedRenderSettlements,
      ...candidate.ownedPrintSettlements,
      ...(candidate.rangeTransport?.settlements() ?? []),
      ...(staged === undefined ? [] : [staged]),
    ];
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
      || (candidate.transportDestroyPhase !== undefined && (!candidate.transportDestroyPhase.settled || candidate.transportDestroyPhase.rejected))) return;
    const staged = candidate.stagedTeardownSettlement;
    const owned = [
      ...candidate.ownedPagePromises,
      ...candidate.ownedRenderSettlements,
      ...candidate.ownedPrintSettlements,
      ...(candidate.rangeTransport?.settlements() ?? []),
      ...(staged === undefined ? [] : [staged]),
    ];
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
        || (candidate.transportDestroyPhase !== undefined && (!candidate.transportDestroyPhase.settled || candidate.transportDestroyPhase.rejected))) continue;
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
