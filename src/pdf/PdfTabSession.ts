import { NavigationHistory, sameSnapshotWithinTolerance, type NavigationCause, type NavigationSnapshot, type NavigationTransaction } from "../domain/navigation/NavigationHistory";
import type { HintKeyInput } from "../domain/links/LinkHints";
import { ReaderState, type ReaderSnapshot } from "../core/ReaderState";
import {
  PdfContentController,
  normalizePdfSearchQuery,
  type PdfContentControllerOptions,
  type PdfDestinationNavigationOutcome,
  type PdfLinkActivationCause,
  type PdfSearchLandingRequest,
  type PdfContentSnapshot,
} from "./PdfContentController";
import type { PdfOutlineProbeRow } from "./PdfOutlineProbe";
import type { RawOutlineNode } from "../domain/outlines/OutlineModel";
import { resolvePdfDestinationView } from "./PdfDestination";
import {
  PdfReaderController,
  type OpenPdfResult,
  type PdfBoundary,
  type PdfReaderControllerOptions,
  type PdfViewTransform,
  type PdfViewportRestoreOutcome,
  type ReaderNativeBoundary,
} from "./PdfReaderController";
import { ResourceReservationManager } from "./ResourceBudget";

export interface PdfTabSnapshot {
  readonly title: string;
  readonly status: string;
  readonly active: boolean;
  readonly closed: boolean;
  readonly reader: ReaderSnapshot;
  readonly content: PdfContentSnapshot;
}

export interface PdfTabSessionOptions {
  readonly native: ReaderNativeBoundary;
  readonly pdf: PdfBoundary;
  readonly resources: ResourceReservationManager;
  readonly canvasHost: HTMLElement;
  readonly createContentOptions: (
    session: Pick<OpenPdfResult, "sessionId" | "documentGeneration">,
    ownerGeneration: number,
    reader: ReaderState,
  ) => Omit<PdfContentControllerOptions, "host" | "resources" | "onStatus">;
  readonly onStatus?: (status: string) => void;
}
export type PdfTabNavigationDecision = { readonly kind: "verifiedLanding" | "preflightRejected" | "compensatedFailure" | "uncompensatedInvariantFailure" | "unavailable" | "noOp" | "stale" | "failed-verification" | "excluded" | "search-epoch-recorded" | "invalid" | "rolled-back" };

