import { NavigationHistory, sameSnapshotWithinTolerance, type NavigationCause, type NavigationSnapshot, type NavigationTransaction } from "../domain/navigation/NavigationHistory";
import { ReaderState, type ReaderSnapshot } from "../core/ReaderState";
import {
  consumeWheelZoom,
  createWheelZoomState,
  resetWheelZoomState,
  type WheelZoomInput,
  type WheelZoomState,
} from "../platform/readerInput";
import {
  PdfContentController,
  normalizePdfSearchQuery,
  type PdfContentControllerOptions,
  type PdfDestinationNavigationOutcome,
  type PdfLinkActivationCause,
  type PdfSearchLandingRequest,
  type PdfContentSnapshot,
} from "./PdfContentController";
import { resolvePdfDestinationView } from "./PdfDestination";
import {
  PdfReaderController,
  type OpenPdfResult,
  type PdfBoundary,
  type PdfReaderControllerOptions,
  type PdfViewTransform,
  type PdfViewportOffset,
  type PdfPresentationTopology,
  type PdfViewportRestoreOutcome,
  type ReaderNativeBoundary,
} from "./PdfReaderController";
import { ResourceReservationManager } from "./ResourceBudget";
import type { PdfPrintProgress } from "./PdfPrintService";

export interface PdfTabSnapshot {
  readonly title: string;
  readonly status: string;
  readonly active: boolean;
  readonly closed: boolean;
  readonly reader: ReaderSnapshot;
  readonly content: PdfContentSnapshot;
}

export interface PdfTabSessionOptions {
  readonly printNative?: PdfReaderControllerOptions["printNative"];
  readonly onPrintProgress?: (progress: PdfPrintProgress | undefined) => void;
  readonly native: ReaderNativeBoundary;
  readonly pdf: PdfBoundary;
  readonly resources: ResourceReservationManager;
  readonly canvasHost: HTMLElement;
  readonly createContentOptions: (
    session: Pick<OpenPdfResult, "sessionId" | "documentGeneration">,
    ownerGeneration: number,
    reader: ReaderState,
  ) => Omit<PdfContentControllerOptions, "host" | "resources" | "onStatus" | "onSearchCleared">;
  readonly onStatus?: (status: string) => void;
}
export type PdfTabNavigationDecision = { readonly kind: "verifiedLanding" | "preflightRejected" | "compensatedFailure" | "uncompensatedInvariantFailure" | "unavailable" | "noOp" | "stale" | "failed-verification" | "excluded" | "search-epoch-recorded" | "invalid" | "rolled-back" };

export type PdfTabSearchDecision =
  | { readonly kind: "ignore" }
  | { readonly kind: "cycle"; readonly reverse: boolean }
  | { readonly kind: "search"; readonly query: string };

interface NavigationOwner {
  readonly intent: number;
  readonly guard: () => boolean;
}

const isAuthorityIncomplete = (error: unknown): boolean => error instanceof Error && error.message === "PDF_RESIDENT_AUTHORITY_INCOMPLETE";
export async function publishActivateAndAdoptPdfTab<T>(
  publish: () => void,
  session: { activate: () => Promise<void> },
  adopt: () => Promise<T>,
): Promise<T> {
  publish();
  await session.activate();
  return adopt();
}

export class PdfTabSession {
  public readonly reader = new ReaderState();
  private readonly pdfReader: PdfReaderController;
  private content: PdfContentController | undefined;
  private readonly contentBySession = new Map<string, PdfContentController>();
  private title = "No document open";
  private readonly contentDisposeSettlements = new Map<string, Promise<void>>();
  private active = false;
  private closed = false;
  private closeSettlement: Promise<void> | undefined;
  private foregroundSuspended = false;
  private presentationEvicted = false;
  private presentationDirty = false;
  private activityQuarantined = false;
  private activitySettling = false;
  private activitySettlement?: Promise<void>;
  private activationGeneration?: number;
  private openingFitRenderPending = false;
  private readonly navigationHistory = new NavigationHistory();
  private pageStepActive = false;
  private pendingPageStep: {
    readonly direction: -1 | 1;
    readonly generation: number;
    readonly resolve: (result: PdfTabNavigationDecision) => void;
    readonly reject: (error: unknown) => void;
  } | undefined;
  private searchLandingEpoch = 0;
  private pageStepGeneration = 0;
  private searchLandingEpochActive = false;
  private searchLandingEpochOrigin: NavigationSnapshot | undefined;
  private historyHealthy = true;
  private searchLandingOwnerRevision = 0;
  private searchLandingGeneration = -1;
  private searchLandingSelection = -1;
  private openingFitRenderInFlight = false;
  private openingFitRenderRevision = 0;
  private openingFitRenderIntent: number | undefined;
  private openingFitRenderSettlement: Promise<boolean> | undefined;
  private wheelTargetScale: number | undefined;
  private wheelAnchor: PdfViewportOffset | undefined;
  private wheelSettlement: Promise<boolean> | undefined;
  private wheelRevision = 0;
  private wheelResolve: ((result: boolean) => void) | undefined;
  private wheelReject: ((error: unknown) => void) | undefined;
  private wheelInputState: WheelZoomState = createWheelZoomState();
  private wheelOperationGeneration = 0;
  private activityGeneration = 0;
  private renderIntent = 0;
  private pendingPresentationRenders = 0;
  private readerStatusVersion = 0;
  private navigationIntent = 0;
  private viewportGeometryRevision = 0;
  private navigationLandingIntent: number | undefined;
  private viewportIntent = 0;
  private cancelledNavigation: { readonly ownerIntent: number; readonly fenceIntent: number; readonly activityGeneration: number } | undefined;
  private pendingRenderRollback: {
    readonly intent: number;
    readonly activityGeneration: number;
    readonly documentGeneration: number;
    readonly page: number;
    readonly fitPageReference: number | undefined;
    readonly zoomMode: ReaderSnapshot["zoomMode"];
    readonly customScale: number;
    readonly rotationQuarterTurns: number;
  } | undefined;
  private lastCommittedRender: {
    readonly documentGeneration: number;
    readonly page: number;
    readonly fitPageReference: number | undefined;
    readonly zoomMode: ReaderSnapshot["zoomMode"];
    readonly customScale: number;
    readonly rotationQuarterTurns: number;
    readonly devicePixelRatio: number;
    readonly contentWidth: number;
    readonly contentHeight: number;
  } | undefined;

  public constructor(private readonly options: PdfTabSessionOptions) {
    this.pdfReader = new PdfReaderController({
      native: options.native,
      ...(options.printNative === undefined ? {} : { printNative: options.printNative }),
      ...(options.onPrintProgress === undefined ? {} : { onPrintProgress: options.onPrintProgress }),
      pdf: options.pdf,
      resources: options.resources,
      canvasHost: options.canvasHost,
      availableContentSize: () => this.availableContentSize(),
      onStatus: (status) => this.setReaderStatus(status),
      onPage: (page, transform) => this.onPage(page, transform),
      onEvictPage: (page) => { this.content?.evictPage(page); },
      onBeforeResidentCommit: async (pages) => this.content?.beginResidentPageAuthority(pages),
      onCommitted: (pageCount, displayName, _document, _session, _ownerGeneration, openingFit) => {
        this.cancelWheelZoom();
        this.title = displayName;
        this.lastCommittedRender = undefined;
        this.reader.mountDocument(pageCount);
        this.searchLandingEpochActive = false;
        this.searchLandingEpochOrigin = undefined;
        this.historyHealthy = true;
        this.navigationHistory.reset();
        this.searchLandingEpoch = 0;
        const available = this.availableContentSize();
        const openingComplete = openingFit?.complete ?? (available.width > 0 && available.height > 0);
        this.openingFitRenderPending = !openingComplete
          || (openingFit !== undefined && (available.width !== openingFit.contentWidth || available.height !== openingFit.contentHeight));
        this.openingFitRenderInFlight = false;
        this.openingFitRenderRevision += 1;
        this.openingFitRenderIntent = undefined;
        this.openingFitRenderSettlement = undefined;
        this.navigationIntent += 1;
      },
      onBeforeCommit: async (rendered, commitCanvas, context) => {
        if (context.opening) {
          const content = this.createContent(context.session, context.ownerGeneration);
          const key = this.contentKey(context.session);
          this.contentBySession.set(key, content);
          content.mount(context.document, this.reader.snapshot.documentGeneration + 1, context.session.sessionId);
          content.suspend();
          context.registerStagedTeardown(async () => { await this.disposeContent(context.session, content); });
          const commit = (accessory?: HTMLElement): boolean => {
            const previous = this.content;
            this.content = content;
            const committed = commitCanvas(accessory);
            if (!committed) this.content = previous;
            return committed;
          };
          await content.renderPage({ ...rendered, retainedPages: context.retainedPages, commitCanvas: commit });
          return;
        }
        await this.content?.renderPage({ ...rendered, retainedPages: context.retainedPages, commitCanvas });
      },
      onBeforeDispose: async (session) => { await this.disposeContent(session); },
    });
  }

