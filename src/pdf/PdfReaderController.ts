import { PDFDataRangeTransport } from "pdfjs-dist";
import type { OpaquePdfSessionMetadata } from "./PdfDataRangeAdapter";
import type {
  PdfContentDocument,
  PdfContentPage,
  PdfContentViewport,
} from "./PdfContentController";
import { PDFJS_POLICY } from "./PdfJsPolicy";
import { ContinuousPageWindow, type PageWindowPlan } from "./ContinuousPageWindow";
import {
  capturePdfViewportAnchor,
  restorePdfViewportAnchor,
  samePdfViewportLanding,
  type PdfViewportAnchor,
  type PdfViewportLanding,
} from "./PdfViewportAnchor";
import { printPdfDocument, type PdfPrintProgress } from "./PdfPrintService";
import { probePdfOutline, type PdfOutlineDocument, type PdfOutlineItem, type PdfOutlineProbeRow } from "./PdfOutlineProbe";
import { readOutlineTree, type PdfOutlineAdapterDocument } from "./PdfOutlineAdapter";
import type { RawOutlineNode } from "../domain/outlines/OutlineModel";
import {
  checkedCanvasBytes,
  RESOURCE_LIMITS,
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
  getOutline?(): Promise<readonly PdfOutlineItem[] | null>;
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
  readonly retainedPages: readonly number[];
} & ({
  readonly opening: true;
  registerStagedTeardown(teardown: () => Promise<void>): void;
} | {
  readonly opening: false;
});


export type PdfRequestCommitGuard = () => boolean;

export interface PdfResidentAuthorityTransaction {
  rollback(): Promise<void>;
  finalize(): void;
}
export interface PdfReaderControllerOptions {
  readonly native: ReaderNativeBoundary;
  readonly pdf: PdfBoundary;
  readonly resources: ResourceReservationManager;
  readonly canvasHost: HTMLElement;
  readonly availableContentSize?: () => { readonly width: number; readonly height: number };
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
  readonly onEvictPage?: (page: number) => void;
  readonly onBeforeResidentCommit?: (pages: readonly number[]) => Promise<PdfResidentAuthorityTransaction | void>;
}
interface RenderedCanvas extends PdfRenderedPage {
  readonly transform: PdfViewTransform;
  readonly reservation: ResourceReservation;
}
export interface PdfViewTransform {
  readonly scale: number;
  readonly rotation: number;
  readonly devicePixelRatio: number;
}
export type PdfViewportRestoreOutcome =
  | { readonly kind: "verified"; readonly landing: PdfViewportLanding }
  | { readonly kind: "constrainedEdgeVerified"; readonly landing: PdfViewportLanding; readonly expected: PdfViewportLanding }
  | { readonly kind: "preflightRejected" }
  | { readonly kind: "staleOrCancelled" }
  | { readonly kind: "failed"; readonly landing?: PdfViewportLanding };
export type PdfScrollAnchor = PdfViewportAnchor;