export type PdfTabSearchDecision =
  | { readonly kind: "ignore" }
  | { readonly kind: "cycle"; readonly reverse: boolean }
  | { readonly kind: "search"; readonly query: string };

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
  private searchLandingEpoch = 0;
  private searchLandingEpochActive = false;
  private searchLandingEpochOrigin: NavigationSnapshot | undefined;
  private historyHealthy = true;
  private searchLandingOwnerRevision = 0;
  private searchLandingGeneration = -1;
  private searchLandingSelection = -1;
  private openingFitRenderInFlight = false;
  private activityGeneration = 0;
  private renderIntent = 0;
  private pendingPresentationRenders = 0;
  private readerStatusVersion = 0;
  private navigationIntent = 0;
  private viewportIntent = 0;
  private pendingRenderRollback: {
    readonly intent: number;
    readonly activityGeneration: number;
    readonly documentGeneration: number;
    readonly page: number;
    readonly zoomMode: ReaderSnapshot["zoomMode"];
    readonly customScale: number;
    readonly rotationQuarterTurns: number;
  } | undefined;
  private lastCommittedRender: {
    readonly documentGeneration: number;
    readonly page: number;
    readonly zoomMode: ReaderSnapshot["zoomMode"];
    readonly customScale: number;
    readonly rotationQuarterTurns: number;
    readonly devicePixelRatio: number;
  } | undefined;

  public constructor(private readonly options: PdfTabSessionOptions) {
    this.pdfReader = new PdfReaderController({
      native: options.native,
      pdf: options.pdf,
      resources: options.resources,
      canvasHost: options.canvasHost,
      availableContentSize: () => this.availableContentSize(),
      onStatus: (status) => this.setReaderStatus(status),
      onPage: (page, transform) => this.onPage(page, transform),
      onEvictPage: (page) => { this.content?.evictPage(page); },
      onBeforeResidentCommit: async (pages) => this.content?.beginResidentPageAuthority(pages),
      onCommitted: (pageCount, displayName) => {
        this.title = displayName;
        this.lastCommittedRender = undefined;
        this.reader.mountDocument(pageCount);
        this.searchLandingEpochActive = false;
        this.searchLandingEpochOrigin = undefined;
        this.historyHealthy = true;
        this.navigationHistory.reset();
        this.searchLandingEpoch = 0;
        const available = this.availableContentSize();
        this.openingFitRenderPending = !(available.width > 0 && available.height > 0);
        this.openingFitRenderInFlight = false;
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
        searchPending: false, searchIncomplete: false, hintsVisible: false, visibleLinkCount: 0,
      },
    };
  }

  public async adopt(session: OpenPdfResult, ownerGeneration: number): Promise<true> {
    if (this.closed || this.activityQuarantined) throw new Error("PDF_ADOPTION_NOT_COMMITTED");
    return this.pdfReader.adopt(session, ownerGeneration);
  }
  public async readOutlineTreeNodes(): Promise<readonly RawOutlineNode[]> {
    return this.closed ? [] : this.pdfReader.readOutlineTreeNodes();
  }
  public async readOutlineDestinations(): Promise<readonly PdfOutlineProbeRow[]> {
    return this.closed ? [] : this.pdfReader.readOutlineDestinations();
  }
  public async printCurrent(): Promise<boolean> {
    return this.closed || !this.isForegroundActive() ? false : this.pdfReader.printCurrent();
  }
  public async activate(): Promise<void> {
    const pendingActivity = this.activitySettlement;
    if (pendingActivity !== undefined) await pendingActivity;
    if (this.closed || this.active) return;
    if (this.activityQuarantined) throw new Error("PDF_ACTIVITY_AUTHORITY_INCOMPLETE");
    this.active = true;
    this.foregroundSuspended = false;
    const activityGeneration = ++this.activityGeneration;
    this.activationGeneration = activityGeneration;
    try {
      await this.content?.synchronizeResidentPages(this.pdfReader.residentPageNumbers());
      if (this.closed || !this.isForegroundActive() || this.activityGeneration !== activityGeneration) return;
      if (this.openingFitRenderPending) {
        await this.renderOpeningFitPage();
        if (this.closed || !this.isForegroundActive() || this.activityGeneration !== activityGeneration) return;
        this.finishActivation(activityGeneration);
        this.content?.resumeInteractions();
        return;
      }
      const needsPresentationRestore = this.presentationEvicted || this.presentationDirty || this.committedDevicePixelRatioDiffers();
      if (needsPresentationRestore) {
        await this.restorePresentation(activityGeneration);
      } else {
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
  public async deactivate(): Promise<void> {
    if (this.closed) return;
    await this.settleInactiveAuthority();
  }
  public evictInactiveHeavyResources(): void {
    if (this.closed || this.active || !this.foregroundSuspended) return;
    const contentEvicted = this.content?.evictInactiveHeavyResources() ?? false;
    const canvasEvicted = this.pdfReader.evictInactiveCanvas();
    this.presentationEvicted ||= contentEvicted || canvasEvicted;
  }
  public async close(): Promise<void> {
    if (this.closeSettlement !== undefined) return this.closeSettlement;
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
  public async renderPage(page: number, transform?: PdfViewTransform): Promise<boolean> {
    if (this.closed || !this.isForegroundActive()) return false;
    const statusVersion = this.readerStatusVersion;
    const activityGeneration = this.activityGeneration;
    const intent = this.renderIntent;
    const navigationIntent = this.navigationIntent;
    const guard = (): boolean => !this.closed && this.isForegroundActive() && this.activityGeneration === activityGeneration
      && this.navigationIntent === navigationIntent;
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
      const committed = await this.pdfReader.renderPageWithTransform(page, effectiveTransform, guard);
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
    this.viewportIntent += 1;
    this.pdfReader.invalidateViewportSynchronization();
  }
  /** Production scroll entry point: materializes the bounded continuous window. */
  public async synchronizeViewport(scrollTop: number, clientHeight: number): Promise<boolean> {
    if (this.closed || !this.isForegroundActive() || !Number.isFinite(scrollTop) || !Number.isFinite(clientHeight) || clientHeight < 0) return false;
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
    const content = this.content;
    if (content === undefined) return { kind: "ignore" };
    const query = normalizePdfSearchQuery(source);
    if (query.length === 0) {
      this.reader.setStatus("Enter text to search.");
      return { kind: "ignore" };
    }
    this.searchLandingOwnerRevision += 1;
    this.searchLandingGeneration = -1;
    this.searchLandingSelection = -1;
    this.supersedeNavigation();
    this.beginSearchLandingEpoch();
    void content.search(query);
    return { kind: "search", query };
  }
  public cycleSearch(reverse = false): PdfTabSearchDecision {
    if (this.closed || !this.isForegroundActive()) return { kind: "ignore" };
    const content = this.content;
    if (content === undefined || content.snapshot.searchPending || content.snapshot.searchIncomplete || content.snapshot.results.length === 0) return { kind: "ignore" };
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
  public async navigatePagePrompt(page: number): Promise<PdfTabNavigationDecision> { return this.navigateHistoryJump(page, "page-prompt"); }
  public async navigateFirstPage(): Promise<PdfTabNavigationDecision> { return this.navigateHistoryJump(1, "page-first"); }
  public async navigateLastPage(): Promise<PdfTabNavigationDecision> { return this.navigateHistoryJump(this.reader.snapshot.pageCount, "page-last"); }
  public async navigateSearchLanding(request: PdfSearchLandingRequest): Promise<PdfTabNavigationDecision> {
    if (request.result.geometry === undefined) return { kind: "preflightRejected" };
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
    return this.navigateHistoryJump(request.result.pageNumber, "search", this.beginSearchLandingEpoch(), request.result.geometry, ownerGuard);
  }
  public async navigateHistoryBack(): Promise<PdfTabNavigationDecision> { return this.navigateHistoryTraversal("back"); }
  public async navigateHistoryForward(): Promise<PdfTabNavigationDecision> { return this.navigateHistoryTraversal("forward"); }
  public apply(action: Parameters<ReaderState["apply"]>[0]): void {
    if (this.closed || !this.isForegroundActive()) return;
    if (action.type.startsWith("page.") || action.type.startsWith("view.") || action.type.startsWith("scroll.")) {
      this.supersedeNavigation();
      this.content?.dismissLinkDecorations();
      const snapshot = this.lastCommittedRender;
      if (snapshot !== undefined && snapshot.documentGeneration === this.reader.snapshot.documentGeneration) {
        const intent = ++this.renderIntent;
        this.pendingRenderRollback = { intent, activityGeneration: this.activityGeneration, ...snapshot };
      }
    }
    this.reader.apply(action);
  }
  public nextMatch(reverse: boolean): void { if (!this.closed && this.isForegroundActive()) this.content?.nextMatch(reverse); }
  public toggleHints(): void { if (!this.closed && this.isForegroundActive()) this.content?.toggleHints(); }
  public cancelHints(): void { if (!this.closed && this.isForegroundActive()) this.content?.cancelHints(); }
  public handleHintKey(input: string | HintKeyInput): boolean { return !this.closed && this.isForegroundActive() && this.content?.handleHintKey(input) === true; }
  public invalidateSearch(): void {
    this.searchLandingOwnerRevision += 1;
    this.searchLandingGeneration = Number.MAX_SAFE_INTEGER;
    this.searchLandingSelection = Number.MAX_SAFE_INTEGER;
    this.supersedeNavigation();
    if (!this.closed && this.isForegroundActive()) this.content?.invalidateSearch();
    this.endSearchLandingEpoch();
  }
  public get query(): string { return this.content?.snapshot.query ?? ""; }
  public get hintsVisible(): boolean { return this.content?.snapshot.hintsVisible ?? false; }
  public get visibleLinkCount(): number { return this.content?.snapshot.visibleLinkCount ?? 0; }
  public get indicatorPublicationPending(): boolean { return this.content?.indicatorPublicationPending ?? false; }
  public get linkDecorationsVisible(): boolean { return this.content?.linkDecorationsVisible ?? false; }
  public clearVisibleLinkAuthority(): void { this.content?.clearVisibleLinkAuthority(); }
  public dismissLinkDecorations(): void { if (!this.closed && this.isForegroundActive()) this.content?.dismissLinkDecorations(); }
  public async renderCurrentView(): Promise<boolean> {
    const rendered = await this.renderPage(this.reader.snapshot.page);
    if (rendered && this.openingFitRenderPending) this.openingFitRenderPending = false;
    return rendered;
  }

  public async navigateToDestination(
    page: number,
    destination: readonly unknown[],
    cause: PdfLinkActivationCause = "internal-link",
    activationGuard: () => boolean = () => true,
  ): Promise<PdfDestinationNavigationOutcome> {
    if (this.closed || !this.isForegroundActive() || !this.historyHealthy) return { kind: "rejected" };
    const content = this.content;
    const origin = this.captureNavigationSnapshot();
    if (content === undefined || origin === undefined) return { kind: "rejected" };
    const navigationIntent = this.supersedeNavigation();
    const activityGeneration = this.activityGeneration;
    const sessionGuard = (): boolean => !this.closed && this.isForegroundActive() && this.activityGeneration === activityGeneration
      && this.navigationIntent === navigationIntent;
    const guard = (): boolean => sessionGuard() && activationGuard();
    const snapshot = this.reader.snapshot;
    const compensateToOrigin = async (): Promise<"failed" | "stale"> => {
      this.reader.restoreView({ zoomMode: snapshot.zoomMode, customScale: snapshot.customScale, rotationQuarterTurns: snapshot.rotationQuarterTurns });
      const compensated = await this.restoreCanonicalLanding(origin, sessionGuard);
      if (!sessionGuard() || compensated.kind === "staleOrCancelled") return "stale";
      if (compensated.kind !== "verified" && compensated.kind !== "constrainedEdgeVerified") this.historyHealthy = false;
      return "failed";
    };
    const targetSize = await this.pdfReader.getPageNaturalSize(page, snapshot.rotationQuarterTurns * 90, guard);
    if (!guard()) return { kind: "stale" };
    const view = resolvePdfDestinationView(destination, snapshot.customScale, targetSize,
      this.availableContentSize(), snapshot.rotationQuarterTurns,
      (scale) => Math.max(0.1, Math.min(8, scale)));
    if (view === undefined || !guard()) return { kind: "rejected" };
    const mode = destination[1];
    const modeName = typeof mode === "object" && mode !== null && "name" in mode ? String((mode as { readonly name?: unknown }).name) : String(mode ?? "");
    const requestedPoint = modeName === "XYZ" && Number.isFinite(destination[2]) && Number.isFinite(destination[3])
      ? { x: destination[2] as number, y: destination[3] as number }
      : undefined;
    const target = requestedPoint === undefined
      ? await this.pdfReader.getPageTopLanding(page, { scale: view.scale, rotation: snapshot.rotationQuarterTurns * 90, devicePixelRatio: this.devicePixelRatio() }, guard)
      : { pageIndex: page - 1, ...requestedPoint };
    if (target === undefined || !guard()) return guard() ? { kind: "rejected" } : { kind: "stale" };
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
    if (intentId === undefined || !guard()) {
      this.navigationHistory.rollback(prepared.transaction);
      if (intentId !== undefined) content.cancelDestination(intentId);
      return guard() ? { kind: "rejected" } : { kind: "stale" };
    }
    const renderIntent = ++this.renderIntent;
    this.pendingRenderRollback = { intent: renderIntent, activityGeneration, ...rollbackSnapshot };
    this.reader.apply({ type: "page.goTo", page });
    this.reader.restoreView({ zoomMode: view.zoomMode, customScale: view.scale, rotationQuarterTurns: snapshot.rotationQuarterTurns });
    let committed = false;
    try {
      committed = await this.renderPage(page, { scale: view.scale, rotation: snapshot.rotationQuarterTurns * 90, devicePixelRatio: this.devicePixelRatio() });
    } catch {
      committed = false;
    } finally {
      if (!committed) content.cancelDestination(intentId);
    }
    if (!committed) {
      this.navigationHistory.rollback(prepared.transaction);
      return guard() ? { kind: "failed" } : { kind: "stale" };
    }
    if (!guard()) {
      this.navigationHistory.rollback(prepared.transaction);
      if (!sessionGuard()) return { kind: "stale" };
      await compensateToOrigin();
      return { kind: "stale" };
    }
    const displayed = this.captureNavigationSnapshot();
    const verificationTarget = content.takeDestinationLanding(intentId);
    if (displayed === undefined || verificationTarget === undefined) {
      this.navigationHistory.rollback(prepared.transaction);
      return { kind: await compensateToOrigin() };
    }
    const historyResult = this.navigationHistory.commit(prepared.transaction, displayed, verificationTarget);
    if (historyResult === "same-location") return { kind: "same-location" };
    if (historyResult !== "committed") return { kind: await compensateToOrigin() };
    this.endSearchLandingEpoch();
    return requestedPoint === undefined
      ? { kind: "verified" }
      : { kind: "verified", point: { pageNumber: page, ...requestedPoint } };
  }
  public async search(query: string): Promise<void> { if (!this.closed && this.isForegroundActive()) await this.content?.search(query); }

  private endSearchLandingEpoch(): void {
    this.searchLandingEpochActive = false;
    this.searchLandingEpochOrigin = undefined;
  }
  private async navigateHistoryJump(
    page: number,
    cause: NavigationCause,
    searchEpoch?: number,
    point?: { readonly x: number; readonly y: number },
    ownerGuard: () => boolean = () => true,
  ): Promise<PdfTabNavigationDecision> {
    if (!this.historyHealthy) return { kind: "unavailable" };
    const liveOrigin = this.captureNavigationSnapshot();
    const reader = this.reader.snapshot;
    if (liveOrigin === undefined || !Number.isSafeInteger(page) || page < 1 || page > reader.pageCount) return { kind: "preflightRejected" };
    const preflightGuard = (): boolean => ownerGuard() && !this.closed && this.isForegroundActive();
    let target: NavigationSnapshot | undefined;
    if (point !== undefined) target = { pageIndex: page - 1, x: point.x, y: point.y };
    else {
      const transform = await this.viewTransformFor(page, preflightGuard);
      if (transform !== undefined) target = await this.pdfReader.getPageTopLanding(page, transform, preflightGuard);
    }
    if (target === undefined) return preflightGuard() ? { kind: "preflightRejected" } : { kind: "stale" };
    if (cause === "search" && this.searchLandingEpochOrigin === undefined) {
      return sameSnapshotWithinTolerance(liveOrigin, target)
        ? { kind: "noOp" }
        : this.restoreDisplayOnlyLanding(liveOrigin, target, ownerGuard);
    }
    const historyOrigin = cause === "search" ? this.searchLandingEpochOrigin! : liveOrigin;
    this.navigationHistory.cancelPending();
    const prepared = this.navigationHistory.prepareJump(historyOrigin, target, cause, searchEpoch);
    if (prepared.kind === "search-epoch-recorded") return this.restoreDisplayOnlyLanding(liveOrigin, target, ownerGuard);
    if (prepared.kind === "same-location") {
      return cause === "search" && !sameSnapshotWithinTolerance(liveOrigin, target)
        ? this.restoreDisplayOnlyLanding(liveOrigin, target, ownerGuard)
        : { kind: "noOp" };
    }
    if (prepared.kind !== "prepared") return { kind: prepared.kind };
    return this.restoreHistoryTransaction(prepared.transaction, ownerGuard, liveOrigin, point === undefined ? "page-top" : "center");
  }
  private async navigateHistoryTraversal(direction: "back" | "forward"): Promise<PdfTabNavigationDecision> {
    if (!this.historyHealthy) return { kind: "unavailable" };
    const liveOrigin = this.captureNavigationSnapshot();
    if (liveOrigin === undefined) return { kind: "unavailable" };
    this.navigationHistory.cancelPending();
    const transaction = direction === "back" ? this.navigationHistory.prepareBack(liveOrigin) : this.navigationHistory.prepareForward(liveOrigin);
    if (transaction === undefined) return { kind: "unavailable" };
    return this.restoreHistoryTransaction(transaction);
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
    ownerGuard: () => boolean = () => true,
    compensationOrigin: NavigationSnapshot = transaction.origin,
    placement: "center" | "page-top" = "center",
  ): Promise<PdfTabNavigationDecision> {
    const intent = this.supersedeNavigation();
    const activityGeneration = this.activityGeneration;
    const guard = (): boolean => ownerGuard() && !this.closed && this.isForegroundActive()
      && this.navigationIntent === intent && this.activityGeneration === activityGeneration;
    const outcome = await this.restoreCanonicalLanding(transaction.target, guard, placement);
    if ((outcome.kind === "verified" || outcome.kind === "constrainedEdgeVerified") && guard()) {
      const verificationTarget = outcome.kind === "constrainedEdgeVerified" ? outcome.expected : transaction.target;
      const result = this.navigationHistory.commit(transaction, outcome.landing, verificationTarget);
      if (result === "committed" && transaction.cause !== "search") this.endSearchLandingEpoch();
      return { kind: result === "committed" ? "verifiedLanding" : result === "same-location" ? "noOp" : result };
    }
    this.navigationHistory.rollback(transaction);
    if (outcome.kind === "preflightRejected") return { kind: "preflightRejected" };
    if (outcome.kind === "staleOrCancelled" || !guard()) return { kind: "stale" };
    const compensated = await this.restoreCanonicalLanding(compensationOrigin, guard);
    if (compensated.kind === "staleOrCancelled" || !guard()) return { kind: "stale" };
    if (compensated.kind !== "verified" && compensated.kind !== "constrainedEdgeVerified") this.historyHealthy = false;
    return { kind: compensated.kind === "verified" || compensated.kind === "constrainedEdgeVerified"
      ? "compensatedFailure"
      : "uncompensatedInvariantFailure" };
  }
  private async restoreDisplayOnlyLanding(origin: NavigationSnapshot, target: NavigationSnapshot, ownerGuard: () => boolean): Promise<PdfTabNavigationDecision> {
    const intent = this.supersedeNavigation();
    const activityGeneration = this.activityGeneration;
    const guard = (): boolean => ownerGuard() && !this.closed && this.isForegroundActive()
      && this.navigationIntent === intent && this.activityGeneration === activityGeneration;
    const outcome = await this.restoreCanonicalLanding(target, guard);
    if ((outcome.kind === "verified" || outcome.kind === "constrainedEdgeVerified") && guard()) return { kind: "verifiedLanding" };
    if (outcome.kind === "preflightRejected") return { kind: "preflightRejected" };
    if (outcome.kind === "staleOrCancelled" || !guard()) return { kind: "stale" };
    const compensated = await this.restoreCanonicalLanding(origin, guard);
    if (compensated.kind === "staleOrCancelled" || !guard()) return { kind: "stale" };
    if (compensated.kind !== "verified" && compensated.kind !== "constrainedEdgeVerified") this.historyHealthy = false;
    return { kind: compensated.kind === "verified" || compensated.kind === "constrainedEdgeVerified"
      ? "compensatedFailure"
      : "uncompensatedInvariantFailure" };
  }
  private captureNavigationSnapshot(): NavigationSnapshot | undefined {
    if (!this.reader.snapshot.hasDocument) return undefined;
    return this.pdfReader.captureViewportLanding();
  }
  private async restorePresentation(activityGeneration: number): Promise<void> {
    const rendered = await this.renderCurrentView();
    if (this.closed || !this.isForegroundActive() || this.activityGeneration !== activityGeneration) return;
    if (!rendered) throw new Error("PDF_PRESENTATION_RESTORE_FAILED");
    await this.content?.restoreEvictedSearch();
    if (this.closed || !this.isForegroundActive() || this.activityGeneration !== activityGeneration) return;
    this.presentationEvicted = false;
    this.presentationDirty = false;
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
      const size = await this.pdfReader.getPageNaturalSize(page, rotation, guard);
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

  private createContent(session: Pick<OpenPdfResult, "sessionId" | "documentGeneration">, ownerGeneration: number): PdfContentController {
    return new PdfContentController({ ...this.options.createContentOptions(session, ownerGeneration, this.reader), host: this.options.canvasHost, resources: this.options.resources, onStatus: (status) => this.setStatus(status) });
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

  private supersedeNavigation(): number {
    this.content?.cancelDestination();
    return ++this.navigationIntent;
  }

  private async renderOpeningFitPage(): Promise<void> {
    const rendered = await this.renderCurrentView();
    if (!rendered && this.isForegroundActive()) throw new Error("PDF_PRESENTATION_RESTORE_FAILED");
  }

  private recoverFailedPresentation(intent: number, activityGeneration: number, failureStatus?: string): void {
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
    this.reader.restoreView({ zoomMode: snapshot.zoomMode, customScale: transform.scale, rotationQuarterTurns: ((transform.rotation / 90) % 4 + 4) % 4 });
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
      devicePixelRatio: Math.min(2, transform.devicePixelRatio),
    };
    this.pendingRenderRollback = undefined;
    this.options.onStatus?.(this.reader.snapshot.status);
    if (this.openingFitRenderPending && !this.openingFitRenderInFlight) {
      this.openingFitRenderInFlight = true;
      const intent = ++this.renderIntent;
      this.pendingRenderRollback = { intent, activityGeneration: this.activityGeneration, ...this.lastCommittedRender };
      const documentGeneration = committed.documentGeneration;
      void this.renderOpeningFitPage().catch((error: unknown) => { if (!isAuthorityIncomplete(error)) this.setStatus("PDF presentation could not be updated."); }).finally(() => {
        if (this.reader.snapshot.documentGeneration === documentGeneration) this.openingFitRenderInFlight = false;
      });
    }
  }

  private setReaderStatus(status: string): void {
    this.readerStatusVersion += 1;
    this.setStatus(status);
  }
  private setStatus(status: string): void { this.reader.setStatus(status); this.options.onStatus?.(status); }
}