  public get snapshot(): PdfTabSnapshot {
    return {
      title: this.title,
      status: this.reader.snapshot.status,
      active: this.active,
      closed: this.closed,
      reader: this.reader.snapshot,
      content: this.content?.snapshot ?? {
        generation: null, pageNumber: null, query: "", results: [], currentResult: -1,
        searchPending: false, searchIncomplete: false,
      },
    };
  }

  public async adopt(session: OpenPdfResult, ownerGeneration: number): Promise<true> {
    if (this.closed || this.activityQuarantined) throw new Error("PDF_ADOPTION_NOT_COMMITTED");
    this.cancelWheelZoom();
    return this.pdfReader.adopt(session, ownerGeneration);
  }
  public get activeSessionIdentity(): { readonly sessionId: string; readonly documentGeneration: number; readonly ownerGeneration: number } | undefined { return this.pdfReader.activeSessionIdentity; }
  public get printProgress(): PdfPrintProgress | undefined { return this.pdfReader.printProgress; }
  public cancelPrint(): void { this.pdfReader.cancelPrint(); }
  public async printCurrent(): Promise<boolean> {
    return this.closed || !this.isForegroundActive() ? false : this.pdfReader.printCurrent();
  }
  public get navigationLandingInProgress(): boolean { return this.navigationLandingIntent !== undefined; }
  public async activate(): Promise<void> {
    const pendingActivity = this.activitySettlement;
    if (pendingActivity !== undefined) await pendingActivity;
    if (this.closed) return;
    if (this.active) {
      if (!this.openingFitRenderPending) return;
      await this.settleOpeningFit();
      return;
    }
    if (this.activityQuarantined) throw new Error("PDF_ACTIVITY_AUTHORITY_INCOMPLETE");
    this.active = true;
    this.foregroundSuspended = false;
    const activityGeneration = ++this.activityGeneration;
    this.activationGeneration = activityGeneration;
    try {
      await this.content?.synchronizeResidentPages(this.pdfReader.residentPageNumbers());
      if (this.closed || !this.isForegroundActive() || this.activityGeneration !== activityGeneration) return;
      if (this.openingFitRenderPending) {
        const fitted = await this.settleOpeningFit();
        if (this.closed || !this.isForegroundActive() || this.activityGeneration !== activityGeneration) return;
        if (!fitted && this.openingFitRenderPending) throw new Error("PDF_PRESENTATION_RESTORE_FAILED");
        this.finishActivation(activityGeneration);
        this.content?.resumeInteractions();
        return;
      }
      const needsPresentationRestore = this.presentationEvicted || this.presentationDirty || this.committedDevicePixelRatioDiffers() || this.committedContentSizeDiffers();
      if (needsPresentationRestore) await this.restorePresentation(activityGeneration);
      else {
        this.content?.activateResidentPage(this.reader.snapshot.page);
        await this.restoreInterruptedSearch(activityGeneration);
        if (this.closed || !this.isForegroundActive() || this.activityGeneration !== activityGeneration) return;
      }
      if (this.closed || !this.isForegroundActive() || this.activityGeneration !== activityGeneration) return;
      this.finishActivation(activityGeneration);
      this.content?.resumeInteractions();
    } catch (error) {
      this.finishActivation(activityGeneration);
      if (!this.closed && this.activityGeneration === activityGeneration) await this.settleInactiveAuthority();
      throw error;
    }
  }
  private async settleOpeningFit(): Promise<boolean> {
    for (let attempt = 0; attempt < 2 && this.openingFitRenderPending; attempt += 1) {
      const fitted = await this.renderOpeningFitPage();
      if (fitted || this.closed || !this.isForegroundActive()) return fitted;
    }
    return !this.openingFitRenderPending;
  }
  public async deactivate(): Promise<void> {
    this.cancelWheelZoom();
    if (this.closed) return;
    await this.settleInactiveAuthority();
  }
  public evictInactiveHeavyResources(): void {
    if (this.closed || this.active || !this.foregroundSuspended) return;
    const canvasEvicted = this.pdfReader.evictInactiveCanvas();
    const contentEvicted = this.content?.evictInactiveHeavyResources() ?? false;
    this.presentationEvicted ||= contentEvicted || canvasEvicted;
  }
  public async close(): Promise<void> {
    if (this.closeSettlement !== undefined) return this.closeSettlement;
    this.cancelWheelZoom();
    this.closed = true;
    this.active = false;
    this.foregroundSuspended = false;
    this.activityGeneration += 1;
    const settlement = (async () => {
      this.content?.suspend();
      const activitySettlement = this.activitySettlement;
      if (activitySettlement !== undefined) await Promise.allSettled([activitySettlement]);
      this.searchLandingEpochActive = false;
      this.searchLandingEpochOrigin = undefined;
      this.historyHealthy = true;
      await this.pdfReader.dispose();
      this.content = undefined;
      this.navigationHistory.reset();
      this.searchLandingEpoch = 0;
      this.contentBySession.clear();
      this.lastCommittedRender = undefined;
      this.reader.closeDocument();
    })();
    this.closeSettlement = settlement;
    try { await settlement; } catch (error) {
      if (this.closeSettlement === settlement) this.closeSettlement = undefined;
      throw error;
    }
  }
  public renderPage(page: number, transform?: PdfViewTransform): Promise<boolean> {
    return this.renderPageRequest(page, transform);
  }
  private async renderPageRequest(page: number, transform?: PdfViewTransform, openingFitRevision?: number, requestGuard: () => boolean = () => true): Promise<boolean> {
    if (this.closed || !this.isForegroundActive()) return false;
    const statusVersion = this.readerStatusVersion;
    const activityGeneration = this.activityGeneration;
    const intent = this.renderIntent;
    const navigationIntent = this.navigationIntent;
    const geometryRevision = this.viewportGeometryRevision;
    const contentSize = this.availableContentSize();
    const guard = (): boolean => !this.closed && this.isForegroundActive() && this.activityGeneration === activityGeneration
      && this.navigationIntent === navigationIntent && this.renderIntent === intent
      && this.viewportGeometryRevision === geometryRevision
      && this.availableContentSize().width === contentSize.width && this.availableContentSize().height === contentSize.height
      && (openingFitRevision === undefined
        || (this.openingFitRenderPending && this.openingFitRenderRevision === openingFitRevision))
      && requestGuard();
    this.pendingPresentationRenders += 1;
    try {
      const effectiveTransform = transform ?? await this.viewTransformFor(page, guard);
      if (effectiveTransform === undefined) {
        if (guard()) this.recoverFailedPresentation(intent, activityGeneration);
        else this.presentationDirty = true;
        return false;
      }
      if (!guard()) {
        this.presentationDirty = true;
        return false;
      }
      const topology: PdfPresentationTopology = "continuous";
      const committed = openingFitRevision === undefined
        ? await this.pdfReader.setPresentationTopology(topology, page, effectiveTransform, guard)
        : await this.pdfReader.setOpeningPresentationAtTop(topology, page, effectiveTransform, guard);
      if (!committed) {
        if (guard()) {
          const failureStatus = this.readerStatusVersion === statusVersion ? undefined : this.reader.snapshot.status;
          this.recoverFailedPresentation(intent, activityGeneration, failureStatus);
        } else {
          this.presentationDirty = true;
        }
      }
      return committed;
    } catch (error) {
      if (guard()) {
        const failureStatus = this.readerStatusVersion === statusVersion ? undefined : this.reader.snapshot.status;
        this.recoverFailedPresentation(intent, activityGeneration, failureStatus);
      } else {
        this.presentationDirty = true;
      }
      throw error;
    } finally {
      this.pendingPresentationRenders -= 1;
    }
  }
  public invalidateViewportSynchronization(): void {
    this.viewportGeometryRevision += 1;
    if (this.navigationLandingIntent !== undefined) return;
    this.viewportIntent += 1;
    this.cancelWheelZoom();
  }
  public async synchronizeViewport(scrollTop: number, clientHeight: number): Promise<boolean> {
    if (this.closed || !this.isForegroundActive() || !Number.isFinite(scrollTop) || !Number.isFinite(clientHeight) || clientHeight < 0) return false;
    if (this.pendingPresentationRenders > 0) return false;
    if (this.navigationLandingIntent !== undefined) return false;
    const statusVersion = this.readerStatusVersion;
    const activityGeneration = this.activityGeneration;
    const documentGeneration = this.reader.snapshot.documentGeneration;
    const navigationIntent = this.navigationIntent;
    const renderIntent = this.renderIntent;
    const viewportIntent = ++this.viewportIntent;
    const guard = (): boolean => !this.closed && this.isForegroundActive() && this.activityGeneration === activityGeneration
      && this.navigationIntent === navigationIntent && this.viewportIntent === viewportIntent;
    try {
      const style = typeof getComputedStyle === "function" ? getComputedStyle(this.options.canvasHost) : undefined;
      const padding = (value: string | undefined): number => {
        const parsed = Number.parseFloat(value ?? "0");
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const paddingTop = padding(style?.paddingTop);
      const contentScrollTop = Math.max(0, scrollTop - paddingTop);
      const contentHeight = Math.max(0, clientHeight - paddingTop - padding(style?.paddingBottom));
      let committed = await this.pdfReader.synchronizeViewport(contentScrollTop, contentHeight, guard);
      const snapshot = this.reader.snapshot;
      if (committed && guard() && snapshot.zoomMode !== "custom") {
        const stableTransform = await this.viewTransformFor(snapshot.page, guard);
        if (stableTransform !== undefined && Math.abs(stableTransform.scale - snapshot.customScale) > Number.EPSILON) {
          committed = await this.pdfReader.renderPageWithTransform(snapshot.page, stableTransform, guard);
        }
      }
      if (committed && guard() && this.reader.snapshot.documentGeneration === documentGeneration) {
        this.content?.activateResidentPage(this.reader.snapshot.page);
        this.content?.activateVisiblePages(this.pdfReader.visiblePageNumbers);
      }
      if (!committed && !guard()) this.presentationDirty = true;
      return committed;
    } catch (error) {
      if (guard() && this.reader.snapshot.documentGeneration === documentGeneration) {
        const failureStatus = this.readerStatusVersion === statusVersion ? undefined : this.reader.snapshot.status;
        this.recoverFailedPresentation(renderIntent, activityGeneration, failureStatus);
      } else {
        this.presentationDirty = true;
      }
      throw error;
    }
  }
  public async activateViewportPage(page: number): Promise<boolean> {
    if (this.closed || !this.isForegroundActive() || !Number.isInteger(page)) return false;
    if (page === this.reader.snapshot.page) return true;
    this.apply({ type: "page.goTo", page });
    return this.renderPage(this.reader.snapshot.page);
  }
  public startSearch(source: string): PdfTabSearchDecision {
    if (this.closed || !this.isForegroundActive()) return { kind: "ignore" };
    this.cancelWheelZoom();
    const content = this.content;
    if (content === undefined) return { kind: "ignore" };
    const query = normalizePdfSearchQuery(source);
    if (query.length === 0) {
      this.reader.setStatus("Enter text to search.", "search");
      return { kind: "ignore" };
    }
    this.searchLandingOwnerRevision += 1;
    this.searchLandingGeneration = -1;
    this.searchLandingSelection = -1;
    this.invalidatePageStepQueue();
    this.supersedeNavigation();
    this.beginSearchLandingEpoch();
    void content.search(query);
    return { kind: "search", query };
  }
  public cycleSearch(reverse = false): PdfTabSearchDecision {
    if (this.closed || !this.isForegroundActive()) return { kind: "ignore" };
    this.cancelWheelZoom();
    const content = this.content;
    if (content === undefined || content.snapshot.searchIncomplete || content.snapshot.results.length === 0) return { kind: "ignore" };
    this.invalidatePageStepQueue();
    this.supersedeNavigation();
    void content.nextMatch(reverse);
    return { kind: "cycle", reverse };
  }
  public get canHistoryBack(): boolean { return this.historyHealthy && this.navigationHistory.canBack; }
  public get canHistoryForward(): boolean { return this.historyHealthy && this.navigationHistory.canForward; }
  public beginSearchLandingEpoch(): number {
    if (!this.searchLandingEpochActive) {
      this.searchLandingEpoch += 1;
      this.searchLandingEpochOrigin = this.captureNavigationSnapshot();
      this.searchLandingEpochActive = true;
    }
    return this.searchLandingEpoch;
  }
  public navigatePagePrompt(page: number): Promise<PdfTabNavigationDecision> {
    this.cancelWheelZoom();
    this.invalidatePageStepQueue();
    return this.navigateHistoryJump(page, "page-prompt");
  }
  public navigateFirstPage(): Promise<PdfTabNavigationDecision> {
    this.cancelWheelZoom();
    this.invalidatePageStepQueue();
    return this.navigateHistoryJump(1, "page-first");
  }
  public navigateLastPage(): Promise<PdfTabNavigationDecision> {
    this.cancelWheelZoom();
    this.invalidatePageStepQueue();
    return this.navigateHistoryJump(this.reader.snapshot.pageCount, "page-last");
  }
  public navigateAdjacentPage(direction: -1 | 1): Promise<PdfTabNavigationDecision> {
    this.cancelWheelZoom();
    return new Promise((resolve, reject) => {
      this.pendingPageStep?.resolve({ kind: "stale" });
      this.pendingPageStep = { direction, generation: this.pageStepGeneration, resolve, reject };
      if (!this.pageStepActive) void this.drainPageSteps();
    });
  }
  private async drainPageSteps(): Promise<void> {
    this.pageStepActive = true;
    try {
      while (this.pendingPageStep !== undefined) {
        const request = this.pendingPageStep;
        this.pendingPageStep = undefined;
        try {
          request.resolve(await this.navigateAdjacentPageNow(request.direction, request.generation));
        } catch (error) { request.reject(error); }
      }
    } finally { this.pageStepActive = false; }
  }
  public cancelPendingNavigation(): void {
    this.recoverFailedPresentation(this.renderIntent, this.activityGeneration);
    this.invalidatePageStepQueue();
    const ownerIntent = this.navigationIntent;
    const fenceIntent = this.supersedeNavigation(true);
    this.cancelledNavigation = { ownerIntent, fenceIntent, activityGeneration: this.activityGeneration };
    this.pdfReader.invalidateViewportSynchronization();
    this.navigationHistory.cancelPending();
  }
  public async navigateSearchLanding(request: PdfSearchLandingRequest): Promise<PdfTabNavigationDecision> {
    if (request.result.geometry === undefined) return { kind: "preflightRejected" };
    this.cancelWheelZoom();
    if (request.searchGeneration < this.searchLandingGeneration
      || (request.searchGeneration === this.searchLandingGeneration && request.selectionSequence <= this.searchLandingSelection)) {
      return { kind: "stale" };
    }
    this.searchLandingGeneration = request.searchGeneration;
    this.searchLandingSelection = request.selectionSequence;
    const ownerRevision = this.searchLandingOwnerRevision;
    const ownerGuard = (): boolean => ownerRevision === this.searchLandingOwnerRevision
      && request.searchGeneration === this.searchLandingGeneration
      && request.selectionSequence === this.searchLandingSelection;
    this.invalidatePageStepQueue();
    return this.navigateHistoryJump(request.result.pageNumber, "search", this.beginSearchLandingEpoch(), request.result.geometry, ownerGuard);
  }
  public navigateHistoryBack(): Promise<PdfTabNavigationDecision> {
    this.cancelWheelZoom();
    this.invalidatePageStepQueue();
    return this.navigateHistoryTraversal("back");
  }
  public navigateHistoryForward(): Promise<PdfTabNavigationDecision> {
    this.cancelWheelZoom();
    this.invalidatePageStepQueue();
    return this.navigateHistoryTraversal("forward");
  }
  public apply(action: Parameters<ReaderState["apply"]>[0]): void {
    if (this.closed || !this.isForegroundActive()) return;
    const movement = action.type.startsWith("scroll.") || action.type.startsWith("page.") || action.type.startsWith("view.");
    if (movement) {
      this.invalidateOpeningFitRender();
      this.cancelWheelZoom();
    }
    if (action.type.startsWith("scroll.")) {
      this.invalidatePageStepQueue();
      if (this.navigationLandingInProgress || this.pageStepActive) this.supersedeNavigation();
      else this.content?.cancelDestination();
    }
    if (action.type.startsWith("page.") || action.type.startsWith("view.")) {
      this.invalidatePageStepQueue();
      this.supersedeNavigation();
      const snapshot = this.lastCommittedRender;
      if (snapshot !== undefined && snapshot.documentGeneration === this.reader.snapshot.documentGeneration) {
        const intent = ++this.renderIntent;
        this.pendingRenderRollback = { intent, activityGeneration: this.activityGeneration, ...snapshot };
      }
    }
    this.reader.apply(action);
  }
  public nextMatch(reverse: boolean): void { this.cycleSearch(reverse); }
  /** Applies decoded Ctrl-wheel steps at a host-local CSS pointer offset. */
  public zoomAt(steps: number, viewportOffset: PdfViewportOffset): Promise<boolean> {
    if (this.closed || !this.isForegroundActive() || !this.reader.snapshot.hasDocument
      || !Number.isSafeInteger(steps) || steps === 0
      || !Number.isFinite(viewportOffset.x) || !Number.isFinite(viewportOffset.y)) return Promise.resolve(false);
    if (this.lastCommittedRender === undefined) return Promise.resolve(false);
    const committedScale = this.lastCommittedRender.customScale;
    const baseScale = this.wheelTargetScale ?? committedScale;
    const exponent = Math.max(-128, Math.min(128, steps));
    const targetScale = Math.max(0.1, Math.min(8, baseScale * Math.pow(1.1, exponent)));
    if (targetScale === committedScale && this.wheelSettlement === undefined) {
      this.resetWheelZoom();
      if (this.reader.snapshot.zoomMode === "custom") return Promise.resolve(false);
      this.supersedeNavigation();
      this.renderIntent += 1;
      this.pdfReader.invalidateViewportSynchronization();
      this.reader.restoreView({ ...this.reader.snapshot, zoomMode: "custom", customScale: targetScale, fitPageReference: undefined });
      if (this.lastCommittedRender !== undefined) this.lastCommittedRender = { ...this.lastCommittedRender, zoomMode: "custom", fitPageReference: undefined };
      this.pendingRenderRollback = undefined;
      this.options.onStatus?.(this.reader.snapshot.status);
      return Promise.resolve(true);
    }
    this.wheelTargetScale = targetScale;
    this.wheelAnchor = { x: viewportOffset.x, y: viewportOffset.y };
    this.wheelRevision += 1;
    this.supersedeNavigation();
    this.renderIntent += 1;
    this.pdfReader.invalidateViewportSynchronization();
    if (this.wheelSettlement === undefined) {
      const generation = this.wheelOperationGeneration;
      this.wheelSettlement = new Promise<boolean>((resolve, reject) => { this.wheelResolve = resolve; this.wheelReject = reject; });
      void this.drainWheelZoom(generation);
    }
    return this.wheelSettlement;
  }

  /** Decodes one host wheel event and owns its tab-local zoom lifetime. */
  public handleWheelInput(input: {
    readonly ctrlKey: boolean;
    readonly deltaX: number;
    readonly deltaY: number;
    readonly deltaMode: number;
    readonly timeStamp: number;
    readonly clientX: number;
    readonly clientY: number;
  }): Promise<boolean> {
    if (this.closed || !this.isForegroundActive() || !this.reader.snapshot.hasDocument) {
      this.resetWheelZoom();
      return Promise.resolve(false);
    }
    const normalized: WheelZoomInput = {
      ctrlKey: input.ctrlKey,
      deltaX: input.deltaX,
      deltaY: input.deltaY,
      deltaMode: input.deltaMode,
      timestamp: input.timeStamp,
    };
    const result = consumeWheelZoom(normalized, this.wheelInputState);
    this.wheelInputState = result.state;
    if (!input.ctrlKey) {
      this.cancelWheelZoom();
      return Promise.resolve(false);
    }
    if (result.steps === 0) return Promise.resolve(false);
    const committedScale = this.wheelTargetScale ?? this.lastCommittedRender?.customScale ?? this.reader.snapshot.customScale;
    if ((result.steps > 0 && committedScale >= 8) || (result.steps < 0 && committedScale <= 0.1)) {
      this.resetWheelZoom();
    }
    const host = this.options.canvasHost;
    const rect = host.getBoundingClientRect();
    const viewportOffset: PdfViewportOffset = {
      x: input.clientX - rect.left - host.clientLeft,
      y: input.clientY - rect.top - host.clientTop,
    };
    return this.zoomAt(result.steps, viewportOffset);
  }

  /** Clears only the fractional wheel accumulator; accepted zoom work remains owned. */
  public resetWheelZoom(): void {
    this.wheelInputState = resetWheelZoomState();
  }

  /** Cancels pending wheel work without changing the last committed presentation. */
  public cancelWheelZoom(): void {
    this.resetWheelZoom();
    this.invalidateWheelZoom();
  }

  private invalidateWheelZoom(): void {
    if (this.wheelSettlement === undefined && this.wheelTargetScale === undefined) return;
    if (this.wheelSettlement !== undefined) {
      const rollback = this.pendingRenderRollback;
      if (rollback !== undefined) this.rollbackPendingRender(rollback.intent, this.activityGeneration);
    }
    this.wheelOperationGeneration += 1;
    this.wheelRevision += 1;
    this.wheelTargetScale = undefined;
    this.wheelAnchor = undefined;
    this.renderIntent += 1;
    this.pdfReader.invalidateViewportSynchronization();
    const resolve = this.wheelResolve;
    this.wheelResolve = undefined;
    this.wheelReject = undefined;
    this.wheelSettlement = undefined;
    resolve?.(false);
  }
  private async drainWheelZoom(generation: number): Promise<void> {
    let outcome = false;
    let failure: unknown;
    try {
      while (!this.closed && this.isForegroundActive() && generation === this.wheelOperationGeneration
        && this.wheelTargetScale !== undefined) {
        const targetScale = this.wheelTargetScale;
        const anchor = this.wheelAnchor;
        if (anchor === undefined) break;
        const revision = this.wheelRevision;
        const snapshot = this.reader.snapshot;
        const prior = this.lastCommittedRender;
        const activityGeneration = this.activityGeneration;
        const intent = ++this.renderIntent;
        const restore = (): void => {
          if (prior !== undefined && prior.documentGeneration === this.reader.snapshot.documentGeneration) {
            this.pendingRenderRollback = { intent, activityGeneration, ...prior };
            this.recoverFailedPresentation(intent, activityGeneration);
            this.lastCommittedRender = prior;
          }
        };
        if (prior !== undefined && prior.documentGeneration === snapshot.documentGeneration) {
          this.pendingRenderRollback = { intent, activityGeneration, ...prior };
        }
        const requestGuard = (): boolean => !this.closed && this.isForegroundActive()
          && activityGeneration === this.activityGeneration && generation === this.wheelOperationGeneration
          && revision === this.wheelRevision;
        let rendered: boolean;
        try {
          rendered = await this.pdfReader.setViewTransformAtPointer({ scale: targetScale,
            rotation: snapshot.rotationQuarterTurns * 90, devicePixelRatio: this.devicePixelRatio() }, anchor, requestGuard);
        } catch (error) {
          if (generation !== this.wheelOperationGeneration) break;
          if (revision !== this.wheelRevision) continue;
          restore();
          failure = error;
          break;
        }
        if (generation !== this.wheelOperationGeneration) break;
        if (revision !== this.wheelRevision) continue;
        if (!rendered) {
          restore();
          failure = new Error("PDF_WHEEL_ZOOM_FAILED");
          break;
        }
        if (this.wheelTargetScale !== targetScale) continue;
        if (this.reader.snapshot.zoomMode !== "custom" || this.reader.snapshot.customScale !== targetScale) {
          this.onPage(this.reader.snapshot.page, { scale: targetScale, rotation: snapshot.rotationQuarterTurns * 90, devicePixelRatio: this.devicePixelRatio() });
        }
        outcome = true;
        break;
      }
    } finally {
      if (generation === this.wheelOperationGeneration) {
        const resolve = this.wheelResolve;
        const reject = this.wheelReject;
        this.wheelResolve = undefined;
        this.wheelReject = undefined;
        this.wheelSettlement = undefined;
        this.wheelTargetScale = undefined;
        this.wheelAnchor = undefined;
        if (failure !== undefined) { this.resetWheelZoom(); reject?.(failure); }
        else resolve?.(outcome);
      }
    }
  }
  public invalidateSearch(): void {
    this.cancelWheelZoom();
    this.searchLandingOwnerRevision += 1;
    this.searchLandingGeneration = Number.MAX_SAFE_INTEGER;
    this.searchLandingSelection = Number.MAX_SAFE_INTEGER;
    this.supersedeNavigation();
    this.invalidatePageStepQueue();
    if (!this.closed && this.isForegroundActive()) this.content?.invalidateSearch();
    this.endSearchLandingEpoch();
  }
  public get query(): string { return this.content?.searchQuery ?? ""; }
  public clearVisibleLinkAuthority(): void { this.content?.clearVisibleLinkAuthority(); }
  public renderCurrentView(): Promise<boolean> {
    return this.openingFitRenderPending ? this.renderOpeningFitPage() : this.renderCurrentViewPreservingAnchor();
  }
  private async renderCurrentViewPreservingAnchor(): Promise<boolean> {
    const navigationIntent = this.navigationIntent;
    const rendered = await this.renderPage(this.reader.snapshot.page);
    if (rendered && navigationIntent === this.navigationIntent) {
      await this.synchronizeViewport(this.options.canvasHost.scrollTop, this.options.canvasHost.clientHeight);
    }
    return rendered;
  }
  public async resolveDestinationPage(reference: unknown): Promise<number | null> {
    if (this.closed || !this.isForegroundActive()) return null;
    const activityGeneration = this.activityGeneration;
    return this.pdfReader.resolvePageReference(reference, () => !this.closed && this.isForegroundActive() && this.activityGeneration === activityGeneration);
  }
  public async navigateToDestination(
    page: number,
    destination: readonly unknown[],
    cause: PdfLinkActivationCause = "internal-link",
    activationGuard: () => boolean = () => true,
  ): Promise<PdfDestinationNavigationOutcome> {
    if (this.closed || !this.isForegroundActive() || !this.historyHealthy) return { kind: "rejected" };
    this.cancelWheelZoom();
    const content = this.content;
    const origin = this.captureNavigationSnapshot();
    if (content === undefined || origin === undefined) return { kind: "rejected" };
    this.invalidatePageStepQueue();
    const navigationIntent = this.supersedeNavigation(false, true);
    const activityGeneration = this.activityGeneration;
    const sessionGuard = (): boolean => !this.closed && this.isForegroundActive() && this.activityGeneration === activityGeneration
      && this.navigationIntent === navigationIntent;
    const guard = (): boolean => sessionGuard() && activationGuard();
    const snapshot = this.reader.snapshot;
    let landingOwnerIntent = navigationIntent;
    const compensateToOrigin = async (compensationGuard: () => boolean = sessionGuard): Promise<"failed" | "stale"> => {
      this.reader.restoreView({ zoomMode: snapshot.zoomMode, customScale: snapshot.customScale, fitPageReference: snapshot.fitPageReference, rotationQuarterTurns: snapshot.rotationQuarterTurns });
      const compensated = await this.restoreCanonicalLanding(origin, compensationGuard);
      if (!compensationGuard() || compensated.kind === "staleOrCancelled") return "stale";
      if (compensated.kind !== "verified" && compensated.kind !== "constrainedEdgeVerified") this.historyHealthy = false;
      return "failed";
    };
    const settleStaleAfterMovement = async (): Promise<PdfDestinationNavigationOutcome> => {
      const cancellation = this.cancelledNavigation;
      if (cancellation?.ownerIntent === navigationIntent && cancellation.fenceIntent === this.navigationIntent
        && cancellation.activityGeneration === activityGeneration) {
        if (this.navigationLandingIntent === landingOwnerIntent) {
          landingOwnerIntent = cancellation.fenceIntent;
          this.navigationLandingIntent = landingOwnerIntent;
        }
        const cancellationGuard = (): boolean => !this.closed && this.isForegroundActive()
          && this.activityGeneration === activityGeneration && this.navigationIntent === cancellation.fenceIntent;
        await compensateToOrigin(cancellationGuard);
        if (this.cancelledNavigation === cancellation) this.cancelledNavigation = undefined;
        return { kind: "stale" };
      }
      if (!sessionGuard()) return { kind: "stale" };
      await compensateToOrigin();
      return { kind: "stale" };
    };
    const rawActivityEvents = ["wheel", "touchmove", "pointerdown"] as const;
    const fenceForRawActivity = (): void => {
      if (this.navigationLandingIntent !== landingOwnerIntent || this.navigationIntent !== landingOwnerIntent) return;
      this.pendingRenderRollback = undefined;
      this.invalidatePageStepQueue();
      this.navigationHistory.cancelPending();
      this.supersedeNavigation();
      this.pdfReader.invalidateViewportSynchronization();
    };
    const observesRawActivity = typeof this.options.canvasHost.addEventListener === "function";
    this.navigationLandingIntent = navigationIntent;
    if (observesRawActivity) {
      for (const event of rawActivityEvents) this.options.canvasHost.addEventListener(event, fenceForRawActivity, { passive: true });
    }
    let destinationIntentId: number | undefined;
    try {
      const targetSize = await this.pdfReader.getPageNaturalSize(page, snapshot.rotationQuarterTurns * 90, guard);
      if (!guard()) return { kind: "stale" };
      const view = resolvePdfDestinationView(destination, snapshot.customScale, targetSize,
        this.availableContentSize(), snapshot.rotationQuarterTurns,
        (scale) => Math.max(0.1, Math.min(8, scale)));
      if (view === undefined) return { kind: "rejected" };
      if (!guard()) return { kind: "stale" };
      const mode = destination[1];
      const modeName = typeof mode === "object" && mode !== null && "name" in mode ? String((mode as { readonly name?: unknown }).name) : String(mode ?? "");
      const requestedPoint = modeName === "XYZ" && Number.isFinite(destination[2]) && Number.isFinite(destination[3])
        ? { x: destination[2] as number, y: destination[3] as number }
        : undefined;
      const targetTransform = { scale: view.scale, rotation: snapshot.rotationQuarterTurns * 90, devicePixelRatio: this.devicePixelRatio() };
      const target = requestedPoint === undefined
        ? await this.pdfReader.getPageTopLanding(page, targetTransform, guard)
        : { pageIndex: page - 1, ...requestedPoint };
      if (target === undefined) return guard() ? { kind: "rejected" } : { kind: "stale" };
      if (!guard()) return { kind: "stale" };
      this.navigationHistory.cancelPending();
      const prepared = this.navigationHistory.prepareJump(origin, target, cause);
      if (prepared.kind === "same-location") return { kind: "same-location" };
      if (prepared.kind !== "prepared") return { kind: "rejected" };
      const rollbackSnapshot = this.lastCommittedRender;
      if (rollbackSnapshot === undefined || rollbackSnapshot.documentGeneration !== snapshot.documentGeneration) {
        this.navigationHistory.rollback(prepared.transaction);
        return { kind: "rejected" };
      }
      const intentId = content.queueDestination(page, destination);
      destinationIntentId = intentId;
      if (intentId === undefined || !guard()) {
        this.navigationHistory.rollback(prepared.transaction);
        return guard() ? { kind: "rejected" } : { kind: "stale" };
      }
      const renderIntent = ++this.renderIntent;
      this.pendingRenderRollback = { intent: renderIntent, activityGeneration, ...rollbackSnapshot };
      this.reader.apply({ type: "page.goTo", page });
      this.reader.restoreView({ zoomMode: view.zoomMode, customScale: view.scale, fitPageReference: view.zoomMode === "fit-page" ? page : undefined, rotationQuarterTurns: snapshot.rotationQuarterTurns });
      let targetPublished = false;
      try {
        targetPublished = await this.renderPageRequest(page, targetTransform, undefined, guard);
      } catch {
        targetPublished = false;
      }
      if (!targetPublished) {
        this.navigationHistory.rollback(prepared.transaction);
        return guard() ? { kind: "failed" } : await settleStaleAfterMovement();
      }
      if (!guard()) {
        this.navigationHistory.rollback(prepared.transaction);
        return await settleStaleAfterMovement();
      }
      content.applyQueuedDestinationToResidentPage(page);
      await content.awaitDestinationScroll(intentId);
      if (!guard()) {
        this.navigationHistory.rollback(prepared.transaction);
        return await settleStaleAfterMovement();
      }
      const verificationTarget = content.takeDestinationLanding(intentId);
      if (verificationTarget === undefined) {
        this.navigationHistory.rollback(prepared.transaction);
        return { kind: await compensateToOrigin() };
      }
      const completion = await this.pdfReader.restoreViewportLanding(
        verificationTarget,
        guard,
        targetTransform,
        "center",
        fenceForRawActivity,
      );
      if (completion.kind === "staleOrCancelled" || !guard()) {
        this.navigationHistory.rollback(prepared.transaction);
        return await settleStaleAfterMovement();
      }
      if (completion.kind !== "verified" && completion.kind !== "constrainedEdgeVerified") {
        this.navigationHistory.rollback(prepared.transaction);
        return { kind: await compensateToOrigin() };
      }
      const displayed = this.captureNavigationSnapshot();
      const finalVerificationTarget = completion.kind === "constrainedEdgeVerified" ? completion.expected : verificationTarget;
      if (displayed === undefined) {
        this.navigationHistory.rollback(prepared.transaction);
        return { kind: await compensateToOrigin() };
      }
      const historyResult = this.navigationHistory.commit(prepared.transaction, displayed, finalVerificationTarget);
      if (historyResult === "same-location") return { kind: "same-location" };
      if (historyResult !== "committed") return { kind: await compensateToOrigin() };
      this.endSearchLandingEpoch();
      return { kind: "verified" };
    } finally {
      if (observesRawActivity) {
        for (const event of rawActivityEvents) this.options.canvasHost.removeEventListener(event, fenceForRawActivity);
      }
      if (destinationIntentId !== undefined) content.cancelDestination(destinationIntentId);
      if (this.navigationLandingIntent === landingOwnerIntent) this.navigationLandingIntent = undefined;
    }
  }
  private endSearchLandingEpoch(): void {
    this.searchLandingEpochActive = false;
    this.searchLandingEpochOrigin = undefined;
  }
  private async navigateAdjacentPageNow(direction: -1 | 1, queueGeneration: number): Promise<PdfTabNavigationDecision> {
    const navigationOwner = this.acquireNavigation(() => queueGeneration === this.pageStepGeneration);
    const { guard } = navigationOwner;
    const origin = this.captureNavigationSnapshot();
    const reader = this.reader.snapshot;
    if (origin === undefined || !reader.hasDocument) return guard() ? { kind: "unavailable" } : { kind: "stale" };
    const targetPageIndex = Math.min(reader.pageCount - 1, Math.max(0, origin.pageIndex + direction));
    if (targetPageIndex === origin.pageIndex) return guard() ? { kind: "noOp" } : { kind: "stale" };
    const page = targetPageIndex + 1;
    const transform = await this.viewTransformFor(page, guard);
    const target = transform === undefined ? undefined : await this.pdfReader.getPageTopLanding(page, transform, guard);
    if (target === undefined) return guard() ? { kind: "preflightRejected" } : { kind: "stale" };
    const result = await this.restoreDisplayOnlyLanding(origin, target, navigationOwner, "page-top");
    if (result.kind === "verifiedLanding") this.endSearchLandingEpoch();
    return result;
  }
  private async navigateHistoryJump(
    page: number,
    cause: NavigationCause,
    searchEpoch?: number,
    point?: { readonly x: number; readonly y: number },
    ownerGuard: () => boolean = () => true,
    navigationOwner: NavigationOwner = this.acquireNavigation(ownerGuard),
  ): Promise<PdfTabNavigationDecision> {
    const preflightGuard = navigationOwner.guard;
    if (!this.historyHealthy) return preflightGuard() ? { kind: "unavailable" } : { kind: "stale" };
    const initialOrigin = this.captureNavigationSnapshot();
    const reader = this.reader.snapshot;
    if (initialOrigin === undefined || !Number.isSafeInteger(page) || page < 1 || page > reader.pageCount) return preflightGuard() ? { kind: "preflightRejected" } : { kind: "stale" };
    let target: NavigationSnapshot | undefined;
    if (point !== undefined) target = { pageIndex: page - 1, x: point.x, y: point.y };
    else {
      const transform = await this.viewTransformFor(page, preflightGuard);
      if (transform !== undefined) target = await this.pdfReader.getPageTopLanding(page, transform, preflightGuard);
    }
    if (target === undefined) return preflightGuard() ? { kind: "preflightRejected" } : { kind: "stale" };
    const liveOrigin = cause === "search" ? initialOrigin : this.captureNavigationSnapshot();
    if (liveOrigin === undefined) return preflightGuard() ? { kind: "preflightRejected" } : { kind: "stale" };
    if (cause === "search" && this.searchLandingEpochOrigin === undefined) {
      return sameSnapshotWithinTolerance(liveOrigin, target)
        ? { kind: "noOp" }
        : this.restoreDisplayOnlyLanding(liveOrigin, target, navigationOwner);
    }
    const historyOrigin = cause === "search" ? this.searchLandingEpochOrigin! : liveOrigin;
    this.navigationHistory.cancelPending();
    const prepared = this.navigationHistory.prepareJump(historyOrigin, target, cause, searchEpoch);
    if (prepared.kind === "search-epoch-recorded") return this.restoreDisplayOnlyLanding(liveOrigin, target, navigationOwner);
    if (prepared.kind === "same-location") {
      return cause === "search" && !sameSnapshotWithinTolerance(liveOrigin, target)
        ? this.restoreDisplayOnlyLanding(liveOrigin, target, navigationOwner)
        : { kind: "noOp" };
    }
    if (prepared.kind !== "prepared") return { kind: prepared.kind };
    return this.restoreHistoryTransaction(prepared.transaction, navigationOwner, liveOrigin, point === undefined ? "page-top" : "center");
  }
  private async navigateHistoryTraversal(direction: "back" | "forward"): Promise<PdfTabNavigationDecision> {
    const navigationOwner = this.acquireNavigation();
    if (!this.historyHealthy) return navigationOwner.guard() ? { kind: "unavailable" } : { kind: "stale" };
    const liveOrigin = this.captureNavigationSnapshot();
    if (liveOrigin === undefined) return navigationOwner.guard() ? { kind: "unavailable" } : { kind: "stale" };
    this.navigationHistory.cancelPending();
    const transaction = direction === "back" ? this.navigationHistory.prepareBack(liveOrigin) : this.navigationHistory.prepareForward(liveOrigin);
    if (transaction === undefined) return navigationOwner.guard() ? { kind: "unavailable" } : { kind: "stale" };
    return this.restoreHistoryTransaction(transaction, navigationOwner);
  }
  private async restoreCanonicalLanding(
    target: NavigationSnapshot,
    guard: () => boolean,
    placement: "center" | "page-top" = "center",
  ): Promise<PdfViewportRestoreOutcome> {
    const transform = await this.viewTransformFor(target.pageIndex + 1, guard);
    if (transform === undefined) return guard() ? { kind: "preflightRejected" } : { kind: "staleOrCancelled" };
    return this.pdfReader.restoreViewportLanding(target, guard, transform, placement);
  }
  private async restoreHistoryTransaction(
    transaction: NavigationTransaction,
    navigationOwner: NavigationOwner,
    compensationOrigin: NavigationSnapshot = transaction.origin,
    placement: "center" | "page-top" = "center",
  ): Promise<PdfTabNavigationDecision> {
    const { intent, guard } = navigationOwner;
    return this.withNavigationLanding(intent, async () => {
      const compensate = async (): Promise<PdfTabNavigationDecision> => {
        const compensated = await this.restoreCanonicalLanding(compensationOrigin, guard);
        if (compensated.kind === "staleOrCancelled" || !guard()) return { kind: "stale" };
        if (compensated.kind !== "verified" && compensated.kind !== "constrainedEdgeVerified") this.historyHealthy = false;
        return { kind: compensated.kind === "verified" || compensated.kind === "constrainedEdgeVerified"
          ? "compensatedFailure"
          : "uncompensatedInvariantFailure" };
      };
      const outcome = await this.restoreCanonicalLanding(transaction.target, guard, placement);
      if ((outcome.kind === "verified" || outcome.kind === "constrainedEdgeVerified") && guard()) {
        const verificationTarget = outcome.kind === "constrainedEdgeVerified" ? outcome.expected : transaction.target;
        const result = this.navigationHistory.commit(transaction, outcome.landing, verificationTarget);
        if (result === "committed") {
          if (transaction.cause !== "search") this.endSearchLandingEpoch();
          return { kind: "verifiedLanding" };
        }
        if (result === "same-location") return { kind: "noOp" };
        if (!guard()) return { kind: "stale" };
        return compensate();
      }
      this.navigationHistory.rollback(transaction);
      if (outcome.kind === "preflightRejected") return { kind: "preflightRejected" };
      if (outcome.kind === "staleOrCancelled" || !guard()) return { kind: "stale" };
      return compensate();
    });
  }
  private async restoreDisplayOnlyLanding(origin: NavigationSnapshot, target: NavigationSnapshot, navigationOwner: NavigationOwner, placement: "center" | "page-top" = "center"): Promise<PdfTabNavigationDecision> {
    const { intent, guard } = navigationOwner;
    return this.withNavigationLanding(intent, async () => {
      const outcome = await this.restoreCanonicalLanding(target, guard, placement);
      if ((outcome.kind === "verified" || outcome.kind === "constrainedEdgeVerified") && guard()) return { kind: "verifiedLanding" };
      if (outcome.kind === "preflightRejected") return { kind: "preflightRejected" };
      if (outcome.kind === "staleOrCancelled" || !guard()) return { kind: "stale" };
      const compensated = await this.restoreCanonicalLanding(origin, guard);
      if (compensated.kind === "staleOrCancelled" || !guard()) return { kind: "stale" };
      if (compensated.kind !== "verified" && compensated.kind !== "constrainedEdgeVerified") this.historyHealthy = false;
      return { kind: compensated.kind === "verified" || compensated.kind === "constrainedEdgeVerified"
        ? "compensatedFailure"
        : "uncompensatedInvariantFailure" };
    });
  }
  private async withNavigationLanding(intent: number, operation: () => Promise<PdfTabNavigationDecision>): Promise<PdfTabNavigationDecision> {
    this.navigationLandingIntent = intent;
    try { return await operation(); }
    finally { if (this.navigationLandingIntent === intent) this.navigationLandingIntent = undefined; }
  }
  private captureNavigationSnapshot(): NavigationSnapshot | undefined {
    if (!this.reader.snapshot.hasDocument) return undefined;
    return this.pdfReader.captureViewportLanding();
  }
  private async restorePresentation(activityGeneration: number): Promise<void> {
    const intent = this.navigationIntent;
    this.navigationLandingIntent = intent;
    try {
      let rendered = false;
      for (let attempt = 0; attempt < 2 && !rendered; attempt += 1) {
        rendered = await this.renderCurrentView();
        if (this.closed || !this.isForegroundActive() || this.activityGeneration !== activityGeneration) return;
      }
      if (!rendered) throw new Error("PDF_PRESENTATION_RESTORE_FAILED");
      await this.content?.restoreEvictedSearch();
      if (this.closed || !this.isForegroundActive() || this.activityGeneration !== activityGeneration) return;
      this.presentationEvicted = false;
      this.presentationDirty = false;
    } finally {
      if (this.navigationLandingIntent === intent) this.navigationLandingIntent = undefined;
    }
  }
  private async restoreInterruptedSearch(activityGeneration: number): Promise<void> {
    await this.content?.restoreEvictedSearch();
    if (this.closed || !this.isForegroundActive() || this.activityGeneration !== activityGeneration) return;
  }

  private async viewTransformFor(page: number, guard: () => boolean): Promise<PdfViewTransform | undefined> {
    const snapshot = this.reader.snapshot;
    const rotation = snapshot.rotationQuarterTurns * 90;
    let scale = snapshot.customScale;
    if (snapshot.zoomMode !== "custom") {
      const referencePage = snapshot.zoomMode === "fit-page" || snapshot.zoomMode === "continuous-fit" ? snapshot.fitPageReference : page;
      if (referencePage === undefined) return undefined;
      const size = await this.pdfReader.getPageNaturalSize(referencePage, rotation, guard);
      if (size === undefined || !guard()) return undefined;
      const available = this.availableContentSize();
      if (!Number.isFinite(available.width) || available.width <= 0 || !Number.isFinite(available.height) || available.height <= 0) return undefined;
      scale = snapshot.zoomMode === "fit-width" ? available.width / size.width : Math.min(available.width / size.width, available.height / size.height);
    }
    return { scale: Math.max(0.1, Math.min(8, scale)), rotation, devicePixelRatio: this.devicePixelRatio() };
  }
  private devicePixelRatio(): number { return typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1); }