interface Candidate {
  readonly session: OpenPdfResult;
  readonly task: PdfLoadingTask;
  readonly transport: { destroy(): Promise<void> };
  readonly rangeTransport?: PdfProtocolRangeTransport;
  window?: ContinuousPageWindow;
  topSpacer?: HTMLElement;
  bottomSpacer?: HTMLElement;
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
  visiblePageNumbers?: readonly number[];

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
  cancelRequested: boolean;
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
  private readonly pendingCleanups = new Map<string, PendingCleanup>();
  private readonly teardownSessions = new Map<string, Promise<void>>();
  private activeViewportPlan: { readonly candidate: Candidate; readonly plan: PageWindowPlan } | undefined;
  private viewportEpoch = 0;
  private viewportSettlement: Promise<void> | undefined;
  private presentationRequestSequence = 0;
  private viewportRollback = false;
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
      const firstPage = await this.getOwnedPage(candidate, 1);
      const firstViewport = firstPage.getViewport({ scale: 1, rotation: 0 });
      const available = this.options.availableContentSize?.();
      const availableWidth = available !== undefined && Number.isFinite(available.width) && available.width > 0
        ? available.width : firstViewport.width;
      const openingTransform = this.normalizeViewTransform({
        scale: Math.max(0.1, Math.min(8, availableWidth / firstViewport.width)),
        rotation: 0,
        devicePixelRatio: typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1),
      });
      const rendered = await this.renderCandidatePage(candidate, 1, openingTransform);
      if (candidate.cleanup !== undefined || this.disposed || this.opening !== candidate) {
        this.releaseRaster(rendered);
        throw new Error("Opening PDF cancelled");
      }
      candidate.residentRasters.set(1, rendered);
      candidate.window = new ContinuousPageWindow({
        pageCount: document.numPages,
        estimatedPageHeight: rendered.viewport.height,
        pageGap: 12,
        maxResidentPages: RESOURCE_LIMITS.maxResidentPageViews,
        overscanPages: 2,
      });
      candidate.window.updateMetric(1, { width: rendered.viewport.width, height: rendered.viewport.height });
      const openingPlan = candidate.window.plan(1);
      candidate.window.begin(1, openingPlan.generation);
      candidate.window.publish(1, openingPlan.generation);
      candidate.activePageNumber = 1;
      candidate.visiblePageNumbers = Object.freeze([1]);
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
        return true;
      };
      if (this.options.onBeforeCommit === undefined) commitCanvas();
      else {
        await this.options.onBeforeCommit(rendered, commitCanvas, {
          document,
          session,
          ownerGeneration,
          retainedPages: Object.freeze([1]),
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
    const operation = printPdfDocument({
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
      const outcome = await operation;
      if (outcome.kind === "failed") {
        // A failed print must never be reported as success.
        if (this.current === current && !this.disposed) this.options.onStatus("Printing failed.");
        return false;
      }
      if (outcome.kind === "cancelled") return false;
      // State preservation is part of the contract: the reader must be exactly
      // where it was before the print began.
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
  /** Returns the canonical PDF-space point at the visual top-left of the target page. */
  public async getPageTopLanding(
    pageNumber: number,
    transform: PdfViewTransform,
    requestCommitGuard?: PdfRequestCommitGuard,
  ): Promise<PdfViewportLanding | undefined> {
    const current = this.current;
    if (current === undefined || current.document === undefined || this.disposed || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > current.document.numPages) return undefined;
    if (requestCommitGuard !== undefined && !requestCommitGuard()) return undefined;
    try {
      const page = await this.getOwnedPage(current, pageNumber);
      if (this.current !== current || this.disposed || (requestCommitGuard !== undefined && !requestCommitGuard())) return undefined;
      const viewport = page.getViewport(transform);
      const [x, y] = viewport.convertToPdfPoint(viewport.width / 2, 0);
      return Number.isFinite(x) && Number.isFinite(y) ? { pageIndex: pageNumber - 1, x, y } : undefined;
    } catch {
      return undefined;
    }
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


  public residentPageNumbers(): readonly number[] {
    return Object.freeze([...(this.current?.residentRasters.keys() ?? [])].sort((a, b) => a - b));
  }
  /** Bounded immutable adapter for downstream outline presentation; this method creates no UI. */
  /**
   * Reads the embedded outline as pure-domain nodes.
   *
   * Returns an empty tree when the document has no outline; an outline is
   * never generated or inferred.
   */
  public async readOutlineTreeNodes(): Promise<readonly RawOutlineNode[]> {
    const current = this.current;
    const document = current?.document;
    if (current === undefined || document === undefined || this.disposed) return [];
    if (typeof document.getOutline !== "function" || typeof document.getPageIndex !== "function") return [];
    return readOutlineTree(document as unknown as PdfOutlineAdapterDocument);
  }
  public async readOutlineDestinations(): Promise<readonly PdfOutlineProbeRow[]> {
    const current = this.current;
    const document = current?.document;
    if (current === undefined || document === undefined || this.disposed) return [];
    if (typeof document.getOutline !== "function" || typeof document.getPageIndex !== "function") return [];
    let rows: readonly PdfOutlineProbeRow[];
    try {
      rows = await probePdfOutline(document as PdfOutlineDocument);
    } catch {
      throw new Error("PDF_OUTLINE_UNAVAILABLE");
    }
    if (this.current !== current || this.disposed) return [];
    return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
  }
  public async rerenderForResize(requestCommitGuard?: PdfRequestCommitGuard): Promise<boolean> {
    const pageNumber = this.current?.activePageNumber;
    return pageNumber === undefined ? false : this.renderPage(pageNumber, this.viewTransform, requestCommitGuard);
  }

  private async awaitViewportIdle(): Promise<void> {
    while (this.viewportSettlement !== undefined) {
      const settlement = this.viewportSettlement;
      this.invalidateViewportSynchronization();
      await settlement;
    }
  }
  public invalidateViewportSynchronization(): void {
    if (this.viewportSettlement === undefined || this.viewportRollback) return;
    this.viewportEpoch += 1;
    this.renderSequence += 1;
    void this.cancelActiveRender().catch(() => {
      if (!this.disposed) this.options.onStatus("PDF viewport cancellation pending.");
    });
  }
  /** Synchronizes the bounded continuous resident window to finite host geometry. */
  public async synchronizeViewport(scrollTop: number, clientHeight: number, requestCommitGuard?: PdfRequestCommitGuard): Promise<boolean> {
    if (!Number.isFinite(scrollTop) || !Number.isFinite(clientHeight) || clientHeight < 0) return false;
    const requestSequence = ++this.presentationRequestSequence;
    await this.awaitViewportIdle();
    if (requestSequence !== this.presentationRequestSequence) return false;
    const current = this.current;
    if (current === undefined || current.document === undefined || this.disposed) return false;
    const window = current.window;
    if (window === undefined) return false;
    const range = window.visibleRangeForViewport(scrollTop, clientHeight);
    if (range.firstVisiblePage === undefined || range.lastVisiblePage === undefined) return false;
    current.visiblePageNumbers = Object.freeze(Array.from(
      { length: range.lastVisiblePage - range.firstVisiblePage + 1 },
      (_unused, index) => range.firstVisiblePage! + index,
    ));

    const epoch = ++this.viewportEpoch;
    let releaseSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    this.viewportSettlement = settlement;
    const checkpoint = window.checkpoint();
    const originalResidents = new Set(checkpoint.residentPages);
    const priorActivePage = current.activePageNumber;
    const plan = window.plan(range.firstVisiblePage, range.lastVisiblePage);
    const transactionCurrent = (): boolean => this.viewportEpoch === epoch
      && this.current === current
      && !this.disposed
      && (requestCommitGuard?.() ?? true);
    this.applyWindowSpacers(current, plan);
    this.activeViewportPlan = { candidate: current, plan };
    let succeeded = false;
    let residentAuthority: PdfResidentAuthorityTransaction | void = undefined;
    let rollbackAuthorityError: unknown;
    try {
      for (const page of plan.materializePages) {
        if (!transactionCurrent()) return false;
        while (!current.residentRasters.has(page) && current.residentRasters.size >= plan.plannedPages.length) {
          const obsolete = plan.evictPages.find((candidate) => current.residentRasters.has(candidate) && candidate !== priorActivePage)
            ?? plan.evictPages.find((candidate) => current.residentRasters.has(candidate));
          if (obsolete === undefined) throw new Error("PDF_RESIDENT_TRANSITION_CAPACITY");
          this.evictResidentPage(current, obsolete);
        }
        window.begin(page, plan.generation);
        const committed = await this.renderPageInternal(page, this.viewTransform, transactionCurrent);
        if (!committed || !transactionCurrent()) return false;
        const raster = current.residentRasters.get(page);
        if (raster !== undefined) window.updateMetric(page, { width: raster.viewport.width, height: raster.viewport.height });
      }
      residentAuthority = await this.options.onBeforeResidentCommit?.(plan.plannedPages);
      if (!transactionCurrent()) return false;
      for (const page of plan.evictPages) this.evictResidentPage(current, page);
      if (!transactionCurrent()) return false;
      const finalPlan = window.plan(range.firstVisiblePage, range.lastVisiblePage);
      this.applyWindowSpacers(current, finalPlan);
      const center = window.pageNearestViewportCenter(
        [...current.residentRasters.values()].map((raster) => {
          const top = window.offsetForPage(raster.pageNumber);
          return { pageNumber: raster.pageNumber, top, bottom: top + raster.viewport.height };
        }),
        scrollTop + clientHeight / 2,
      ) ?? range.firstVisiblePage;
      current.activePageNumber = center;
      for (const frame of this.options.canvasHost.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")) {
        frame.dataset.activePage = String(Number(frame.dataset.page) === center);
      }
      residentAuthority?.finalize();
      succeeded = true;
      this.notifyObserver(() => this.options.onPage(center, this.viewTransform));
      return true;
    } finally {
      for (const page of plan.materializePages) window.fail(page, plan.generation);
      if (!succeeded && this.current === current && !this.disposed) {
        this.viewportRollback = true;
        let physicalRestored = false;
        let authorityResidents: number[] = [];
        let physicalRollbackError: unknown;
        try {
          if (residentAuthority !== undefined) {
            try {
              await residentAuthority.rollback();
              residentAuthority = undefined;
            } catch (error) {
              rollbackAuthorityError = error;
              this.options.onStatus(`PDF resident authority rollback failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (rollbackAuthorityError === undefined) {
            try {
              for (const page of [...current.residentRasters.keys()]) {
                if (!originalResidents.has(page)) this.evictResidentPage(current, page);
              }
              const physicallyResident = [...current.residentRasters.keys()].filter((page) => originalResidents.has(page));
              const rollbackPlan = window.restore(checkpoint, physicallyResident);
              this.activeViewportPlan = { candidate: current, plan: rollbackPlan };
              for (const page of rollbackPlan.materializePages) {
                window.begin(page, rollbackPlan.generation);
                try {
                  if (!await this.renderPageInternal(page, this.viewTransform)) {
                    physicalRollbackError ??= new Error("PDF_VIEWPORT_ROLLBACK_RENDER_FAILED");
                  }
                } catch (error) {
                  physicalRollbackError ??= error;
                } finally {
                  window.fail(page, rollbackPlan.generation);
                }
              }
              authorityResidents = [...current.residentRasters.keys()].filter((page) => originalResidents.has(page)).sort((a, b) => a - b);
              this.applyWindowSpacers(current, window.restore(checkpoint, authorityResidents));
              const restoredActive = priorActivePage !== undefined && current.residentRasters.has(priorActivePage)
                ? priorActivePage
                : authorityResidents[0];
              if (restoredActive === undefined) delete current.activePageNumber; else current.activePageNumber = restoredActive;
              for (const frame of this.options.canvasHost.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")) {
                frame.dataset.activePage = String(restoredActive !== undefined && Number(frame.dataset.page) === restoredActive);
              }
              physicalRestored = authorityResidents.length === originalResidents.size;
            } catch (error) {
              physicalRollbackError ??= error;
              authorityResidents = [...current.residentRasters.keys()].filter((page) => originalResidents.has(page)).sort((a, b) => a - b);
              this.options.onStatus(`PDF viewport rollback failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (rollbackAuthorityError === undefined && this.options.onBeforeResidentCommit !== undefined) {
            try {
              const compensation = await this.options.onBeforeResidentCommit(authorityResidents);
              compensation?.finalize();
            } catch (error) {
              rollbackAuthorityError = error;
              this.options.onStatus(`PDF resident authority restore failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (!physicalRestored && rollbackAuthorityError === undefined) {
            rollbackAuthorityError = physicalRollbackError ?? new Error("PDF_VIEWPORT_ROLLBACK_INCOMPLETE");
            this.options.onStatus("PDF viewport rollback was incomplete.");
          }
        } finally {
          this.viewportRollback = false;
        }
      }
      if (this.activeViewportPlan?.candidate === current) this.activeViewportPlan = undefined;
      releaseSettlement();
      if (this.viewportSettlement === settlement) this.viewportSettlement = undefined;
      if (rollbackAuthorityError !== undefined) throw new Error("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
    }
  }
  public get activePageNumber(): number | undefined { return this.current?.activePageNumber; }
  public get visiblePageNumbers(): readonly number[] { return this.current?.visiblePageNumbers ?? Object.freeze([]); }
  public captureScrollAnchor(): PdfScrollAnchor | undefined {
    const current = this.current;
    const pageNumber = current?.activePageNumber;
    const raster = pageNumber === undefined ? undefined : current?.residentRasters.get(pageNumber);
    const frame = pageNumber === undefined ? null : this.options.canvasHost.querySelector<HTMLElement>(`:scope > .pdf-page-frame[data-page='${pageNumber}']`);
    if (pageNumber === undefined || raster === undefined || frame === null) return undefined;
    return capturePdfViewportAnchor({
      pageNumber,
      viewport: raster.viewport,
      pageFrameOffset: { x: frame.offsetLeft + raster.canvas.offsetLeft, y: frame.offsetTop + raster.canvas.offsetTop },
      host: {
        scrollLeft: this.options.canvasHost.scrollLeft,
        scrollTop: this.options.canvasHost.scrollTop,
        clientWidth: this.options.canvasHost.clientWidth,
        clientHeight: this.options.canvasHost.clientHeight,
      },
    });
  }

  public restoreScrollAnchor(anchor: PdfScrollAnchor): void {
    const raster = this.current?.residentRasters.get(anchor.pageNumber);
    const frame = this.options.canvasHost.querySelector<HTMLElement>(`:scope > .pdf-page-frame[data-page='${anchor.pageNumber}']`);
    if (raster === undefined || frame === null) return;
    const host = this.options.canvasHost;
    const restored = restorePdfViewportAnchor(anchor, {
      viewport: raster.viewport,
      pageFrameOffset: { x: frame.offsetLeft + raster.canvas.offsetLeft, y: frame.offsetTop + raster.canvas.offsetTop },
      host: {
        scrollLeft: host.scrollLeft,
        scrollTop: host.scrollTop,
        clientWidth: host.clientWidth,
        clientHeight: host.clientHeight,
        scrollWidth: Math.max(host.clientWidth, host.scrollWidth),
        scrollHeight: Math.max(host.clientHeight, host.scrollHeight),
      },
    });
    host.scrollLeft = restored.scrollLeft;
    host.scrollTop = restored.scrollTop;
  }

  private resolveReachableViewportLanding(anchor: PdfViewportAnchor): PdfViewportLanding | undefined {
    const raster = this.current?.residentRasters.get(anchor.pageNumber);
    const frame = this.options.canvasHost.querySelector<HTMLElement>(`:scope > .pdf-page-frame[data-page='${anchor.pageNumber}']`);
    if (raster === undefined || frame === null) return undefined;
    const host = this.options.canvasHost;
    const pageFrameOffset = { x: frame.offsetLeft + raster.canvas.offsetLeft, y: frame.offsetTop + raster.canvas.offsetTop };
    const restored = restorePdfViewportAnchor(anchor, {
      viewport: raster.viewport,
      pageFrameOffset,
      host: {
        scrollLeft: host.scrollLeft,
        scrollTop: host.scrollTop,
        clientWidth: host.clientWidth,
        clientHeight: host.clientHeight,
        scrollWidth: Math.max(host.clientWidth, host.scrollWidth),
        scrollHeight: Math.max(host.clientHeight, host.scrollHeight),
      },
    });
    const reachable = capturePdfViewportAnchor({
      pageNumber: anchor.pageNumber,
      viewport: raster.viewport,
      pageFrameOffset,
      host: { ...restored, clientWidth: host.clientWidth, clientHeight: host.clientHeight },
      viewportOffset: anchor.viewportOffset,
    });
    return Object.freeze({ pageIndex: reachable.pageNumber - 1, x: reachable.pagePoint.x, y: reachable.pagePoint.y });
  }
  /** Captures the active page centre in W07 canonical zero-based page space. */
  public captureViewportLanding(): PdfViewportLanding | undefined {
    const anchor = this.captureScrollAnchor();
    return anchor === undefined ? undefined : Object.freeze({
      pageIndex: anchor.pageNumber - 1,
      x: anchor.pagePoint.x,
      y: anchor.pagePoint.y,
    });
  }

  private captureViewportLandingAtOffset(pageNumber: number, viewportOffset: { readonly x: number; readonly y: number }): PdfViewportLanding | undefined {
    const raster = this.current?.residentRasters.get(pageNumber);
    const frame = this.options.canvasHost.querySelector<HTMLElement>(`:scope > .pdf-page-frame[data-page='${pageNumber}']`);
    if (raster === undefined || frame === null) return undefined;
    const host = this.options.canvasHost;
    const anchor = capturePdfViewportAnchor({
      pageNumber,
      viewport: raster.viewport,
      pageFrameOffset: { x: frame.offsetLeft + raster.canvas.offsetLeft, y: frame.offsetTop + raster.canvas.offsetTop },
      host: { scrollLeft: host.scrollLeft, scrollTop: host.scrollTop, clientWidth: host.clientWidth, clientHeight: host.clientHeight },
      viewportOffset,
    });
    return Object.freeze({ pageIndex: anchor.pageNumber - 1, x: anchor.pagePoint.x, y: anchor.pagePoint.y });
  }
  /** Restores a canonical landing through the existing W06 materialization and viewport authority. */
  public async restoreViewportLanding(
    target: PdfViewportLanding,
    requestCommitGuard?: PdfRequestCommitGuard,
    targetTransform: PdfViewTransform = this.viewTransform,
    placement: "center" | "page-top" = "center",
  ): Promise<PdfViewportRestoreOutcome> {
    const current = this.current;
    if (current === undefined || current.document === undefined || this.disposed
      || !Number.isSafeInteger(target.pageIndex) || target.pageIndex < 0
      || target.pageIndex >= current.document.numPages || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
      return { kind: "preflightRejected" };
    }
    if (!(requestCommitGuard?.() ?? true)) return { kind: "staleOrCancelled" };
    try {
      await this.getOwnedPage(current, target.pageIndex + 1);
    } catch {
      return { kind: "preflightRejected" };
    }
    if (this.current !== current || this.disposed || !(requestCommitGuard?.() ?? true)) return { kind: "staleOrCancelled" };
    const pageNumber = target.pageIndex + 1;
    try {
      const committed = await this.renderPage(pageNumber, targetTransform, requestCommitGuard);
      if (!committed) return !(requestCommitGuard?.() ?? true) ? { kind: "staleOrCancelled" } : { kind: "failed" };
      if (this.current !== current || this.disposed || !(requestCommitGuard?.() ?? true)) return { kind: "staleOrCancelled" };
      const anchor: PdfViewportAnchor = Object.freeze({
        pageNumber,
        pagePoint: Object.freeze({ x: target.x, y: target.y }),
        viewportOffset: Object.freeze({
          x: this.options.canvasHost.clientWidth / 2,
          y: placement === "page-top" ? 0 : this.options.canvasHost.clientHeight / 2,
        }),
      });
      const expected = this.resolveReachableViewportLanding(anchor);
      if (expected === undefined) return { kind: "failed" };
      this.restoreScrollAnchor(anchor);
      await Promise.resolve();
      if (this.current !== current || this.disposed || !(requestCommitGuard?.() ?? true)) return { kind: "staleOrCancelled" };
      const landing = placement === "page-top"
        ? this.captureViewportLandingAtOffset(pageNumber, anchor.viewportOffset)
        : this.captureViewportLanding();
      if (landing === undefined) return { kind: "failed" };
      if (samePdfViewportLanding(target, landing)) return { kind: "verified", landing };
      return samePdfViewportLanding(expected, landing)
        ? { kind: "constrainedEdgeVerified", landing, expected }
        : { kind: "failed", landing };
    } catch (error) {
      this.options.onStatus(`PDF viewport landing failed: ${error instanceof Error ? error.message : String(error)}`);
      return !(requestCommitGuard?.() ?? true) ? { kind: "staleOrCancelled" } : { kind: "failed" };
    }
  }

  private async renderPageInternal(page: number, transform = this.viewTransform, requestCommitGuard?: PdfRequestCommitGuard, preEvictionAnchor?: PdfScrollAnchor): Promise<boolean> {
    const current = this.current;
    if (current === undefined || current.document === undefined || this.disposed) return false;
    const cssTransformChanged = transform.scale !== this.viewTransform.scale || transform.rotation !== this.viewTransform.rotation;
    const retainedAnchor = this.evictedScrollAnchor?.pageNumber === page ? this.evictedScrollAnchor.anchor : undefined;
    const anchor = preEvictionAnchor ?? retainedAnchor ?? (cssTransformChanged || current.activePageNumber === page ? this.captureScrollAnchor() : undefined);
    const activePlan = !cssTransformChanged && this.activeViewportPlan?.candidate === current ? this.activeViewportPlan.plan : undefined;
    const directPreview = !cssTransformChanged && activePlan === undefined ? current.window?.previewPlan(page) : undefined;
    let directPlan: PageWindowPlan | undefined;
    try {
      const rendered = await this.renderCandidatePage(current, page, transform);
      const commitSequence = this.renderSequence;
      if (this.current !== current || this.disposed || (requestCommitGuard !== undefined && !requestCommitGuard())) { this.releaseRaster(rendered); return false; }
      const retainedPages = cssTransformChanged
        ? Object.freeze([page])
        : Object.freeze([...new Set([
          ...[...current.residentRasters.keys()].filter((resident) => !(directPreview ?? activePlan)?.evictPages.includes(resident)),
          page,
        ])].sort((a, b) => a - b));
      let committed = false;
      const commitCanvas = (accessory?: HTMLElement): boolean => {
        if (committed || commitSequence !== this.renderSequence || this.current !== current || this.disposed || (requestCommitGuard !== undefined && !requestCommitGuard())) return false;
        const prior = current.residentRasters.get(page);
        let plan = activePlan;
        if (!cssTransformChanged && directPreview !== undefined) {
          directPlan = current.window?.plan(page);
          plan = directPlan;
          if (directPlan?.materializePages.includes(page)) current.window?.begin(page, directPlan.generation);
        }
        if (cssTransformChanged) {
          const nextWindow = new ContinuousPageWindow({
            estimatedPageHeight: rendered.viewport.height,
            pageCount: current.document!.numPages,
            pageGap: 12,
            maxResidentPages: RESOURCE_LIMITS.maxResidentPageViews,
            overscanPages: 2,
          });
          plan = nextWindow.plan(page);
          nextWindow.begin(page, plan.generation);
          nextWindow.updateMetric(page, { width: rendered.viewport.width, height: rendered.viewport.height });
          try { nextWindow.publish(page, plan.generation); } catch { return false; }
          for (const residentPage of [...current.residentRasters.keys()]) this.evictResidentPage(current, residentPage);
          current.topSpacer?.remove();
          current.bottomSpacer?.remove();
          current.window = nextWindow;
        } else if (plan !== undefined) {
          if (activePlan === undefined) for (const evicted of plan.evictPages) current.window?.unpublish(evicted);
          current.window?.updateMetric(page, { width: rendered.viewport.width, height: rendered.viewport.height });
          if (plan.materializePages.includes(page)) {
            try { current.window?.publish(page, plan.generation); } catch { return false; }
          }
          if (activePlan === undefined) for (const evicted of plan.evictPages) this.evictResidentPage(current, evicted);
        }
        current.residentRasters.set(page, rendered);
        current.activePageNumber = page;
        if (this.activeViewportPlan === undefined) current.visiblePageNumbers = Object.freeze([page]);
        this.viewTransform = transform;
        if (prior !== undefined) this.releaseRaster(prior);
        this.canvasReplace(rendered.canvas, accessory);
        if (plan !== undefined) this.applyWindowSpacers(current, plan);
        if (directPlan !== undefined && anchor === undefined && current.window !== undefined) {
          this.options.canvasHost.scrollTop = current.window.offsetForPage(page);
        }
        if (anchor !== undefined) this.restoreScrollAnchor(anchor);
        if (retainedAnchor !== undefined) this.evictedScrollAnchor = undefined;
        committed = true;
        if (activePlan === undefined) this.notifyObserver(() => this.options.onPage(page, transform));
        return true;
      };
      try {
      if (this.options.onBeforeCommit === undefined) commitCanvas();
      else await this.options.onBeforeCommit(rendered, commitCanvas, { document: current.document, session: current.session, ownerGeneration: current.ownerGeneration, retainedPages, opening: false });
      } catch (error) {
        if (!committed) this.releaseRaster(rendered);
        throw error;
      }
      if (!committed) { this.releaseRaster(rendered); return false; }
      return true;
    } catch (error) {
      if (isRenderCancellation(error)) return false;
      if (!this.disposed && this.current === current) this.options.onStatus(safeMessage(error));
      return false;
    }
    finally {
      if (directPlan?.materializePages.includes(page)) current.window?.fail(page, directPlan.generation);
    }
  }
  private async renderPageWithinResidentCapacity(page: number, transform: PdfViewTransform, guard: PdfRequestCommitGuard): Promise<boolean> {
    const current = this.current;
    const window = current?.window;
    if (current === undefined || current.document === undefined || window === undefined || this.disposed) return false;
    const checkpoint = window.checkpoint();
    const priorActivePage = current.activePageNumber;
    const priorTransform = this.viewTransform;
    const preEvictionAnchor = page === priorActivePage ? this.captureScrollAnchor() : undefined;
    const previewEvictions = transform.scale === priorTransform.scale && transform.rotation === priorTransform.rotation
      ? window.previewPlan(page).evictPages
      : checkpoint.residentPages;
    const victim = current.residentRasters.has(page) && page !== priorActivePage
      ? page
      : previewEvictions.find((candidate) => candidate !== priorActivePage && current.residentRasters.has(candidate))
        ?? [...current.residentRasters.keys()].find((candidate) => candidate !== priorActivePage)
        ?? [...current.residentRasters.keys()][0];
    if (victim === undefined) return this.renderPageInternal(page, transform, guard);
    this.evictResidentPage(current, victim);
    const committed = await this.renderPageInternal(page, transform, guard, preEvictionAnchor);
    if (committed) return true;
    this.viewportRollback = true;
    try {
      let rollbackIncomplete = false;
      for (const resident of [...current.residentRasters.keys()]) if (!checkpoint.residentPages.includes(resident)) this.evictResidentPage(current, resident);
      const physicallyResident = [...current.residentRasters.keys()].filter((resident) => checkpoint.residentPages.includes(resident));
      const rollbackPlan = window.restore(checkpoint, physicallyResident);
      this.activeViewportPlan = { candidate: current, plan: rollbackPlan };
      for (const resident of rollbackPlan.materializePages) {
        window.begin(resident, rollbackPlan.generation);
        try {
          if (!await this.renderPageInternal(resident, priorTransform)) rollbackIncomplete = true;
        } catch {
          rollbackIncomplete = true;
        } finally {
          window.fail(resident, rollbackPlan.generation);
        }
      }
      const authorityResidents = [...current.residentRasters.keys()].filter((resident) => checkpoint.residentPages.includes(resident)).sort((a, b) => a - b);
      this.applyWindowSpacers(current, window.restore(checkpoint, authorityResidents));
      const restoredActive = priorActivePage !== undefined && current.residentRasters.has(priorActivePage) ? priorActivePage : authorityResidents[0];
      if (restoredActive === undefined) delete current.activePageNumber; else current.activePageNumber = restoredActive;
      for (const frame of this.options.canvasHost.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")) {
        frame.dataset.activePage = String(restoredActive !== undefined && Number(frame.dataset.page) === restoredActive);
      }
      if (this.options.onBeforeResidentCommit !== undefined) {
        try {
          const compensation = await this.options.onBeforeResidentCommit(authorityResidents);
          compensation?.finalize();
        } catch (error) {
          this.options.onStatus(`PDF direct authority restore failed: ${error instanceof Error ? error.message : String(error)}`);
          throw new Error("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
        }
      }
      if (rollbackIncomplete || authorityResidents.length !== checkpoint.residentPages.length) {
        this.options.onStatus("PDF direct rollback was incomplete.");
        throw new Error("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
      }
      return false;
    } finally {
      this.viewportRollback = false;
      if (this.activeViewportPlan?.candidate === current) this.activeViewportPlan = undefined;
    }
  }
  private async rerenderResidentBackingsForDpr(transform: PdfViewTransform, requestCommitGuard?: PdfRequestCommitGuard): Promise<boolean> {
    const current = this.current;
    const window = current?.window;
    if (current === undefined || current.document === undefined || window === undefined || this.disposed) return false;
    const pages = [...current.residentRasters.keys()].sort((a, b) => a - b);
    if (pages.length === 0) return false;
    const priorTransform = this.viewTransform;
    const activePage = current.activePageNumber;
    const checkpoint = window.checkpoint();
    const basePlan = window.restore(checkpoint, checkpoint.residentPages);
    const restoreResidentActivity = (): number | undefined => {
      const restoredActive = activePage !== undefined && current.residentRasters.has(activePage)
        ? activePage
        : [...current.residentRasters.keys()].sort((a, b) => a - b)[0];
      if (restoredActive === undefined) delete current.activePageNumber; else current.activePageNumber = restoredActive;
      return restoredActive;
    };
    const replaceAll = async (target: PdfViewTransform, guard?: PdfRequestCommitGuard): Promise<boolean> => {
      for (const page of pages) {
        if (guard !== undefined && !guard()) return false;
        if (current.residentRasters.has(page)) this.evictResidentPage(current, page);
        const pagePlan: PageWindowPlan = { ...basePlan, residentPages: this.residentPageNumbers(), materializePages: [page] };
        this.activeViewportPlan = { candidate: current, plan: pagePlan };
        window.begin(page, pagePlan.generation);
        const replaced = await this.renderPageInternal(page, target, guard);
        window.fail(page, pagePlan.generation);
        if (!replaced) return false;
      }
      return true;
    };
    let succeeded = false;
    try {
      succeeded = await replaceAll(transform, requestCommitGuard);
      if (!succeeded) return false;
      const restoredActive = restoreResidentActivity();
      for (const frame of this.options.canvasHost.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")) {
        frame.dataset.activePage = String(restoredActive !== undefined && Number(frame.dataset.page) === restoredActive);
      }
      if (restoredActive !== undefined) this.notifyObserver(() => this.options.onPage(restoredActive, transform));
      return true;
    } finally {
      try {
        if (!succeeded && this.current === current && !this.disposed) {
          this.viewportRollback = true;
          try {
            const rollbackComplete = await replaceAll(priorTransform);
            for (const [page, raster] of [...current.residentRasters]) {
              if (raster.transform.scale !== priorTransform.scale
                || raster.transform.rotation !== priorTransform.rotation
                || raster.transform.devicePixelRatio !== priorTransform.devicePixelRatio) {
                this.evictResidentPage(current, page);
              }
            }
            const authorityResidents = [...current.residentRasters.keys()]
              .filter((page) => checkpoint.residentPages.includes(page))
              .sort((a, b) => a - b);
            window.restore(checkpoint, authorityResidents);
            const restoredActive = restoreResidentActivity();
            for (const frame of this.options.canvasHost.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")) {
              frame.dataset.activePage = String(restoredActive !== undefined && Number(frame.dataset.page) === restoredActive);
            }
            this.viewTransform = priorTransform;
            if (this.options.onBeforeResidentCommit !== undefined) {
              try {
                const compensation = await this.options.onBeforeResidentCommit(authorityResidents);
                compensation?.finalize();
              } catch (error) {
                this.options.onStatus(`PDF DPR authority restore failed: ${error instanceof Error ? error.message : String(error)}`);
                throw new Error("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
              }
            }
            if (!rollbackComplete || authorityResidents.length !== checkpoint.residentPages.length) {
              this.options.onStatus("PDF DPR rollback was incomplete.");
              throw new Error("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
            }
          } finally {
            this.viewportRollback = false;
          }
        }
      } finally {
        window.restore(checkpoint, [...current.residentRasters.keys()].filter((page) => checkpoint.residentPages.includes(page)));
        if (this.activeViewportPlan?.candidate === current) this.activeViewportPlan = undefined;
      }
    }
  }
  public async renderPage(page: number, transform = this.viewTransform, requestCommitGuard?: PdfRequestCommitGuard): Promise<boolean> {
    const requestSequence = ++this.presentationRequestSequence;
    await this.awaitViewportIdle();
    if (requestSequence !== this.presentationRequestSequence) return false;
    const ownerCurrent = (): boolean => requestSequence === this.presentationRequestSequence
      && (requestCommitGuard?.() ?? true);
    const replacesResidentDpr = transform.scale === this.viewTransform.scale
      && transform.rotation === this.viewTransform.rotation
      && transform.devicePixelRatio !== this.viewTransform.devicePixelRatio
      && (this.current?.residentRasters.size ?? 0) > 1;
    const plannedWindowSize = this.current?.window?.checkpoint().plannedPages.length ?? 0;
    const needsBoundedReplacement = plannedWindowSize > 0 && (this.current?.residentRasters.size ?? 0) >= plannedWindowSize;
    if (!replacesResidentDpr && !needsBoundedReplacement) return this.renderPageInternal(page, transform, ownerCurrent);
    let releaseSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    this.viewportSettlement = settlement;
    try {
      return replacesResidentDpr
        ? await this.rerenderResidentBackingsForDpr(transform, ownerCurrent)
        : await this.renderPageWithinResidentCapacity(page, transform, ownerCurrent);
    } finally {
      releaseSettlement();
      if (this.viewportSettlement === settlement) this.viewportSettlement = undefined;
    }
  }
  /** Cancels foreground rendering without releasing the owned document session. */
  public async suspend(): Promise<void> {
    this.presentationRequestSequence += 1;
    await this.awaitViewportIdle();
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
    await this.cancelActiveRender();
  }

  /** Releases a suspended tab's committed canvas without closing its native PDF session. */
  public evictInactiveCanvas(): boolean {
    const current = this.current;
    if (current === undefined || current.residentRasters.size === 0 || this.activeRender !== undefined) return false;
    const anchor = this.captureScrollAnchor();
    this.evictedScrollAnchor = anchor === undefined ? undefined : { pageNumber: anchor.pageNumber, anchor };
    for (const page of [...current.residentRasters.keys()]) this.evictResidentPage(current, page);
    delete current.activePageNumber;
    this.options.canvasHost.replaceChildren();
    return true;
  }

  public async dispose(): Promise<void> {
    this.presentationRequestSequence += 1;
    await this.awaitViewportIdle();
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
      operation = { task, settled, cancelRequested: false };
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
    frame.style.marginBottom = "12px";
    canvas.classList.add("pdf-page-canvas-layer");
    const textLayer = document.createElement("div");
    textLayer.className = "pdf-page-text-layer";
    const annotationLayer = document.createElement("div");
    annotationLayer.className = "pdf-page-annotation-layer";
    if (accessory !== undefined) {
      const contentText = accessory.querySelector<HTMLElement>(":scope > .textLayer");
      const contentAnnotations = accessory.querySelector<HTMLElement>(":scope > .annotationLayer");
      if (contentText !== null && contentAnnotations !== null) {
        textLayer.append(contentText);
        annotationLayer.append(contentAnnotations);
      } else {
        textLayer.append(accessory);
      }
    }
    frame.append(canvas, textLayer, annotationLayer);
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
      if (successor === undefined) {
        const bottomSpacer = this.options.canvasHost.querySelector<HTMLElement>(":scope > .pdf-page-spacer-bottom");
        if (bottomSpacer === null) this.options.canvasHost.append(frame);
        else this.options.canvasHost.insertBefore(frame, bottomSpacer);
      }
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

  private evictResidentPage(candidate: Candidate, page: number): void {
    const raster = candidate.residentRasters.get(page);
    if (raster === undefined) return;
    candidate.residentRasters.delete(page);
    candidate.window?.unpublish(page);
    this.options.onEvictPage?.(page);
    this.releaseRaster(raster);
    this.options.canvasHost.querySelector<HTMLElement>(`:scope > .pdf-page-frame[data-page='${page}']`)?.remove();
  }

  private applyWindowSpacers(candidate: Candidate, plan: PageWindowPlan): void {
    const host = this.options.canvasHost;
    const spacer = (existing: HTMLElement | undefined, position: "top" | "bottom", height: number): HTMLElement => {
      const element = existing ?? document.createElement("div");
      element.className = `pdf-page-spacer pdf-page-spacer-${position}`;
      element.dataset.pageSpacer = position;
      element.style.height = `${Math.max(0, height)}px`;
      element.style.width = "1px";
      return element;
    };
    candidate.topSpacer = spacer(candidate.topSpacer, "top", plan.topSpacer);
    candidate.bottomSpacer = spacer(candidate.bottomSpacer, "bottom", plan.bottomSpacer);
    if (candidate.topSpacer.parentElement !== host) host.prepend(candidate.topSpacer);
    if (candidate.bottomSpacer.parentElement !== host) host.append(candidate.bottomSpacer);
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
    if (!operation.cancelRequested) {
      operation.cancelRequested = true;
      operation.task.cancel();
    }
    await withDeadline(operation.settled, RENDER_DEADLINE_MS, "RENDER_CANCEL_TIMEOUT");
  }
}
