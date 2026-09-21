import { clampReaderScale } from "../domain/navigation/ZoomPolicy";
import { PDFDataRangeTransport } from "pdfjs-dist";
import { openFailureStatus } from "../domain/navigation/OpenFailureIdentifier";
import type { OpaquePdfSessionMetadata } from "./PdfDataRangeAdapter";
import type {
  PdfContentDocument,
  PdfContentPage,
  PdfContentViewport,
} from "./PdfContentController";
import { PDFJS_POLICY } from "./PdfJsPolicy";
import { ContinuousPageWindow, type PageWindowPlan, type PageGeometryProjection } from "./ContinuousPageWindow";
import {
  capturePdfViewportAnchor,
  restorePdfViewportAnchor,
  samePdfViewportLanding,
  type PdfViewportAnchor,
  type PdfViewportLanding,
} from "./PdfViewportAnchor";
import { printPdfDocument, type PdfPrintProgress, type PdfPrintNative } from "./PdfPrintService";
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

export interface PdfPasswordRequest {
  readonly reason: "required" | "incorrect";
  readonly signal: AbortSignal;
}

export interface PdfRenderTask { promise: Promise<void>; cancel(): void; }
export interface PdfViewport extends PdfContentViewport {}
export interface PdfPage extends PdfContentPage {
  getViewport(options: { readonly scale: number; readonly rotation: number }): PdfViewport;
  render(options: { readonly canvas: HTMLCanvasElement; readonly canvasContext: CanvasRenderingContext2D; readonly viewport: unknown; readonly transform?: readonly [number, number, number, number, number, number]; readonly annotationMode: number }): PdfRenderTask;
}
export interface PdfDocument extends PdfContentDocument {
  getPage(page: number): Promise<PdfPage>;
}
export interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void> | void;
  onPassword?: (updatePassword: (password: string) => void, reason: number) => void;
}
interface PreparedPdfPage { readonly page: PdfPage; readonly viewport: PdfViewport; }
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
export interface PdfOpeningFitEvidence {
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly scale: number;
  readonly complete: boolean;
}
export interface PdfReaderControllerOptions {
  readonly printNative?: (session: OpenPdfResult, ownerGeneration: number) => PdfPrintNative;
  readonly onPrintProgress?: (progress: PdfPrintProgress | undefined) => void;
  readonly onPassword?: (request: PdfPasswordRequest) => Promise<string | null>;
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
    openingFit?: PdfOpeningFitEvidence,
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
export interface PdfViewportOffset {
  readonly x: number;
  readonly y: number;
}
export type PdfPresentationTopology = "continuous" | "single-page";
type PdfRenderViewportPolicy = "preserve-anchor" | "opening-top";

interface PasswordPrompt {
  readonly controller: AbortController;
  updatePassword?: (password: string) => void;
  active: boolean;
}
interface OpeningFailure {
  readonly promise: Promise<never>;
  reject(error: Error): void;
}
interface Candidate {
  readonly session: OpenPdfResult;
  readonly task: PdfLoadingTask;
  readonly transport: { destroy(): Promise<void> };
  readonly rangeTransport?: PdfProtocolRangeTransport;
  window?: ContinuousPageWindow;
  topSpacer?: HTMLElement;
  bottomSpacer?: HTMLElement;
  topology: PdfPresentationTopology;
  transportDestroyHandedOff?: boolean;
  readonly ownerGeneration: number;
  transportFailure?: Error;
  closed: boolean;
  readonly openingFailure: OpeningFailure;
  passwordPrompt?: PasswordPrompt;
  passwordChallengeActive: boolean;
  passwordTerminal: boolean;
  passwordPending: boolean;
  passwordStageChanged?: () => void;
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
  if (/PASSWORD_CANCELLED/i.test(tag)) return "Opening PDF cancelled.";
  if (/PASSWORD/i.test(tag)) return "The PDF password was not accepted.";
  if (/CANCEL|ABORT/i.test(tag)) return "Opening PDF cancelled.";
  if (/WORKER|ASSET/i.test(tag)) return "The local PDF renderer could not start.";
  if (/TIMEOUT/i.test(tag)) return "The PDF operation timed out.";
  if (/PATH_REJECTED/i.test(tag)) return "This PDF path cannot be opened safely.";
  if (/DOCUMENT_TOO_LARGE|_LIMIT|_CAPACITY|large|resource|canvas|memory/i.test(tag)) return "This PDF exceeds reader resource limits.";
  if (/EMPTY_DOCUMENT|PDF_EMPTY/i.test(tag)) return "PDF contains no pages.";
  if (/FILE_UNREADABLE|PDF_INVALID|PDF_EMPTY|RANGE|read|malformed|invalid|corrupt/i.test(tag)) return "Could not read this PDF.";
  return openFailureStatus("presentation");
};

const createOpeningFailure = (): OpeningFailure => {
  let rejectFailure!: (error: Error) => void;
  let settled = false;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  return {
    promise,
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectFailure(error);
    },
  };
};
/** Owns opaque sessions and PDFs. A candidate is invisible until its first page has rendered. */
export class PdfReaderController {
  private current: Candidate | undefined;
  private opening: Candidate | undefined;
  private activeRender: ActiveRender | undefined;
  private activePrint: ActivePrint | undefined;
  private latestPrintProgress: PdfPrintProgress | undefined;
  private readonly releasedRasters = new WeakSet<RenderedCanvas>();
  private renderSequence = 0;
  private disposed = false;
  private openSequence = 0;
  private readonly quarantinedCandidates = new Set<Candidate>();
  private readonly pendingCleanups = new Map<string, PendingCleanup>();
  private readonly teardownSessions = new Map<string, Promise<void>>();
  private activeViewportPlan: { readonly candidate: Candidate; readonly plan: PageWindowPlan;
    readonly publishLayout?: (page: number, raster: RenderedCanvas, anchor: PdfScrollAnchor | undefined, publish: () => void) => boolean;
  } | undefined;
  private viewportEpoch = 0;
  private viewportSettlement: Promise<void> | undefined;
  private presentationRequestSequence = 0;
  private viewportRollback = false;
  private viewTransform: PdfViewTransform = {
    scale: 1.25,
    rotation: 0,
    devicePixelRatio: typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1),
  };

  private notifyPasswordStage(candidate: Candidate): void {
    candidate.passwordStageChanged?.();
  }

  private abortPasswordPrompt(candidate: Candidate): void {
    const prompt = candidate.passwordPrompt;
    if (prompt === undefined) return;
    prompt.active = false;
    delete prompt.updatePassword;
    delete candidate.passwordPrompt;
    prompt.controller.abort();
    if (candidate.passwordPending) {
      candidate.passwordPending = false;
      this.notifyPasswordStage(candidate);
    }
  }

  private finishPasswordLifecycle(candidate: Candidate, terminal = true): void {
    candidate.passwordTerminal = true;
    if (terminal) candidate.passwordChallengeActive = false;
    delete candidate.task.onPassword;
    this.abortPasswordPrompt(candidate);
    if (candidate.passwordPending) {
      candidate.passwordPending = false;
      this.notifyPasswordStage(candidate);
    }
  }

  private rejectOpening(candidate: Candidate, error: Error): void {
    this.finishPasswordLifecycle(candidate);
    candidate.openingFailure.reject(error);
  }

  private submitPasswordPrompt(
    candidate: Candidate,
    prompt: PasswordPrompt,
    result: string | null | undefined,
    error?: unknown,
  ): void {
    if (!prompt.active || candidate.passwordPrompt !== prompt) return;
    prompt.active = false;
    const updatePassword = prompt.updatePassword;
    delete prompt.updatePassword;
    delete candidate.passwordPrompt;
    prompt.controller.abort();
    candidate.passwordPending = false;
    this.notifyPasswordStage(candidate);
    if (candidate.closed || this.disposed || this.opening !== candidate) return;
    if (error !== undefined) {
      this.rejectOpening(candidate, error instanceof Error ? error : new Error("PDF_PASSWORD_PROMPT_FAILED"));
      void this.disposeCandidate(candidate);
      return;
    }
    if (result === null) {
      this.rejectOpening(candidate, new Error("PASSWORD_CANCELLED"));
      void this.disposeCandidate(candidate);
      return;
    }
    if (typeof result !== "string") {
      this.rejectOpening(candidate, new Error("PASSWORD_CANCELLED"));
      void this.disposeCandidate(candidate);
      return;
    }
    try {
      if (!candidate.closed && !this.disposed && this.opening === candidate) updatePassword?.(result);
    } catch (updateError) {
      this.rejectOpening(candidate, updateError instanceof Error ? updateError : new Error("PDF_PASSWORD_UPDATE_FAILED"));
      void this.disposeCandidate(candidate);
    }
  }

  private handlePasswordRequest(
    candidate: Candidate,
    updatePassword: (password: string) => void,
    rawReason: number,
  ): void {
    if (candidate.closed || this.disposed || this.opening !== candidate || candidate.passwordTerminal) return;
    const reason = rawReason === 1 ? "required" : rawReason === 2 ? "incorrect" : undefined;
    if (reason === undefined) {
      this.rejectOpening(candidate, new Error("PDF_PASSWORD_REASON_INVALID"));
      void this.disposeCandidate(candidate);
      return;
    }
    this.abortPasswordPrompt(candidate);
    candidate.passwordChallengeActive = true;
    candidate.passwordPending = true;
    this.notifyPasswordStage(candidate);
    const prompt: PasswordPrompt = {
      controller: new AbortController(),
      updatePassword,
      active: true,
    };
    candidate.passwordPrompt = prompt;
    const request: PdfPasswordRequest = { reason, signal: prompt.controller.signal };
    const callback = this.options.onPassword;
    if (callback === undefined) {
      this.submitPasswordPrompt(candidate, prompt, null);
      return;
    }
    void Promise.resolve().then(() => {
      if (!prompt.active || candidate.passwordPrompt !== prompt || candidate.closed || this.disposed || this.opening !== candidate) return undefined;
      return callback(request);
    }).then(
      (password) => this.submitPasswordPrompt(candidate, prompt, password),
      (error: unknown) => this.submitPasswordPrompt(candidate, prompt, null, error),
    );
  }

  private async awaitOpeningDocument(candidate: Candidate, taskPromise: Promise<PdfDocument>, rangeFailure: Promise<never>): Promise<PdfDocument> {
    type Result =
      | { readonly kind: "document"; readonly document: PdfDocument }
      | { readonly kind: "failure"; readonly error: unknown };
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let settle!: (result: Result) => void;
    const clearMetadataTimer = (): void => {
      if (timeoutId === undefined) return;
      clearTimeout(timeoutId);
      timeoutId = undefined;
    };
    const armMetadataTimer = (): void => {
      if (settled || candidate.passwordPending || timeoutId !== undefined) return;
      timeoutId = setTimeout(() => {
        timeoutId = undefined;
        settle({ kind: "failure", error: new Error("PDF_TIMEOUT") });
      }, METADATA_DEADLINE_MS);
    };
    const result = await new Promise<Result>((resolve) => {
      settle = (next) => {
        if (settled) return;
        settled = true;
        clearMetadataTimer();
        resolve(next);
      };
      candidate.passwordStageChanged = (): void => {
        if (candidate.passwordPending) clearMetadataTimer();
        else armMetadataTimer();
      };
      armMetadataTimer();
      void taskPromise.then(
        (document) => {
          this.finishPasswordLifecycle(candidate, false);
          settle({ kind: "document", document });
        },
        (error: unknown) => {
          this.finishPasswordLifecycle(candidate);
          settle({ kind: "failure", error });
        },
      );
      void rangeFailure.then(
        () => settle({ kind: "failure", error: new Error("PDF_RANGE_FAILED") }),
        (error: unknown) => settle({ kind: "failure", error }),
      );
      void candidate.openingFailure.promise.then(
        () => settle({ kind: "failure", error: new Error("Opening PDF cancelled") }),
        (error: unknown) => settle({ kind: "failure", error }),
      );
    });
    clearMetadataTimer();
    if (candidate.passwordStageChanged !== undefined) delete candidate.passwordStageChanged;
    if (result.kind === "document") return result.document;
    throw result.error;
  }

  public cancelPasswordOpening(): void {
    const candidate = this.opening;
    if (candidate === undefined || candidate.closed || !candidate.passwordChallengeActive) return;
    this.rejectOpening(candidate, new Error("PASSWORD_CANCELLED"));
    void this.disposeCandidate(candidate);
  }
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
      topology: "continuous",
      openingFailure: createOpeningFailure(),
      passwordChallengeActive: false,
      passwordTerminal: false,
      passwordPending: false,
    };
    candidateRef = candidate;
    this.opening = candidate;
    task.onPassword = (updatePassword, reason) => {
      this.handlePasswordRequest(candidate, updatePassword, reason);
    };
    this.options.onStatus(`Opening ${session.displayName}`);
    try {
      const document = await this.awaitOpeningDocument(candidate, task.promise, rangeFailure);
      candidate.document = document;
      if (document.numPages < 1) throw new Error("EMPTY_DOCUMENT");
      const firstPage = await this.getOwnedPage(candidate, 1);
      const firstViewport = firstPage.getViewport({ scale: 1, rotation: 0 });
      let openingFitEvidence!: PdfOpeningFitEvidence;
      let openingTransform!: PdfViewTransform;
      let rendered!: RenderedCanvas;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const available = this.usableContentSize();
        const complete = available !== undefined
          && Number.isFinite(available.width) && available.width > 0
          && Number.isFinite(available.height) && available.height > 0;
        const contentWidth = complete ? available!.width : firstViewport.width;
        const contentHeight = complete ? available!.height : firstViewport.height;
        const scale = complete
          ? Math.min(contentWidth / firstViewport.width, contentHeight / firstViewport.height)
          : contentWidth / firstViewport.width;
        openingFitEvidence = {
          contentWidth,
          contentHeight,
          scale: clampReaderScale(scale),
          complete,
        };
        openingTransform = this.normalizeViewTransform({
          scale: openingFitEvidence.scale,
          rotation: 0,
          devicePixelRatio: typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1),
        });
        rendered = await this.renderCandidatePage(candidate, 1, openingTransform);
        const after = this.usableContentSize();
        const stable = !openingFitEvidence.complete || (after !== undefined
          && after.width === openingFitEvidence.contentWidth
          && after.height === openingFitEvidence.contentHeight);
        if (stable || attempt === 3) {
          if (!stable) openingFitEvidence = { ...openingFitEvidence, complete: false };
          break;
        }
        this.releaseRaster(rendered);
      }
      candidate.residentRasters.set(1, rendered);
      if (candidate.cleanup !== undefined || this.disposed || this.opening !== candidate) {
        this.releaseRaster(rendered);
        throw new Error("Opening PDF cancelled");
      }
      candidate.window = new ContinuousPageWindow({
        pageCount: document.numPages,
        estimatedPageWidth: rendered.viewport.width,
        estimatedPageHeight: rendered.viewport.height,
        pageGap: 12,
        maxResidentPages: RESOURCE_LIMITS.maxResidentPageViews,
        overscanPages: 2,
      });
      candidate.window.updateMetric(1, { width: rendered.viewport.width, height: rendered.viewport.height });
      let openingPlan = candidate.window.plan(1);
      candidate.window.begin(1, openingPlan.generation);
      candidate.window.publish(1, openingPlan.generation);
      candidate.activePageNumber = 1;
      candidate.visiblePageNumbers = Object.freeze([1]);
      if (this.disposed || this.opening !== candidate) throw new Error("Opening PDF cancelled");
      let priorCleanup: Promise<void> | undefined;
      let canvasCommitted = false;
      const commitCanvas = (accessory?: HTMLElement): boolean => {
        if (canvasCommitted || this.disposed || this.opening !== candidate) return false;
        const commitAvailable = this.usableContentSize();
        const commitGeometryStable = openingFitEvidence.complete
          ? commitAvailable !== undefined
            && commitAvailable.width === openingFitEvidence.contentWidth
            && commitAvailable.height === openingFitEvidence.contentHeight
          : commitAvailable === undefined || !(commitAvailable.width > 0 && commitAvailable.height > 0);
        if (!commitGeometryStable) return false;
        const prior = this.current;
        this.current = candidate;
        this.opening = undefined;
        this.finishPasswordLifecycle(candidate);
        this.options.canvasHost.classList.remove("pdf-reader-single-page");
        this.viewTransform = openingTransform;
        this.canvasReplace(rendered.canvas, accessory, undefined, true);
        this.applyWindowSpacers(candidate, openingPlan);
        this.options.canvasHost.scrollTop = 0;
        canvasCommitted = true;
        delete candidate.stagedTeardown;
        priorCleanup = this.disposeCandidate(prior);
        this.notifyObserver(() => this.options.onCommitted(document.numPages, session.displayName, document, session, ownerGeneration, openingFitEvidence));
        this.notifyObserver(() => this.options.onPage(1, openingTransform));
        return true;
      };
      const commitOpening = async (): Promise<void> => {
        if (this.options.onBeforeCommit === undefined) {
          commitCanvas();
          return;
        }
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
      };
      for (let attempt = 0; attempt < 3 && !canvasCommitted; attempt += 1) {
        await commitOpening();
        if (canvasCommitted || attempt === 2) break;
        const latest = this.usableContentSize();
        const retryableGeometry = !this.disposed && this.opening === candidate && candidate.cleanup === undefined
          && latest !== undefined && Number.isFinite(latest.width) && Number.isFinite(latest.height)
          && latest.width > 0 && latest.height > 0
          && (!openingFitEvidence.complete || latest.width !== openingFitEvidence.contentWidth
            || latest.height !== openingFitEvidence.contentHeight);
        if (!retryableGeometry) break;
        await this.beginStagedTeardown(candidate);
        if (this.disposed || this.opening !== candidate || candidate.cleanup !== undefined) break;
        delete candidate.stagedTeardown;
        delete candidate.stagedTeardownCompleted;
        candidate.residentRasters.delete(1);
        this.releaseRaster(rendered);
        const complete = latest !== undefined
          && latest.width > 0 && latest.height > 0;
        const contentWidth = complete ? latest!.width : firstViewport.width;
        const contentHeight = complete ? latest!.height : firstViewport.height;
        const scale = complete
          ? Math.min(contentWidth / firstViewport.width, contentHeight / firstViewport.height)
          : contentWidth / firstViewport.width;
        openingFitEvidence = {
          contentWidth,
          contentHeight,
          scale: clampReaderScale(scale),
          complete,
        };
        openingTransform = this.normalizeViewTransform({
          scale: openingFitEvidence.scale,
          rotation: 0,
          devicePixelRatio: typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1),
        });
        rendered = await this.renderCandidatePage(candidate, 1, openingTransform);
        candidate.residentRasters.set(1, rendered);
        candidate.window = new ContinuousPageWindow({
          pageCount: document.numPages,
          estimatedPageWidth: rendered.viewport.width,
          estimatedPageHeight: rendered.viewport.height,
          pageGap: 12,
          maxResidentPages: RESOURCE_LIMITS.maxResidentPageViews,
          overscanPages: 2,
        });
        candidate.window.updateMetric(1, { width: rendered.viewport.width, height: rendered.viewport.height });
        openingPlan = candidate.window.plan(1);
        candidate.window.begin(1, openingPlan.generation);
        candidate.window.publish(1, openingPlan.generation);
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

  public get printProgress(): PdfPrintProgress | undefined { return this.latestPrintProgress; }

  public async printCurrent(): Promise<boolean> {
    const current = this.current;
    if (current === undefined || current.document === undefined || current.closed || this.disposed
      || this.activePrint !== undefined) return false;
    const printDocument = current.document;
    const createNative = this.options.printNative;
    if (createNative === undefined) {
      this.options.onStatus("Printing is unavailable.");
      return false;
    }
    const activePageNumber = current.activePageNumber;
    const transform = this.viewTransform;
    const abort = new AbortController();
    const printOwnerships = new Set<Promise<void>>();
    // Admit the controller slot before callbacks can re-enter Print/Close.
    const operation = Promise.resolve().then(() => printPdfDocument({
      document: printDocument,
      native: createNative(current.session, current.ownerGeneration),
      pageCount: printDocument.numPages,
      currentPage: activePageNumber ?? 1,
      title: current.session.displayName,
      annotationMode: this.options.pdf.annotationMode,
      resources: this.options.resources,
      sessionId: current.session.sessionId,
      signal: abort.signal,
      onProgress: (progress) => {
        if (this.activePrint?.abort !== abort) return;
        this.latestPrintProgress = progress;
        this.notifyObserver(() => this.options.onPrintProgress?.(progress));
      },
      onOwnershipSettlement: (raw) => { printOwnerships.add(raw); },
    }));
    const settlement = operation.then(() => undefined, () => undefined)
      .then(() => Promise.allSettled([...printOwnerships]))
      .then(() => undefined);
    const activePrint = { owner: current, abort, settlement };
    this.activePrint = activePrint;
    current.ownedPrintSettlements.add(settlement);
    void settlement.then(() => {
      if (this.activePrint === activePrint) {
        this.activePrint = undefined;
        this.latestPrintProgress = undefined;
        this.notifyObserver(() => this.options.onPrintProgress?.(undefined));
      }
      current.ownedPrintSettlements.delete(settlement);
      this.retryQuarantinedCandidate(current);
    });
    try {
      const outcome = await operation;
      if (outcome.kind === "failed") {
        if (this.current === current && !this.disposed) this.options.onStatus(`Printing failed: ${outcome.reason}`);
        return false;
      }
      if (outcome.kind !== "submitted") return false;
      return this.current === current && !current.closed
        && current.activePageNumber === activePageNumber && this.viewTransform === transform;
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
  /** Resolves a worker-cloned PDF reference through reader-owned page proxies. */
  public async resolvePageReference(reference: unknown, requestCommitGuard?: PdfRequestCommitGuard): Promise<number | null> {
    const current = this.current;
    if (current === undefined || current.document === undefined || this.disposed
      || (requestCommitGuard !== undefined && !requestCommitGuard())) return null;
    const cached = current.document.cachedPageNumber?.(reference);
    if (cached !== null && cached !== undefined && Number.isSafeInteger(cached) && cached >= 1 && cached <= current.document.numPages) return cached;
    try {
      const pageIndex = await current.document.getPageIndex?.(reference);
      if (this.current !== current || this.disposed || (requestCommitGuard !== undefined && !requestCommitGuard())) return null;
      return pageIndex !== undefined && Number.isSafeInteger(pageIndex) && pageIndex >= 0 && pageIndex < current.document.numPages ? pageIndex + 1 : null;
    } catch {
      return null;
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
    topology: PdfPresentationTopology = this.current?.topology ?? "continuous",
    preEvictionAnchor?: PdfScrollAnchor,
  ): Promise<boolean> {
    const normalized = this.normalizeViewTransform(transform);
    const current = this.current;
    if (current?.residentRasters.has(page)
      && topology === current.topology
      && normalized.scale === this.viewTransform.scale
      && normalized.rotation === this.viewTransform.rotation
      && normalized.devicePixelRatio === this.viewTransform.devicePixelRatio) {
      this.presentationRequestSequence += 1;
      return requestCommitGuard?.() ?? true;
    }
    return this.renderPage(page, normalized, requestCommitGuard, topology, preEvictionAnchor);
  }
  public get presentationTopology(): PdfPresentationTopology { return this.current?.topology ?? "continuous"; }
  public get activeSessionIdentity(): { readonly sessionId: string; readonly documentGeneration: number; readonly ownerGeneration: number } | undefined {
    const current = this.current;
    if (current === undefined || current.closed || this.disposed) return undefined;
    return { sessionId: current.session.sessionId, documentGeneration: current.session.documentGeneration, ownerGeneration: current.ownerGeneration };
  }
  public async setPresentationTopology(topology: PdfPresentationTopology, page: number, transform: PdfViewTransform, guard?: PdfRequestCommitGuard): Promise<boolean> {
    return this.renderPageWithTransform(page, transform, guard, topology);
  }
  public async setOpeningPresentationAtTop(topology: PdfPresentationTopology, page: number, transform: PdfViewTransform, guard: PdfRequestCommitGuard): Promise<boolean> {
    const host = this.options.canvasHost;
    if (!guard() || host.scrollLeft !== 0 || host.scrollTop !== 0) return false;
    const openingViewportCurrent = (): boolean => guard() && host.scrollLeft === 0 && host.scrollTop === 0;
    return this.renderPageRequest(page, this.normalizeViewTransform(transform), openingViewportCurrent, topology, "opening-top");
  }

  public residentPageNumbers(): readonly number[] {
    return Object.freeze([...(this.current?.residentRasters.keys() ?? [])].sort((a, b) => a - b));
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
  private viewportCanvasBytes(viewport: PdfViewport, devicePixelRatio: number): number {
    const bytes = checkedCanvasBytes(Math.max(1, Math.ceil(Math.max(1, viewport.width) * devicePixelRatio)),
      Math.max(1, Math.ceil(Math.max(1, viewport.height) * devicePixelRatio)), 1);
    return typeof bytes === "number" ? bytes : Number.POSITIVE_INFINITY;
  }
  private availableCanvasBytes(current: Candidate, requiredBytes: number): number {
    const resources = this.options.resources;
    const ownedBytes = [...current.residentRasters.values()].reduce((total, raster) => total + raster.reservation.amount, 0);
    const available = (): number => RESOURCE_LIMITS.maxCanvasBytes - resources.snapshot().totals["canvas-bytes"] + ownedBytes;
    if (requiredBytes > available() && requiredBytes <= RESOURCE_LIMITS.maxCanvasBytes) {
      // Exercise the existing inactive-tab eviction authority for the required
      // delta only. Optional overscan never forces another tab's eviction.
      const admission = resources.reserve({ kind: "canvas-bytes", amount: requiredBytes - ownedBytes, sessionId: current.session.sessionId });
      if (admission.ok) resources.release(admission.reservation);
    }
    return available();
  }
  /** Synchronizes the bounded continuous resident window to finite host geometry. */
  public async synchronizeViewport(scrollTop: number, clientHeight: number, requestCommitGuard?: PdfRequestCommitGuard, anchorPolicy: "preserve-visible" | "caller-owned" = "preserve-visible"): Promise<boolean> {
    if (!Number.isFinite(scrollTop) || !Number.isFinite(clientHeight) || clientHeight < 0) return false;
    const host = this.options.canvasHost;
    const position = () => ({ left: host.scrollLeft, top: host.scrollTop,
      maxLeft: Math.max(0, host.scrollWidth - host.clientWidth), maxTop: Math.max(0, host.scrollHeight - host.clientHeight) });
    let ownedPosition = position();
    const positionCurrent = (): boolean => host.scrollLeft === ownedPosition.left && host.scrollTop === ownedPosition.top;
    const acceptOwnedLayoutClamp = (): boolean => {
      const now = position();
      const ownedAxis = (old: number, oldMax: number, value: number, max: number): boolean =>
        value === old || (max < oldMax && old > max && value === max);
      if (!ownedAxis(ownedPosition.left, ownedPosition.maxLeft, now.left, now.maxLeft)
        || !ownedAxis(ownedPosition.top, ownedPosition.maxTop, now.top, now.maxTop)) return false;
      ownedPosition = now;
      return true;
    };
    const requestSequence = ++this.presentationRequestSequence;
    await this.awaitViewportIdle();
    if (requestSequence !== this.presentationRequestSequence || !(requestCommitGuard?.() ?? true)) return false;
    const current = this.current;
    if (current === undefined || current.document === undefined || this.disposed || current.topology !== "continuous") return false;
    const window = current.window;
    if (window === undefined) return false;
    const range = window.visibleRangeForViewport(scrollTop, clientHeight);
    if (range.firstVisiblePage === undefined || range.lastVisiblePage === undefined) return false;
    const requestedVisiblePages = Object.freeze(Array.from(
      { length: range.lastVisiblePage - range.firstVisiblePage + 1 },
      (_unused, index) => range.firstVisiblePage! + index,
    ));

    const planningCurrent = (): boolean => requestSequence === this.presentationRequestSequence
      && this.current === current && !this.disposed && positionCurrent() && (requestCommitGuard?.() ?? true);
    const preparedPages = new Map<number, PreparedPdfPage>();
    const pageBytes = new Map<number, number>();
    try {
      for (const pageNumber of window.previewPlan(range.firstVisiblePage, range.lastVisiblePage).plannedPages) {
        const page = current.residentRasters.get(pageNumber)?.page ?? await this.getOwnedPage(current, pageNumber);
        if (!planningCurrent()) return false;
        const viewport = current.residentRasters.get(pageNumber)?.viewport
          ?? page.getViewport({ scale: this.viewTransform.scale, rotation: this.viewTransform.rotation });
        preparedPages.set(pageNumber, { page, viewport });
        pageBytes.set(pageNumber, this.viewportCanvasBytes(viewport, this.viewTransform.devicePixelRatio));
      }
    } catch (error) {
      if (planningCurrent()) this.options.onStatus(safeMessage(error));
      return false;
    }
    let overscanPages = 2;
    const requiredBytes = (overscan: number): number => window.previewPlan(range.firstVisiblePage!, range.lastVisiblePage!, overscan)
      .plannedPages.reduce((total, page) => total + pageBytes.get(page)!, 0);
    const availableBytes = this.availableCanvasBytes(current, requiredBytes(0));
    if (!planningCurrent()) return false;
    while (overscanPages > 0 && requiredBytes(overscanPages) > availableBytes) overscanPages -= 1;
    if (requiredBytes(overscanPages) > availableBytes) {
      this.options.onStatus(safeMessage(new Error("CANVAS_LIMIT")));
      return false;
    }
    const hostScrollTopAtStart = this.options.canvasHost.scrollTop;
    const hostClientHeightAtStart = host.clientHeight;
    const checkpoint = window.checkpoint();
    const originalResidents = new Set(checkpoint.residentPages);
    const priorActivePage = current.activePageNumber;
    const plan = window.plan(range.firstVisiblePage, range.lastVisiblePage, overscanPages);
    const activateViewportCenter = (viewportTop: number): number => {
      const center = window.pageNearestViewportCenter(
        plan.plannedPages.map((pageNumber) => {
          const geometry = window.pageGeometry(pageNumber);
          return { pageNumber, top: geometry.top, bottom: geometry.top + geometry.height };
        }),
        viewportTop + clientHeight / 2,
      ) ?? range.firstVisiblePage!;
      current.activePageNumber = center;
      for (const frame of this.options.canvasHost.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")) {
        frame.dataset.activePage = String(Number(frame.dataset.page) === center);
      }
      return center;
    };
    if (plan.materializePages.length === 0 && plan.evictPages.length === 0) {
      current.visiblePageNumbers = requestedVisiblePages;
      const center = activateViewportCenter(scrollTop);
      if (center !== priorActivePage) this.notifyObserver(() => this.options.onPage(center, this.viewTransform));
      return true;
    }

    const epoch = ++this.viewportEpoch;
    let releaseSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    this.viewportSettlement = settlement;
    const transactionCurrent = (): boolean => this.viewportEpoch === epoch
      && this.current === current
      && !this.disposed
      && positionCurrent() && (requestCommitGuard?.() ?? true);
    const stagedMetrics: { readonly pageNumber: number; readonly metric: { readonly width: number; readonly height: number } }[] = [];
    this.activeViewportPlan = { candidate: current, plan, publishLayout: (pageNumber, raster, anchor, publish) => {
      if (!transactionCurrent()) return false;
      stagedMetrics.push({ pageNumber, metric: { width: raster.viewport.width, height: raster.viewport.height } });
      const projected = window.projectMetrics(stagedMetrics);
      publish();
      this.applyWindowSpacers(current, plan, projected);
      if (!acceptOwnedLayoutClamp()) return false;
      if (anchorPolicy === "preserve-visible" && anchor !== undefined && this.restoreScrollAnchor(anchor) === undefined) return false;
      ownedPosition = position();
      return transactionCurrent();
    } };
    let succeeded = false;
    let residentAuthority: PdfResidentAuthorityTransaction | void = undefined;
    let rollbackAuthorityError: unknown;
    try {
      for (const page of plan.materializePages) {
        if (!transactionCurrent()) return false;
        while (!current.residentRasters.has(page) && (current.residentRasters.size >= plan.plannedPages.length
          || this.options.resources.snapshot().totals["canvas-bytes"] + pageBytes.get(page)! > RESOURCE_LIMITS.maxCanvasBytes)) {
          const obsolete = plan.evictPages.find((candidate) => current.residentRasters.has(candidate) && candidate !== priorActivePage)
            ?? plan.evictPages.find((candidate) => current.residentRasters.has(candidate));
          if (obsolete === undefined) throw new Error("PDF_RESIDENT_TRANSITION_CAPACITY");
          this.evictResidentPage(current, obsolete, true);
        }
        window.begin(page, plan.generation);
        const committed = await this.renderPageInternal(page, this.viewTransform, transactionCurrent, undefined, current.topology, "preserve-anchor", preparedPages.get(page));
        if (!committed) {
          if (transactionCurrent()) this.options.onStatus(`PDF viewport page ${page} could not be materialized.`);
          return false;
        }
        if (!transactionCurrent()) return false;
      }
      residentAuthority = await this.options.onBeforeResidentCommit?.(plan.plannedPages);
      if (!transactionCurrent()) return false;
      for (const page of plan.evictPages) this.evictResidentPage(current, page);
      if (!transactionCurrent()) return false;
      const finalAnchor = anchorPolicy === "preserve-visible" ? this.captureVisibleScrollAnchor() : undefined;
      window.updateMetrics(stagedMetrics);
      this.prunePageFrames(plan.plannedPages);
      const finalPlan = window.plan(range.firstVisiblePage, range.lastVisiblePage, overscanPages);
      this.applyWindowSpacers(current, finalPlan);
      if (!acceptOwnedLayoutClamp()) return false;
      if (finalAnchor !== undefined && this.restoreScrollAnchor(finalAnchor) === undefined) return false;
      ownedPosition = position();
      const finalRange = window.visibleRangeForViewport(scrollTop + host.scrollTop - hostScrollTopAtStart,
        Math.max(0, clientHeight + host.clientHeight - hostClientHeightAtStart));
      if (finalRange.firstVisiblePage === undefined || finalRange.lastVisiblePage === undefined) return false;
      const finalVisiblePages = Array.from({ length: finalRange.lastVisiblePage - finalRange.firstVisiblePage + 1 }, (_, index) => finalRange.firstVisiblePage! + index);
      if (!finalVisiblePages.every(page => current.residentRasters.has(page))) return false;
      current.visiblePageNumbers = Object.freeze(finalVisiblePages);
      const latestViewportTop = scrollTop + this.options.canvasHost.scrollTop - hostScrollTopAtStart;
      const center = activateViewportCenter(latestViewportTop);
      residentAuthority?.finalize();
      succeeded = true;
      this.notifyObserver(() => this.options.onPage(center, this.viewTransform));
      return true;
    } finally {
      for (const page of plan.materializePages) window.fail(page, plan.generation);
      if (!succeeded && this.current === current && !this.disposed) {
        const rollbackAnchor = anchorPolicy === "preserve-visible" && transactionCurrent() ? this.captureVisibleScrollAnchor() : undefined;
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
              const restoredPlan = window.restore(checkpoint, authorityResidents);
              this.prunePageFrames(authorityResidents);
              this.applyWindowSpacers(current, restoredPlan);
              if (rollbackAnchor !== undefined && acceptOwnedLayoutClamp()) {
                this.restoreScrollAnchor(rollbackAnchor);
                ownedPosition = position();
              }
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

  /** Captures the PDF point under a host-local pointer, clamping to the nearest page edge. */
  public capturePointerAnchor(viewportOffset: PdfViewportOffset): PdfScrollAnchor | undefined {
    return this.captureResidentAnchor(viewportOffset, false);
  }

  private captureVisibleScrollAnchor(): PdfScrollAnchor | undefined {
    const host = this.options.canvasHost;
    return this.captureResidentAnchor({ x: host.clientWidth / 2, y: host.clientHeight / 2 }, true);
  }

  private captureResidentAnchor(viewportOffset: PdfViewportOffset, visibleOnly: boolean): PdfScrollAnchor | undefined {
    const current = this.current;
    const host = this.options.canvasHost;
    if (current === undefined || this.disposed || !Number.isFinite(viewportOffset.x) || !Number.isFinite(viewportOffset.y)) return undefined;
    const point = { x: host.scrollLeft + viewportOffset.x, y: host.scrollTop + viewportOffset.y };
    let selected: { pageNumber: number; raster: RenderedCanvas; left: number; top: number; x: number; y: number; distance: number } | undefined;
    // The caller materializes the current bounded viewport first. Never scan the whole document's DOM.
    for (const [pageNumber, raster] of current.residentRasters) {
      const frame = host.querySelector<HTMLElement>(`:scope > .pdf-page-frame[data-page='${pageNumber}']`);
      if (frame === null) continue;
      const left = frame.offsetLeft + raster.canvas.offsetLeft;
      const top = frame.offsetTop + raster.canvas.offsetTop;
      if (visibleOnly && (left + raster.viewport.width <= host.scrollLeft || left >= host.scrollLeft + host.clientWidth
        || top + raster.viewport.height <= host.scrollTop || top >= host.scrollTop + host.clientHeight)) continue;
      const x = Math.max(left, Math.min(left + raster.viewport.width, point.x));
      const y = Math.max(top, Math.min(top + raster.viewport.height, point.y));
      const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (selected === undefined || distance < selected.distance || (distance === selected.distance && pageNumber < selected.pageNumber)) {
        selected = { pageNumber, raster, left, top, x, y, distance };
      }
    }
    if (selected === undefined) return undefined;
    return capturePdfViewportAnchor({
      pageNumber: selected.pageNumber, viewport: selected.raster.viewport,
      pageFrameOffset: { x: selected.left, y: selected.top },
      host: { scrollLeft: host.scrollLeft, scrollTop: host.scrollTop, clientWidth: host.clientWidth, clientHeight: host.clientHeight },
      viewportOffset: { x: selected.x - host.scrollLeft, y: selected.y - host.scrollTop },
    });
  }

  /** Changes the CSS transform while preserving a pointer/nearest-edge PDF anchor. */
  public async setViewTransformAtPointer(
    transform: PdfViewTransform,
    viewportOffset: PdfViewportOffset,
    requestCommitGuard?: PdfRequestCommitGuard,
  ): Promise<boolean> {
    const owner = this.current;
    const guard = (): boolean => owner !== undefined && this.current === owner && !this.disposed && (requestCommitGuard?.() ?? true);
    if (!guard()) return false;
    // A resident pointer point remains usable even if the old high-scale window
    // cannot materialize its neighbours. Do not make zoom-out depend on that work.
    await this.awaitViewportIdle();
    if (!guard()) return false;
    const residentAnchor = this.capturePointerAnchor(viewportOffset);
    let anchor = this.presentationTopology === "single-page"
      || (residentAnchor !== undefined && residentAnchor.viewportOffset.x === viewportOffset.x
        && residentAnchor.viewportOffset.y === viewportOffset.y)
      ? residentAnchor : undefined;
    for (let attempt = 0; anchor === undefined && attempt < 4 && guard(); attempt += 1) {
      const geometry = this.contentViewportGeometry();
      if (!await this.synchronizeViewport(geometry.scrollTop, geometry.clientHeight, guard)) continue;
      anchor = this.capturePointerAnchor(viewportOffset);
      if (anchor !== undefined) break;
    }
    if (anchor === undefined || !guard()) return false;
    const priorTopology = this.presentationTopology;
    const priorTransform = this.viewTransform;
    const priorAnchor = this.captureScrollAnchor();
    if (priorAnchor === undefined) return false;
    let failure: unknown;
    try {
      const committed = await this.renderPageWithTransform(anchor.pageNumber, transform, guard, "continuous", anchor);
      if (committed && await this.settlePointerAnchor(anchor, guard)) return true;
    } catch (error) { failure = error; }
    if (!guard()) return false;
    const restored = await this.renderPageWithTransform(priorAnchor.pageNumber, priorTransform, guard, priorTopology, priorAnchor);
    if (!guard()) return false;
    if (!restored || !await this.settlePointerAnchor(priorAnchor, guard)) {
      if (!guard()) return false;
      this.options.onStatus("PDF viewport rollback failed after wheel zoom.");
      throw new Error("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
    }
    if (failure !== undefined) throw failure;
    return false;
  }

  private async settlePointerAnchor(anchor: PdfScrollAnchor, guard: PdfRequestCommitGuard): Promise<boolean> {
    const target: PdfViewportLanding = { pageIndex: anchor.pageNumber - 1, x: anchor.pagePoint.x, y: anchor.pagePoint.y };
    // Scroll offsets and frame origins are CSS-pixel rounded; navigation keeps its separate PDF-point tolerance.
    const matches = (expected: PdfViewportLanding, actual: PdfViewportLanding): boolean => expected.pageIndex === actual.pageIndex
      && Math.abs(expected.x - actual.x) * this.viewTransform.scale <= 1 + 1e-9
      && Math.abs(expected.y - actual.y) * this.viewTransform.scale <= 1 + 1e-9;
    for (let attempt = 0; attempt < 4 && guard(); attempt += 1) {
      this.restoreScrollAnchor(anchor);
      const geometry = this.contentViewportGeometry();
      if (this.current?.topology === "continuous"
        && !await this.synchronizeViewport(geometry.scrollTop, geometry.clientHeight, guard)) continue;
      if (!guard()) return false;
      this.restoreScrollAnchor(anchor);
      const landing = this.captureViewportLandingAtOffset(anchor.pageNumber, anchor.viewportOffset);
      const reachable = this.resolveReachableViewportLanding(anchor);
      if (landing !== undefined && this.current !== undefined && this.publishFinalViewportIfMaterialized(this.current)
        && (matches(target, landing) || (reachable !== undefined && matches(reachable, landing)))) return true;
    }
    return false;
  }
  public restoreScrollAnchor(anchor: PdfScrollAnchor): { readonly scrollLeft: number; readonly scrollTop: number; readonly landing: PdfViewportLanding } | undefined {
    const owner = this.current;
    const raster = owner?.residentRasters.get(anchor.pageNumber);
    const frame = this.options.canvasHost.querySelector<HTMLElement>(`:scope > .pdf-page-frame[data-page='${anchor.pageNumber}']`);
    if (raster === undefined || frame === null) return;
    const host = this.options.canvasHost;
    const pageFrameOffset = { x: frame.offsetLeft + raster.canvas.offsetLeft, y: frame.offsetTop + raster.canvas.offsetTop };
    const geometry = {
      scrollLeft: host.scrollLeft, scrollTop: host.scrollTop,
      clientWidth: host.clientWidth, clientHeight: host.clientHeight,
      scrollWidth: Math.max(host.clientWidth, host.scrollWidth),
      scrollHeight: Math.max(host.clientHeight, host.scrollHeight),
    };
    const restored = restorePdfViewportAnchor(anchor, { viewport: raster.viewport, pageFrameOffset, host: geometry });
    host.scrollLeft = restored.scrollLeft;
    host.scrollTop = restored.scrollTop;
    const scrollLeft = host.scrollLeft;
    const scrollTop = host.scrollTop;
    // Ordinary CSSOM rounding remains limited to one physical pixel. Hidden
    // single-page overflow with a stable gutter can report a larger range than
    // the browser permits; prove that exceptional clamp synchronously at its edge.
    const browserDpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
    const quantum = 1 / (Number.isFinite(browserDpr) && browserDpr > 0 ? browserDpr : 1);
    if (Math.abs(scrollLeft - restored.scrollLeft) > quantum + 1e-6
      || Math.abs(scrollTop - restored.scrollTop) > quantum + 1e-6) {
      if (owner?.topology !== "single-page" || Math.abs(scrollTop - restored.scrollTop) > quantum + 1e-6) return undefined;
      const style = getComputedStyle(host);
      if (!(style.overflow === "hidden" || (style.overflowX === "hidden" && style.overflowY === "hidden"))
        || !style.getPropertyValue("scrollbar-gutter").includes("stable")) return undefined;
      const outerWidth = host.offsetWidth;
      const paddingBoxWidth = outerWidth - (Number.parseFloat(style.borderLeftWidth) || 0) - (Number.parseFloat(style.borderRightWidth) || 0);
      if (paddingBoxWidth <= geometry.clientWidth) return undefined;
      const layoutCurrent = (): boolean => !this.disposed && this.current === owner
        && owner.residentRasters.get(anchor.pageNumber) === raster
        && frame.isConnected === host.isConnected && frame.parentElement === host
        && host.clientWidth === geometry.clientWidth && host.clientHeight === geometry.clientHeight
        && Math.max(host.clientWidth, host.scrollWidth) === geometry.scrollWidth
        && Math.max(host.clientHeight, host.scrollHeight) === geometry.scrollHeight
        && frame.offsetLeft + raster.canvas.offsetLeft === pageFrameOffset.x
        && frame.offsetTop + raster.canvas.offsetTop === pageFrameOffset.y;
      if (restored.scrollLeft < scrollLeft || scrollLeft < 0 || !layoutCurrent()) return undefined;
      host.scrollLeft = geometry.scrollWidth;
      const edge = host.scrollLeft;
      const orthogonalUnchanged = host.scrollTop === scrollTop;
      host.scrollLeft = restored.scrollLeft;
      const expectedEdge = Math.max(0, geometry.scrollWidth - paddingBoxWidth);
      if (!orthogonalUnchanged || host.scrollTop !== scrollTop || edge !== scrollLeft
        || host.scrollLeft !== scrollLeft || Math.abs(edge - expectedEdge) > quantum + 1e-6
        || host.offsetWidth !== outerWidth || !layoutCurrent()) return undefined;
    }
    const landing = this.captureViewportLandingAtOffset(anchor.pageNumber, anchor.viewportOffset);
    return landing === undefined ? undefined : { scrollLeft, scrollTop, landing };
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
  private contentViewportGeometry(): { readonly scrollTop: number; readonly clientHeight: number } {
    const host = this.options.canvasHost;
    const style = typeof getComputedStyle === "function" ? getComputedStyle(host) : undefined;
    const padding = (value: string | undefined): number => {
      const parsed = Number.parseFloat(value ?? "0");
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const paddingTop = padding(style?.paddingTop);
    return {
      scrollTop: Math.max(0, host.scrollTop - paddingTop),
      clientHeight: Math.max(0, host.clientHeight - paddingTop - padding(style?.paddingBottom)),
    };
  }

  private publishFinalViewportIfMaterialized(current: Candidate): boolean {
    if (current.topology !== "continuous") return true;
    const window = current.window;
    if (window === undefined) return false;
    const geometry = this.contentViewportGeometry();
    const range = window.visibleRangeForViewport(geometry.scrollTop, geometry.clientHeight);
    if (range.firstVisiblePage === undefined || range.lastVisiblePage === undefined) return false;
    const visiblePages = Array.from(
      { length: range.lastVisiblePage - range.firstVisiblePage + 1 },
      (_unused, index) => range.firstVisiblePage! + index,
    );
    // Overscan is optional and may have been reduced by byte admission. Verify
    // the committed plan and every visible page, not a fresh full-overscan plan.
    const plannedPages = window.checkpoint().plannedPages;
    if (!plannedPages.every(page => current.residentRasters.has(page))
      || !visiblePages.every(page => plannedPages.includes(page) && current.residentRasters.has(page))) return false;
    current.visiblePageNumbers = Object.freeze(visiblePages);
    return true;
  }
  /** Restores a canonical landing and materializes its final bounded viewport before verification. */
  public async restoreViewportLanding(
    target: PdfViewportLanding,
    requestCommitGuard?: PdfRequestCommitGuard,
    targetTransform: PdfViewTransform = this.viewTransform,
    placement: "center" | "page-top" = "center",
    onViewportOwnershipLost?: () => void,
  ): Promise<PdfViewportRestoreOutcome> {
    const current = this.current;
    if (current === undefined || current.document === undefined || this.disposed
      || !Number.isSafeInteger(target.pageIndex) || target.pageIndex < 0
      || target.pageIndex >= current.document.numPages || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
      return { kind: "preflightRejected" };
    }
    if (!(requestCommitGuard?.() ?? true)) return { kind: "staleOrCancelled" };
    let ownedScrollLeft = this.options.canvasHost.scrollLeft;
    let ownedScrollTop = this.options.canvasHost.scrollTop;
    const requestCurrent = (): boolean => this.current === current && !this.disposed && (requestCommitGuard?.() ?? true);
    const prePlacementPositionCurrent = (): boolean => this.options.canvasHost.scrollLeft === ownedScrollLeft
      && this.options.canvasHost.scrollTop === ownedScrollTop;
    const prePlacementGuard = (): boolean => requestCurrent() && prePlacementPositionCurrent();
    try {
      await this.getOwnedPage(current, target.pageIndex + 1);
    } catch {
      if (!requestCurrent()) return { kind: "staleOrCancelled" };
      if (!prePlacementPositionCurrent()) {
        onViewportOwnershipLost?.();
        return { kind: "staleOrCancelled" };
      }
      return { kind: "preflightRejected" };
    }
    await this.awaitViewportIdle();
    if (!requestCurrent()) return { kind: "staleOrCancelled" };
    if (!prePlacementPositionCurrent()) {
      onViewportOwnershipLost?.();
      return { kind: "staleOrCancelled" };
    }
    const pageNumber = target.pageIndex + 1;
    try {
      const transformUnchanged = targetTransform.scale === this.viewTransform.scale
        && targetTransform.rotation === this.viewTransform.rotation
        && targetTransform.devicePixelRatio === this.viewTransform.devicePixelRatio;
      let committed = true;
      const synchronizeTargetWindow = async (offset: number): Promise<boolean> => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (await this.synchronizeViewport(offset, this.contentViewportGeometry().clientHeight, prePlacementGuard, "caller-owned")) return true;
          if (!prePlacementGuard()) return false;
          await this.awaitViewportIdle();
        }
        return false;
      };
      if (!(transformUnchanged && current.residentRasters.has(pageNumber))) {
        const targetOffset = current.window?.offsetForPage(pageNumber);
        if (transformUnchanged && targetOffset !== undefined) {
          committed = await synchronizeTargetWindow(targetOffset);
        } else {
          committed = await this.renderPage(pageNumber, targetTransform, prePlacementGuard);
          if (committed && requestCurrent()) {
            ownedScrollLeft = this.options.canvasHost.scrollLeft;
            ownedScrollTop = this.options.canvasHost.scrollTop;
          }
          const transformedOffset = current.window?.offsetForPage(pageNumber);
          if (committed && transformedOffset !== undefined) {
            committed = await synchronizeTargetWindow(transformedOffset);
          }
        }
      }
      if (!committed) {
        if (!requestCurrent()) return { kind: "staleOrCancelled" };
        if (!prePlacementPositionCurrent()) {
          onViewportOwnershipLost?.();
          return { kind: "staleOrCancelled" };
        }
        return { kind: "failed" };
      }
      if (!requestCurrent()) return { kind: "staleOrCancelled" };
      if (!prePlacementPositionCurrent()) {
        onViewportOwnershipLost?.();
        return { kind: "staleOrCancelled" };
      }
      const anchor: PdfViewportAnchor = Object.freeze({
        pageNumber,
        pagePoint: Object.freeze({ x: target.x, y: target.y }),
        viewportOffset: Object.freeze({
          x: this.options.canvasHost.clientWidth / 2,
          y: placement === "page-top" ? 0 : this.options.canvasHost.clientHeight / 2,
        }),
      });
      let appliedAnchor: ReturnType<PdfReaderController["restoreScrollAnchor"]>;
      const restoreOwnedAnchor = async (): Promise<boolean> => {
        if (this.current !== current || this.disposed || !(requestCommitGuard?.() ?? true)) return false;
        appliedAnchor = this.restoreScrollAnchor(anchor);
        await Promise.resolve();
        if (appliedAnchor !== undefined && (this.options.canvasHost.scrollLeft !== appliedAnchor.scrollLeft
          || this.options.canvasHost.scrollTop !== appliedAnchor.scrollTop)) {
          onViewportOwnershipLost?.();
          return false;
        }
        return this.current === current && !this.disposed && (requestCommitGuard?.() ?? true);
      };
      if (!await restoreOwnedAnchor()) return { kind: "staleOrCancelled" };
      let viewportMaterialized = this.publishFinalViewportIfMaterialized(current);
      for (let attempt = 0; attempt < 4 && !viewportMaterialized; attempt += 1) {
        const geometry = this.contentViewportGeometry();
        const host = this.options.canvasHost;
        const viewportPosition = () => {
          const scrollLeft = host.scrollLeft;
          const scrollTop = host.scrollTop;
          return {
            scrollLeft,
            scrollTop,
            maxScrollLeft: Math.max(0, host.scrollWidth - host.clientWidth),
            maxScrollTop: Math.max(0, host.scrollHeight - host.clientHeight),
          };
        };
        let ownedViewportPosition = viewportPosition();
        const viewportPositionCurrent = (): boolean => {
          const position = viewportPosition();
          return position.scrollLeft === ownedViewportPosition.scrollLeft
            && position.scrollTop === ownedViewportPosition.scrollTop;
        };
        // Measuring a shorter page can shrink the owned extent and synchronously clamp an edge position.
        const acceptOwnedLayoutClamp = (): boolean => {
          const position = viewportPosition();
          if (position.scrollLeft === ownedViewportPosition.scrollLeft
            && position.scrollTop === ownedViewportPosition.scrollTop) return true;
          const axisOwned = (ownedScroll: number, ownedMax: number, scroll: number, max: number): boolean =>
            scroll === ownedScroll || (max < ownedMax && ownedScroll > max && scroll === max);
          if (!axisOwned(ownedViewportPosition.scrollLeft, ownedViewportPosition.maxScrollLeft,
            position.scrollLeft, position.maxScrollLeft)
            || !axisOwned(ownedViewportPosition.scrollTop, ownedViewportPosition.maxScrollTop,
              position.scrollTop, position.maxScrollTop)) return false;
          ownedViewportPosition = position;
          return true;
        };
        const materializationGuard = (): boolean => (requestCommitGuard?.() ?? true) && acceptOwnedLayoutClamp();
        let synchronized: boolean;
        try {
          synchronized = await this.synchronizeViewport(geometry.scrollTop, geometry.clientHeight, materializationGuard, "caller-owned");
        } catch (error) {
          if (requestCurrent() && !acceptOwnedLayoutClamp()) onViewportOwnershipLost?.();
          throw error;
        }
        if (!requestCurrent()) return { kind: "staleOrCancelled" };
        if (!acceptOwnedLayoutClamp()) {
          onViewportOwnershipLost?.();
          return { kind: "staleOrCancelled" };
        }
        if (!synchronized) {
          await this.awaitViewportIdle();
          if (!requestCurrent()) return { kind: "staleOrCancelled" };
          if (!viewportPositionCurrent()) {
            onViewportOwnershipLost?.();
            return { kind: "staleOrCancelled" };
          }
          continue;
        }
        if (!await restoreOwnedAnchor()) return { kind: "staleOrCancelled" };
        viewportMaterialized = this.publishFinalViewportIfMaterialized(current);
      }
      if (!viewportMaterialized) return { kind: "failed" };
      const expected = appliedAnchor?.landing;
      if (expected === undefined) return { kind: "failed" };
      const landing = this.captureViewportLandingAtOffset(pageNumber, anchor.viewportOffset);
      if (landing === undefined) return { kind: "failed" };
      const exact = samePdfViewportLanding(target, landing);
      if (!exact && !samePdfViewportLanding(expected, landing)) return { kind: "failed", landing };
      current.activePageNumber = pageNumber;
      for (const frame of this.options.canvasHost.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")) {
        frame.dataset.activePage = String(Number(frame.dataset.page) === pageNumber);
      }
      this.notifyObserver(() => this.options.onPage(pageNumber, this.viewTransform));
      return exact ? { kind: "verified", landing } : { kind: "constrainedEdgeVerified", landing, expected };
    } catch (error) {
      this.options.onStatus(`PDF viewport landing failed: ${error instanceof Error ? error.message : String(error)}`);
      return !(requestCommitGuard?.() ?? true) ? { kind: "staleOrCancelled" } : { kind: "failed" };
    }
  }

  private async renderPageInternal(page: number, transform = this.viewTransform, requestCommitGuard?: PdfRequestCommitGuard, preEvictionAnchor?: PdfScrollAnchor, topology: PdfPresentationTopology = this.current?.topology ?? "continuous", viewportPolicy: PdfRenderViewportPolicy = "preserve-anchor", prepared?: PreparedPdfPage): Promise<boolean> {
    const current = this.current;
    if (current === undefined || current.document === undefined || this.disposed) return false;
    const cssTransformChanged = transform.scale !== this.viewTransform.scale || transform.rotation !== this.viewTransform.rotation;
    const topologyChanged = topology !== current.topology;
    const presentationChanged = cssTransformChanged || topologyChanged;
    const retainedAnchor = this.evictedScrollAnchor?.pageNumber === page ? this.evictedScrollAnchor.anchor : undefined;
    const anchor = viewportPolicy === "preserve-anchor"
      ? preEvictionAnchor ?? retainedAnchor ?? (this.activeViewportPlan === undefined && (presentationChanged || current.activePageNumber === page) ? this.captureScrollAnchor() : undefined)
      : undefined;
    const activePlan = !presentationChanged && this.activeViewportPlan?.candidate === current ? this.activeViewportPlan.plan : undefined;
    const priorActivePage = current.activePageNumber;
    const directPreview = !presentationChanged && activePlan === undefined ? current.window?.previewPlan(page) : undefined;
    let directPlan: PageWindowPlan | undefined;
    try {
      const rendered = await this.renderCandidatePage(current, page, transform, prepared);
      const commitSequence = this.renderSequence;
      if (this.current !== current || this.disposed || (requestCommitGuard !== undefined && !requestCommitGuard())) { this.releaseRaster(rendered); return false; }
      const retainedPages = presentationChanged
        ? Object.freeze([page])
        : Object.freeze([...new Set([
          ...[...current.residentRasters.keys()].filter((resident) => !(directPreview ?? activePlan)?.evictPages.includes(resident)),
          page,
        ])].sort((a, b) => a - b));
      let committed = false;
      let layoutFailed = false;
      const commitCanvas = (accessory?: HTMLElement): boolean => {
        if (committed || commitSequence !== this.renderSequence || this.current !== current || this.disposed || (requestCommitGuard !== undefined && !requestCommitGuard())) return false;
        const prior = current.residentRasters.get(page);
        const publishLayout = activePlan === undefined ? undefined : this.activeViewportPlan?.publishLayout;
        const visibleAnchor = publishLayout === undefined ? undefined : this.captureVisibleScrollAnchor();
        let plan = activePlan;
        if (!cssTransformChanged && directPreview !== undefined) {
          directPlan = current.window?.plan(page);
          plan = directPlan;
          if (directPlan?.materializePages.includes(page)) current.window?.begin(page, directPlan.generation);
        }
        if (presentationChanged || topology === "single-page" || current.window === undefined) {
          const nextWindow = new ContinuousPageWindow({
            estimatedPageWidth: rendered.viewport.width,
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
          if (topology === "continuous") current.window = nextWindow; else delete current.window;
          current.topology = topology;
          if (topology === "single-page") { current.topSpacer?.remove(); current.bottomSpacer?.remove(); delete current.topSpacer; delete current.bottomSpacer; this.options.canvasHost.classList.add("pdf-reader-single-page"); } else this.options.canvasHost.classList.remove("pdf-reader-single-page");
        } else if (plan !== undefined) {
          if (activePlan === undefined) for (const evicted of plan.evictPages) current.window?.unpublish(evicted);
          if (publishLayout === undefined) current.window?.updateMetric(page, { width: rendered.viewport.width, height: rendered.viewport.height });
          if (plan.materializePages.includes(page)) {
            try { current.window?.publish(page, plan.generation); } catch { return false; }
          }
          if (activePlan === undefined) for (const evicted of plan.evictPages) this.evictResidentPage(current, evicted);
        }
        current.residentRasters.set(page, rendered);
        if (activePlan === undefined) current.activePageNumber = preEvictionAnchor !== undefined && priorActivePage !== undefined ? priorActivePage : page;
        if (this.activeViewportPlan === undefined) current.visiblePageNumbers = Object.freeze([page]);
        this.viewTransform = transform;
        if (prior !== undefined) this.releaseRaster(prior);
        const publish = (): void => { this.canvasReplace(rendered.canvas, accessory, undefined, false, activePlan === undefined); };
        if (publishLayout !== undefined) {
          committed = true;
          layoutFailed = !publishLayout(page, rendered, visibleAnchor, publish);
        } else publish();
        if (publishLayout === undefined && plan !== undefined && topology === "continuous") this.applyWindowSpacers(current, plan);
        if (viewportPolicy === "opening-top") {
          this.options.canvasHost.scrollLeft = 0;
          this.options.canvasHost.scrollTop = 0;
        } else {
          if (directPlan !== undefined && anchor === undefined && current.window !== undefined) {
            this.options.canvasHost.scrollTop = current.window.offsetForPage(page);
          }
          if (anchor !== undefined) this.restoreScrollAnchor(anchor);
        }
        if (retainedAnchor !== undefined) this.evictedScrollAnchor = undefined;
        committed = true;
        if (activePlan === undefined) this.notifyObserver(() => this.options.onPage(current.activePageNumber ?? page, transform));
        return !layoutFailed;
      };
      try {
      if (this.options.onBeforeCommit === undefined) commitCanvas();
      else await this.options.onBeforeCommit(rendered, commitCanvas, { document: current.document, session: current.session, ownerGeneration: current.ownerGeneration, retainedPages, opening: false });
      } catch (error) {
        if (!committed) this.releaseRaster(rendered);
        throw error;
      }
      if (!committed) { this.releaseRaster(rendered); return false; }
      return !layoutFailed;
    } catch (error) {
      if (isRenderCancellation(error)) return false;
      if (!this.disposed && this.current === current) this.options.onStatus(safeMessage(error));
      return false;
    }
    finally {
      if (directPlan?.materializePages.includes(page)) current.window?.fail(page, directPlan.generation);
    }
  }
  private async renderPageWithinSingleResidentCapacity(
    page: number, transform: PdfViewTransform, guard: PdfRequestCommitGuard,
    topology: PdfPresentationTopology, viewportPolicy: PdfRenderViewportPolicy,
    preEvictionAnchor: PdfScrollAnchor | undefined, prepared: PreparedPdfPage,
  ): Promise<boolean> {
    const current = this.current;
    if (current === undefined || current.document === undefined || current.closed || this.disposed || !guard()) return false;
    const priorTransform = this.viewTransform;
    const priorTopology = current.topology;
    const priorActivePage = current.activePageNumber;
    const priorVisiblePages = current.visiblePageNumbers;
    const priorAnchor = this.captureScrollAnchor();
    const priorPages = [...current.residentRasters.keys()];
    const replacementBytes = this.viewportCanvasBytes(prepared.viewport, transform.devicePixelRatio);
    const availableBytes = this.availableCanvasBytes(current, replacementBytes);
    if (!guard() || this.current !== current || current.closed || this.disposed) return false;
    if (replacementBytes > availableBytes) {
      this.options.onStatus(safeMessage(new Error("CANVAS_LIMIT")));
      return false;
    }
    const replacementAnchor = viewportPolicy === "preserve-anchor"
      ? preEvictionAnchor ?? (page === priorActivePage ? priorAnchor : undefined) : undefined;
    for (const resident of priorPages) this.evictResidentPage(current, resident);
    const committed = await this.renderPageInternal(page, transform, guard, replacementAnchor, topology, viewportPolicy, prepared);
    if (committed) return true;
    if (this.current !== current || current.closed || this.disposed) return false;
    this.viewportRollback = true;
    try {
      let rollbackIncomplete = false;
      for (const resident of [...current.residentRasters.keys()]) this.evictResidentPage(current, resident);
      for (const resident of priorPages) {
        if (!await this.renderPageInternal(resident, priorTransform, undefined,
          resident === priorActivePage ? priorAnchor : undefined, priorTopology, "preserve-anchor")) rollbackIncomplete = true;
      }
      const authorityResidents = [...current.residentRasters.keys()].filter(resident => priorPages.includes(resident)).sort((a, b) => a - b);
      if (priorVisiblePages === undefined) delete current.visiblePageNumbers;
      else current.visiblePageNumbers = priorVisiblePages;
      const restoredActive = priorActivePage !== undefined && current.residentRasters.has(priorActivePage) ? priorActivePage : authorityResidents[0];
      if (restoredActive === undefined) delete current.activePageNumber;
      else current.activePageNumber = restoredActive;
      for (const frame of this.options.canvasHost.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")) {
        frame.dataset.activePage = String(restoredActive !== undefined && Number(frame.dataset.page) === restoredActive);
      }
      this.viewTransform = priorTransform;
      if (this.options.onBeforeResidentCommit !== undefined) {
        try {
          const compensation = await this.options.onBeforeResidentCommit(authorityResidents);
          compensation?.finalize();
        } catch (error) {
          this.options.onStatus(`PDF direct authority restore failed: ${error instanceof Error ? error.message : String(error)}`);
          throw new Error("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
        }
      }
      if (rollbackIncomplete || authorityResidents.length !== priorPages.length || current.topology !== priorTopology || current.window !== undefined) {
        this.options.onStatus("PDF direct rollback was incomplete.");
        throw new Error("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
      }
      return false;
    } finally { this.viewportRollback = false; }
  }
  private async renderPageWithinResidentCapacity(
    page: number,
    transform: PdfViewTransform,
    guard: PdfRequestCommitGuard,
    topology: PdfPresentationTopology,
    viewportPolicy: PdfRenderViewportPolicy,
    preEvictionAnchor: PdfScrollAnchor | undefined,
    prepared: PreparedPdfPage,
  ): Promise<boolean> {
    const current = this.current;
    const window = current?.window;
    if (current === undefined || current.document === undefined || current.closed || this.disposed) return false;
    if (window === undefined) {
      return this.renderPageWithinSingleResidentCapacity(page, transform, guard, topology, viewportPolicy, preEvictionAnchor, prepared);
    }
    const checkpoint = window.checkpoint();
    const priorActivePage = current.activePageNumber;
    const priorTransform = this.viewTransform;
    const retainedPreEvictionAnchor = preEvictionAnchor ?? (page === priorActivePage ? this.captureScrollAnchor() : undefined);
    const previewEvictions = topology === current.topology && transform.scale === priorTransform.scale && transform.rotation === priorTransform.rotation
      ? window.previewPlan(page).evictPages
      : checkpoint.residentPages;
    if (!guard()) return false;
    const replacementBytes = this.viewportCanvasBytes(prepared.viewport, transform.devicePixelRatio);
    const availableBytes = this.availableCanvasBytes(current, replacementBytes);
    if (!guard() || this.current !== current || current.closed || this.disposed) return false;
    if (replacementBytes > availableBytes) {
      this.options.onStatus(safeMessage(new Error("CANVAS_LIMIT")));
      return false;
    }
    // Keep the active page until last, but release as many obsolete backings as
    // the replacement needs. A single count-based victim is not a byte budget.
    const victims = [...current.residentRasters.keys()].sort((left, right) =>
      Number(left === priorActivePage) - Number(right === priorActivePage)
      || Number(!previewEvictions.includes(left)) - Number(!previewEvictions.includes(right)));
    for (const victim of victims) {
      const countFull = current.residentRasters.size >= checkpoint.plannedPages.length;
      const bytesFull = this.options.resources.snapshot().totals["canvas-bytes"] + replacementBytes > RESOURCE_LIMITS.maxCanvasBytes;
      if (!countFull && !bytesFull) break;
      this.evictResidentPage(current, victim);
    }
    const committed = await this.renderPageInternal(page, transform, guard,
      viewportPolicy === "preserve-anchor" ? retainedPreEvictionAnchor : undefined, topology, viewportPolicy, prepared);
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
    if (current === undefined || current.document === undefined || current.closed || this.disposed) return false;
    if (window === undefined) {
      const residentPage = current.activePageNumber ?? [...current.residentRasters.keys()][0];
      const resident = residentPage === undefined ? undefined : current.residentRasters.get(residentPage);
      if (residentPage === undefined || resident === undefined || current.residentRasters.size !== 1) return false;
      return this.renderPageWithinSingleResidentCapacity(
        residentPage, transform, requestCommitGuard ?? (() => true), current.topology,
        "preserve-anchor", this.captureScrollAnchor(), { page: resident.page, viewport: resident.viewport });
    }
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
  public renderPage(page: number, transform = this.viewTransform, requestCommitGuard?: PdfRequestCommitGuard, topology: PdfPresentationTopology = this.current?.topology ?? "continuous", preEvictionAnchor?: PdfScrollAnchor): Promise<boolean> {
    return this.renderPageRequest(page, transform, requestCommitGuard, topology, "preserve-anchor", preEvictionAnchor);
  }

  private async renderPageRequest(page: number, transform: PdfViewTransform, requestCommitGuard: PdfRequestCommitGuard | undefined, topology: PdfPresentationTopology, viewportPolicy: PdfRenderViewportPolicy, preEvictionAnchor?: PdfScrollAnchor): Promise<boolean> {
    const requestSequence = ++this.presentationRequestSequence;
    await this.awaitViewportIdle();
    if (requestSequence !== this.presentationRequestSequence) return false;
    const ownerCurrent = (): boolean => requestSequence === this.presentationRequestSequence
      && (requestCommitGuard?.() ?? true);
    if (!ownerCurrent()) return false;
    const topologyChanged = topology !== this.current?.topology;
    const replacesResidentDpr = viewportPolicy === "preserve-anchor" && !topologyChanged && transform.scale === this.viewTransform.scale
      && transform.rotation === this.viewTransform.rotation
      && transform.devicePixelRatio !== this.viewTransform.devicePixelRatio
      && (this.current?.residentRasters.size ?? 0) > 1;
    let prepared: PreparedPdfPage | undefined;
    if (!replacesResidentDpr && this.current !== undefined) {
      const candidate = this.current;
      try {
        const source = await this.getOwnedPage(candidate, page);
        if (!ownerCurrent() || this.current !== candidate || this.disposed) return false;
        prepared = { page: source, viewport: source.getViewport({ scale: transform.scale, rotation: transform.rotation }) };
      } catch (error) {
        if (ownerCurrent()) this.options.onStatus(safeMessage(error));
        return false;
      }
    }
    const plannedWindowSize = this.current?.window?.checkpoint().plannedPages.length ?? 0;
    const residentCount = this.current?.residentRasters.size ?? 0;
    const replacementNeedsEviction = residentCount > 0 && prepared !== undefined
      && this.options.resources.snapshot().totals["canvas-bytes"]
        + this.viewportCanvasBytes(prepared.viewport, transform.devicePixelRatio) > RESOURCE_LIMITS.maxCanvasBytes;
    const needsBoundedReplacement = (plannedWindowSize > 0 && residentCount >= plannedWindowSize)
      || replacementNeedsEviction;
    if (!replacesResidentDpr && !needsBoundedReplacement) {
      return this.renderPageInternal(page, transform, ownerCurrent, preEvictionAnchor, topology, viewportPolicy, prepared);
    }
    let releaseSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    this.viewportSettlement = settlement;
    try {
      return replacesResidentDpr
        ? await this.rerenderResidentBackingsForDpr(transform, ownerCurrent)
        : await this.renderPageWithinResidentCapacity(page, transform, ownerCurrent, topology, viewportPolicy, preEvictionAnchor, prepared!);
    } finally {
      releaseSettlement();
      if (this.viewportSettlement === settlement) this.viewportSettlement = undefined;
    }
  }
  /** Cancels foreground rendering without releasing the owned document session or print job. */
  public async suspend(): Promise<void> {
    this.presentationRequestSequence += 1;
    await this.awaitViewportIdle();
    // A print owns its document and bounded page buffers independently of the
    // presentation tab. Switching tabs must not turn an accepted print into a
    // partial, unreadable output file.
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
    prepared?: PreparedPdfPage,
  ): Promise<RenderedCanvas> {
    return this.renderPageUnchecked(candidate, pageNumber, transform, prepared);
  }

  private async renderPageUnchecked(
    candidate: Candidate,
    pageNumber: number,
    transform: PdfViewTransform,
    prepared?: PreparedPdfPage,
  ): Promise<RenderedCanvas> {
    if (candidate.document === undefined || candidate.closed) throw new Error("Render cancelled");
    const sequence = ++this.renderSequence;
    const page = prepared?.page ?? await this.getOwnedPage(candidate, pageNumber);
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
      const viewport = prepared?.viewport ?? page.getViewport({ scale: transform.scale, rotation: transform.rotation });
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

  private insertPublishedFrame(frame: HTMLElement): void {
    const host = this.options.canvasHost;
    const pageNumber = Number(frame.dataset.page);
    const existing = host.querySelector<HTMLElement>(`:scope > .pdf-page-frame[data-page='${pageNumber}']`);
    if (existing === frame) return;
    if (existing !== null) {
      existing.replaceWith(frame);
      return;
    }
    const successor = [...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")]
      .find((candidate) => Number(candidate.dataset.page) > pageNumber);
    if (successor !== undefined) {
      host.insertBefore(frame, successor);
      return;
    }
    const bottomSpacer = host.querySelector<HTMLElement>(":scope > .pdf-page-spacer-bottom");
    if (bottomSpacer === null) host.append(frame);
    else host.insertBefore(frame, bottomSpacer);
  }

  private publishPageFrame(
    canvas: HTMLCanvasElement,
    accessory?: HTMLElement,
    replaceDocument = false,
    activate = true,
  ): HTMLElement {
    const frame = this.createPageFrame(canvas, accessory);
    if (replaceDocument) {
      this.options.canvasHost.replaceChildren();
    }
    this.insertPublishedFrame(frame);
    if (activate) {
      for (const candidate of this.options.canvasHost.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")) {
        candidate.dataset.activePage = String(candidate === frame);
      }
    }
    return frame;
  }

  private prunePageFrames(pages: readonly number[]): void {
    const retained = new Set(pages);
    for (const frame of this.options.canvasHost.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")) {
      if (!retained.has(Number(frame.dataset.page))) frame.remove();
    }
  }

  private canvasReplace(
    canvas: HTMLCanvasElement,
    accessory?: HTMLElement,
    anchor?: PdfScrollAnchor,
    replaceDocument = false,
    activate = true,
  ): void {
    this.publishPageFrame(canvas, accessory, replaceDocument, activate);
    if (anchor !== undefined) {
      this.restoreScrollAnchor(anchor);
    } else if (replaceDocument) {
      this.options.canvasHost.scrollLeft = 0;
      this.options.canvasHost.scrollTop = 0;
    }
  }

  private evictResidentPage(candidate: Candidate, page: number, preserveFrame = false): void {
    const raster = candidate.residentRasters.get(page);
    if (raster === undefined) return;
    const publishedFrame = this.options.canvasHost.querySelector<HTMLElement>(`:scope > .pdf-page-frame[data-page='${page}']`);
    candidate.residentRasters.delete(page);
    candidate.window?.unpublish(page);
    this.options.onEvictPage?.(page);
    this.releaseRaster(raster);
    if (preserveFrame && publishedFrame !== null) {
      publishedFrame.replaceChildren();
      this.insertPublishedFrame(publishedFrame);
    } else {
      publishedFrame?.remove();
    }
  }

  private applyWindowSpacers(candidate: Candidate, _plan: PageWindowPlan, projected?: PageGeometryProjection): void {
    const layout = projected ?? candidate.window;
    if (layout === undefined || candidate.topology !== "continuous") return;
    const host = this.options.canvasHost;
    const geometry = layout.documentGeometry();
    const style = typeof getComputedStyle === "function" ? getComputedStyle(host) : undefined;
    const padding = (value: string | undefined): number => Number.parseFloat(value ?? "0") || 0;
    const left = padding(style?.paddingLeft);
    const top = padding(style?.paddingTop);
    const width = Math.max(geometry.width, host.clientWidth - left - padding(style?.paddingRight));
    candidate.topSpacer ??= document.createElement("div");
    candidate.bottomSpacer ??= document.createElement("div");
    candidate.topSpacer.className = "pdf-page-spacer pdf-page-spacer-top";
    candidate.bottomSpacer.className = "pdf-page-spacer pdf-page-spacer-bottom";
    candidate.topSpacer.dataset.pageSpacer = "top";
    candidate.bottomSpacer.dataset.pageSpacer = "bottom";
    candidate.topSpacer.style.height = "0px";
    candidate.bottomSpacer.style.height = `${geometry.height}px`;
    candidate.bottomSpacer.style.width = `${width}px`;
    if (candidate.topSpacer.parentElement !== host) host.prepend(candidate.topSpacer);
    if (candidate.bottomSpacer.parentElement !== host) host.append(candidate.bottomSpacer);
    for (const frame of host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")) {
      const page = layout.pageGeometry(Number(frame.dataset.page));
      frame.style.position = "absolute";
      frame.style.top = `${top + page.top}px`;
      frame.style.left = `${left + Math.max(0, (width - page.width) / 2)}px`;
      frame.style.margin = "0";
    }
  }
  private usableContentSize(): { readonly width: number; readonly height: number } | undefined {
    const supplied = this.options.availableContentSize?.();
    if (supplied !== undefined && Number.isFinite(supplied.width) && supplied.width > 0) return supplied;
    const host = this.options.canvasHost;
    const style = typeof getComputedStyle === "function" ? getComputedStyle(host) : undefined;
    const padding = (value: string | undefined): number => {
      const parsed = Number.parseFloat(value ?? "0");
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const width = host.clientWidth - padding(style?.paddingLeft) - padding(style?.paddingRight);
    const height = host.clientHeight - padding(style?.paddingTop) - padding(style?.paddingBottom);
    return Number.isFinite(width) && width > 0 ? { width, height: Math.max(0, height) } : undefined;
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
    this.rejectOpening(candidate, new Error(candidate.passwordChallengeActive ? "PASSWORD_CANCELLED" : "Opening PDF cancelled"));
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
    const pdfDestroyed = await this.awaitPhase(candidate, "pdfDestroyPhase", () => Promise.resolve().then(() => candidate.task.destroy()));
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