  private committedDevicePixelRatioDiffers(): boolean {
    const committed = this.lastCommittedRender;
    return committed !== undefined
      && committed.documentGeneration === this.reader.snapshot.documentGeneration
      && committed.devicePixelRatio !== this.devicePixelRatio();
  }

  private committedContentSizeDiffers(): boolean {
    const committed = this.lastCommittedRender;
    if (committed === undefined || committed.documentGeneration !== this.reader.snapshot.documentGeneration) return false;
    const available = this.availableContentSize();
    return committed.contentWidth !== available.width || committed.contentHeight !== available.height;
  }
  private createContent(session: Pick<OpenPdfResult, "sessionId" | "documentGeneration">, ownerGeneration: number): PdfContentController {
    return new PdfContentController({
      ...this.options.createContentOptions(session, ownerGeneration, this.reader),
      host: this.options.canvasHost,
      resources: this.options.resources,
      onStatus: (status, source) => this.setStatus(status, source),
      onSearchCleared: () => {
        if (this.reader.clearSearchStatus()) this.options.onStatus?.(this.reader.snapshot.status);
      },
    });
  }

  private contentKey(session: Pick<OpenPdfResult, "sessionId" | "documentGeneration">): string {
    return `${session.sessionId}:${session.documentGeneration}`;
  }
  private async disposeContent(session: Pick<OpenPdfResult, "sessionId" | "documentGeneration">, expected?: PdfContentController): Promise<void> {
    const key = this.contentKey(session);
    const content = this.contentBySession.get(key);
    if (content === undefined || (expected !== undefined && content !== expected)) return;
    const pending = this.contentDisposeSettlements.get(key);
    if (pending !== undefined) return pending;
    const settlement = (async () => {
      await content.unmount();
      if (this.contentBySession.get(key) !== content) return;
      this.contentBySession.delete(key);
      if (this.content === content) this.content = undefined;
    })();
    this.contentDisposeSettlements.set(key, settlement);
    try {
      await settlement;
      if (this.contentDisposeSettlements.get(key) === settlement) this.contentDisposeSettlements.delete(key);
    } catch (error) {
      if (this.contentDisposeSettlements.get(key) === settlement) this.contentDisposeSettlements.delete(key);
      throw error;
    }
  }

  private settleInactiveAuthority(): Promise<void> {
    if (this.activitySettlement !== undefined) return this.activitySettlement;
    const settlement = (async () => {
      if (this.pendingPresentationRenders > 0) this.presentationDirty = true;
      delete this.activationGeneration;
      this.activitySettling = true;
      this.foregroundSuspended = false;
      this.activityGeneration += 1;
      this.content?.suspend();
      const suspend = Promise.resolve().then(async () => this.pdfReader.suspend());
      const revokeAuthority = Promise.resolve().then(async () => this.content?.synchronizeResidentPages([]));
      const outcomes = await Promise.allSettled([suspend, revokeAuthority]);
      this.active = false;
      if (outcomes.some((outcome) => outcome.status === "rejected")) {
        this.activityQuarantined = true;
        throw new Error("PDF_ACTIVITY_AUTHORITY_INCOMPLETE");
      }
      this.foregroundSuspended = true;
    })();
    this.activitySettlement = settlement;
    void settlement.then(() => {
      if (this.activitySettlement === settlement) delete this.activitySettlement;
      this.activitySettling = false;
    }, () => {
      this.activitySettling = false;
    });
    return settlement;
  }
  private finishActivation(generation: number): void {
    if (this.activationGeneration === generation) delete this.activationGeneration;
  }
  private acquireNavigation(ownerGuard: () => boolean = () => true): NavigationOwner {
    const intent = this.supersedeNavigation();
    const activityGeneration = this.activityGeneration;
    return {
      intent,
      guard: () => ownerGuard() && !this.closed && this.isForegroundActive()
        && this.navigationIntent === intent && this.activityGeneration === activityGeneration,
    };
  }
  private invalidatePageStepQueue(): void {
    this.pageStepGeneration += 1;
    this.pendingPageStep?.resolve({ kind: "stale" });
    this.pendingPageStep = undefined;
  }
  private isForegroundActive(): boolean {
    return this.active && !this.activitySettling && !this.activityQuarantined;
  }
  private availableContentSize(): { readonly width: number; readonly height: number } {
    const host = this.options.canvasHost;
    const style = typeof getComputedStyle === "function" ? getComputedStyle(host) : undefined;
    const padding = (value: string | undefined): number => {
      const parsed = Number.parseFloat(value ?? "0");
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      width: host.clientWidth - padding(style?.paddingLeft) - padding(style?.paddingRight),
      height: host.clientHeight - padding(style?.paddingTop) - padding(style?.paddingBottom),
    };
  }

  private invalidateOpeningFitRender(): void {
    if (!this.openingFitRenderPending) return;
    this.openingFitRenderPending = false;
    this.openingFitRenderRevision += 1;
    if (this.openingFitRenderIntent !== undefined && this.pendingRenderRollback?.intent === this.openingFitRenderIntent) {
      this.pendingRenderRollback = undefined;
    }
  }

  private supersedeNavigation(preserveCancellation = false, preserveLinkActivation = false): number {
    this.invalidateOpeningFitRender();
    if (!preserveCancellation) this.cancelledNavigation = undefined;
    this.content?.cancelDestination(undefined, preserveLinkActivation);
    return ++this.navigationIntent;
  }

  private renderOpeningFitPage(): Promise<boolean> {
    if (!this.openingFitRenderPending) return Promise.resolve(false);
    if (this.openingFitRenderSettlement !== undefined) return this.openingFitRenderSettlement;
    const available = this.availableContentSize();
    if (!(available.width > 0 && available.height > 0)) return Promise.resolve(false);
    const openingViewportAtTop = (): boolean => this.options.canvasHost.scrollLeft === 0 && this.options.canvasHost.scrollTop === 0;
    if (!openingViewportAtTop()) {
      this.invalidateOpeningFitRender();
      return Promise.resolve(false);
    }
    const revision = this.openingFitRenderRevision;
    const geometryRevision = this.viewportGeometryRevision;
    const activityGeneration = this.activityGeneration;
    const documentGeneration = this.reader.snapshot.documentGeneration;
    const page = this.reader.snapshot.page;
    const navigationIntent = this.navigationIntent;
    const fallbackOrigin = this.lastCommittedRender;
    const intent = ++this.renderIntent;
    this.openingFitRenderIntent = intent;
    if (fallbackOrigin !== undefined && fallbackOrigin.documentGeneration === documentGeneration) {
      this.pendingRenderRollback = { intent, activityGeneration, ...fallbackOrigin };
    }
    this.openingFitRenderInFlight = true;
    const current = (): boolean => !this.closed && this.isForegroundActive() && this.activityGeneration === activityGeneration
      && this.openingFitRenderPending && this.openingFitRenderRevision === revision
      && this.viewportGeometryRevision === geometryRevision
      && this.reader.snapshot.documentGeneration === documentGeneration && this.navigationIntent === navigationIntent
      && this.renderIntent === intent;
    const settlement = (async (): Promise<boolean> => {
      const rendered = await this.renderPageRequest(page, undefined, revision, openingViewportAtTop);
      if (!rendered) {
        if (current() && !openingViewportAtTop()) this.invalidateOpeningFitRender();
        return false;
      }
      if (!current()) return false;
      const finalAvailable = this.availableContentSize();
      if (finalAvailable.width !== available.width || finalAvailable.height !== available.height) {
        this.viewportGeometryRevision += 1;
        return false;
      }
      this.openingFitRenderPending = false;
      if (this.navigationIntent === navigationIntent) {
        await this.synchronizeViewport(this.options.canvasHost.scrollTop, this.options.canvasHost.clientHeight);
      }
      return true;
    })();
    this.openingFitRenderSettlement = settlement;
    const clear = (): void => {
      if (this.openingFitRenderSettlement !== settlement) return;
      this.openingFitRenderSettlement = undefined;
      this.openingFitRenderInFlight = false;
      if (this.openingFitRenderIntent === intent) this.openingFitRenderIntent = undefined;
    };
    void settlement.then(clear, clear);
    return settlement;
  }
  private recoverFailedPresentation(intent: number, activityGeneration: number, failureStatus?: string): void {
    if (intent !== this.renderIntent || activityGeneration !== this.activityGeneration || this.closed) return;
    this.rollbackPendingRender(intent, activityGeneration, failureStatus);
    const activePage = this.pdfReader.activePageNumber;
    if (activePage === undefined) {
      this.presentationDirty = true;
      this.content?.suspend();
    } else {
      if (this.reader.snapshot.page !== activePage) this.reader.apply({ type: "page.goTo", page: activePage });
      if (this.content?.activateResidentPage(activePage) === false) this.presentationDirty = true;
    }
    if (failureStatus !== undefined) this.setStatus(failureStatus);
  }
  private rollbackPendingRender(intent: number, activityGeneration: number, failureStatus?: string): void {
    const rollback = this.pendingRenderRollback;
    if (rollback === undefined || rollback.intent !== intent || rollback.activityGeneration !== activityGeneration
      || rollback.activityGeneration !== this.activityGeneration || rollback.documentGeneration !== this.reader.snapshot.documentGeneration
      || this.closed || !this.isForegroundActive()) return;
    this.reader.apply({ type: "page.goTo", page: rollback.page });
    this.reader.restoreView(rollback);
    this.pendingRenderRollback = undefined;
    if (failureStatus !== undefined) this.setStatus(failureStatus);
  }

  private onPage(page: number, transform: PdfViewTransform): void {
    const snapshot = this.reader.snapshot;
    this.reader.apply({ type: "page.goTo", page });
    const wheelCommit = this.wheelSettlement !== undefined && transform.scale === this.wheelTargetScale;
    this.reader.restoreView({ zoomMode: wheelCommit ? "custom" : snapshot.zoomMode, customScale: transform.scale,
      fitPageReference: wheelCommit ? undefined : snapshot.fitPageReference, rotationQuarterTurns: ((transform.rotation / 90) % 4 + 4) % 4 });
    this.content?.activateResidentPage(page);
    this.content?.activateVisiblePages(this.pdfReader.visiblePageNumbers);
    if (this.isForegroundActive() && this.activationGeneration === undefined) this.content?.resumeInteractions();
    const committed = this.reader.snapshot;
    this.lastCommittedRender = {
      documentGeneration: committed.documentGeneration,
      page: committed.page,
      zoomMode: committed.zoomMode,
      customScale: committed.customScale,
      rotationQuarterTurns: committed.rotationQuarterTurns,
      fitPageReference: committed.fitPageReference,
      devicePixelRatio: Math.min(2, transform.devicePixelRatio),
      contentWidth: this.availableContentSize().width,
      contentHeight: this.availableContentSize().height,
    };
    this.pendingRenderRollback = undefined;
    this.options.onStatus?.(this.reader.snapshot.status);
    if (this.openingFitRenderPending && !this.openingFitRenderInFlight) {
      const revision = this.openingFitRenderRevision;
      const documentGeneration = committed.documentGeneration;
      const fallbackOrigin = this.lastCommittedRender;
      void this.renderOpeningFitPage().then((rendered) => {
        const available = this.availableContentSize();
        if (!rendered && this.openingFitRenderPending && this.openingFitRenderRevision === revision
          && this.reader.snapshot.documentGeneration === documentGeneration && this.lastCommittedRender === fallbackOrigin
          && available.width > 0 && available.height > 0) {
          this.setStatus("PDF presentation could not be updated.");
        }
      }, (error: unknown) => {
        if (!isAuthorityIncomplete(error) && this.openingFitRenderRevision === revision
          && this.reader.snapshot.documentGeneration === documentGeneration && this.lastCommittedRender === fallbackOrigin) {
          this.setStatus("PDF presentation could not be updated.");
        }
      });
    }
  }

  private setReaderStatus(status: string): void {
    this.readerStatusVersion += 1;
    this.setStatus(status);
  }
  private setStatus(status: string, source?: "search"): void { this.reader.setStatus(status, source); this.options.onStatus?.(status); }
}
