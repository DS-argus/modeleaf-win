import { ReaderState, type ReaderSnapshot } from "../core/ReaderState";
import {
  PdfContentController,
  normalizePdfSearchQuery,
  type PdfContentControllerOptions,
  type PdfContentSnapshot,
} from "./PdfContentController";
import { resolvePdfDestinationView } from "./PdfDestination";
import {
  PdfReaderController,
  type OpenPdfResult,
  type PdfBoundary,
  type PdfReaderControllerOptions,
  type PdfViewTransform,
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
  readonly requestPassword: PdfReaderControllerOptions["requestPassword"];
  readonly createContentOptions: (
    session: Pick<OpenPdfResult, "sessionId" | "documentGeneration">,
    ownerGeneration: number,
    reader: ReaderState,
  ) => Omit<PdfContentControllerOptions, "host" | "resources" | "onStatus">;
  readonly onStatus?: (status: string) => void;
}

export type PdfTabSearchDecision =
  | { readonly kind: "ignore" }
  | { readonly kind: "cycle"; readonly reverse: boolean }
  | { readonly kind: "search"; readonly query: string };

export function decidePdfTabSearch(
  snapshot: Pick<PdfContentSnapshot, "query" | "results" | "searchPending" | "searchIncomplete">,
  source: string,
  reverse = false,
): PdfTabSearchDecision {
  if (snapshot.searchPending || snapshot.searchIncomplete) return { kind: "ignore" };
  const query = normalizePdfSearchQuery(source);
  if (query !== snapshot.query || snapshot.results.length === 0) return { kind: "search", query };
  return { kind: "cycle", reverse };
}

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
  private openingFitRenderPending = false;
  private openingFitRenderInFlight = false;
  private activityGeneration = 0;
  private renderIntent = 0;
  private pendingPresentationRenders = 0;
  private readerStatusVersion = 0;
  private navigationIntent = 0;
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
      requestPassword: options.requestPassword,
      onStatus: (status) => this.setReaderStatus(status),
      onPage: (page, transform) => this.onPage(page, transform),
      onCommitted: (pageCount, displayName) => {
        this.title = displayName;
        this.lastCommittedRender = undefined;
        this.reader.mountDocument(pageCount);
        this.openingFitRenderPending = true;
        this.openingFitRenderInFlight = false;
        this.navigationIntent += 1;
      },
      onBeforeCommit: async (rendered, commitCanvas, context) => {
        if (context.opening) {
          const content = this.createContent(context.session, context.ownerGeneration);
          const key = this.contentKey(context.session);
          this.contentBySession.set(key, content);
          content.mount(context.document, this.reader.snapshot.documentGeneration + 1, context.session.sessionId);
          context.registerStagedTeardown(async () => { await this.disposeContent(context.session, content); });
          const commit = (accessory?: HTMLElement): boolean => {
            const previous = this.content;
            this.content = content;
            const committed = commitCanvas(accessory);
            if (!committed) this.content = previous;
            return committed;
          };
          await content.renderPage({ ...rendered, commitCanvas: commit });
          return;
        }
        await this.content?.renderPage({ ...rendered, commitCanvas });
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
        searchPending: false, searchIncomplete: false, hintsVisible: false,
      },
    };
  }

  public async adopt(session: OpenPdfResult, ownerGeneration: number): Promise<true> {
    if (this.closed) throw new Error("PDF_ADOPTION_NOT_COMMITTED");
    return this.pdfReader.adopt(session, ownerGeneration);
  }
  public async printCurrent(): Promise<boolean> {
    return this.closed || !this.active ? false : this.pdfReader.printCurrent();
  }
  public async activate(): Promise<void> {
    if (this.closed || this.active) return;
    this.active = true;
    this.foregroundSuspended = false;
    const activityGeneration = ++this.activityGeneration;
    if (this.openingFitRenderPending) {
      await this.renderOpeningFitPage();
      return;
    }
    const needsPresentationRestore = this.presentationEvicted || this.presentationDirty || this.committedDevicePixelRatioDiffers();
    if (needsPresentationRestore) await this.restorePresentation(activityGeneration);
    else await this.restoreInterruptedSearch(activityGeneration);
  }
  public async deactivate(): Promise<void> {
    if (this.closed) return;
    if (this.pendingPresentationRenders > 0) this.presentationDirty = true;
    this.active = false;
    this.foregroundSuspended = false;
    this.activityGeneration += 1;
    this.content?.suspend();
    await this.pdfReader.suspend();
    this.foregroundSuspended = true;
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
      await this.pdfReader.dispose();
      this.content = undefined;
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
    if (this.closed || !this.active) return false;
    const statusVersion = this.readerStatusVersion;
    this.pendingPresentationRenders += 1;
    try {
      const activityGeneration = this.activityGeneration;
      const intent = this.renderIntent;
      const navigationIntent = this.navigationIntent;
      const guard = (): boolean => !this.closed && this.active && this.activityGeneration === activityGeneration
        && this.navigationIntent === navigationIntent;
      const effectiveTransform = transform ?? await this.viewTransformFor(page, guard);
      if (effectiveTransform === undefined) {
        if (guard()) this.rollbackPendingRender(intent, activityGeneration);
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
          this.rollbackPendingRender(intent, activityGeneration, failureStatus);
        } else {
          this.presentationDirty = true;
        }
      }
      return committed;
    } finally {
      this.pendingPresentationRenders -= 1;
    }
  }

  public async activateViewportPage(page: number): Promise<boolean> {
    if (this.closed || !this.active || !Number.isInteger(page)) return false;
    if (page === this.reader.snapshot.page) return true;
    this.apply({ type: "page.goTo", page });
    return this.renderPage(this.reader.snapshot.page);
  }
  public submitSearch(source: string, reverse = false): PdfTabSearchDecision {
    if (this.closed || !this.active) return { kind: "ignore" };
    const content = this.content;
    if (content === undefined) return { kind: "ignore" };
    const decision = decidePdfTabSearch(content.snapshot, source, reverse);
    if (decision.kind === "cycle") content.nextMatch(decision.reverse);
    if (decision.kind === "search") void content.search(decision.query);
    return decision;
  }

  public apply(action: Parameters<ReaderState["apply"]>[0]): void {
    if (this.closed || !this.active) return;
    if (action.type.startsWith("page.") || action.type.startsWith("view.") || action.type.startsWith("scroll.")) {
      this.supersedeNavigation();
      const snapshot = this.lastCommittedRender;
      if (snapshot !== undefined && snapshot.documentGeneration === this.reader.snapshot.documentGeneration) {
        const intent = ++this.renderIntent;
        this.pendingRenderRollback = { intent, activityGeneration: this.activityGeneration, ...snapshot };
      }
    }
    this.reader.apply(action);
  }
  public nextMatch(reverse: boolean): void { if (!this.closed && this.active) this.content?.nextMatch(reverse); }
  public toggleHints(): void { if (!this.closed && this.active) this.content?.toggleHints(); }
  public cancelHints(): void { if (!this.closed && this.active) this.content?.cancelHints(); }
  public handleHintKey(key: string): boolean { return !this.closed && this.active && this.content?.handleHintKey(key) === true; }
  public invalidateSearch(): void { if (!this.closed && this.active) this.content?.invalidateSearch(); }
  public get query(): string { return this.content?.snapshot.query ?? ""; }
  public get hintsVisible(): boolean { return this.content?.snapshot.hintsVisible ?? false; }
  public async renderCurrentView(): Promise<boolean> {
    const rendered = await this.renderPage(this.reader.snapshot.page);
    if (rendered && this.openingFitRenderPending) this.openingFitRenderPending = false;
    return rendered;
  }

  public async navigateToDestination(page: number, destination: readonly unknown[]): Promise<void> {
    if (this.closed || !this.active) return;
    const content = this.content;
    if (content === undefined) return;
    const navigationIntent = this.supersedeNavigation();
    const activityGeneration = this.activityGeneration;
    const guard = (): boolean => !this.closed && this.active && this.activityGeneration === activityGeneration
      && this.navigationIntent === navigationIntent;
    const snapshot = this.reader.snapshot;
    const targetSize = await this.pdfReader.getPageNaturalSize(page, snapshot.rotationQuarterTurns * 90, guard);
    if (!guard()) return;
    const view = resolvePdfDestinationView(destination, snapshot.customScale, targetSize,
      this.availableContentSize(), snapshot.rotationQuarterTurns,
      (scale) => Math.max(0.1, Math.min(8, scale)));
    if (view === undefined || !guard()) return;
    const rollbackSnapshot = this.lastCommittedRender;
    if (rollbackSnapshot === undefined || rollbackSnapshot.documentGeneration !== this.reader.snapshot.documentGeneration) return;
    const intentId = content.queueDestination(page, destination);
    if (intentId === undefined || !guard()) {
      if (intentId !== undefined) content.cancelDestination(intentId);
      return;
    }
    const renderIntent = ++this.renderIntent;
    this.pendingRenderRollback = { intent: renderIntent, activityGeneration, ...rollbackSnapshot };
    this.reader.apply({ type: "page.goTo", page });
    this.reader.restoreView({ zoomMode: view.zoomMode, customScale: view.scale, rotationQuarterTurns: snapshot.rotationQuarterTurns });
    const committed = await this.renderPage(page, { scale: view.scale, rotation: snapshot.rotationQuarterTurns * 90, devicePixelRatio: this.devicePixelRatio() });
    if (!committed) content.cancelDestination(intentId);
  }

  public async search(query: string): Promise<void> { if (!this.closed && this.active) await this.content?.search(query); }

  private async restorePresentation(activityGeneration: number): Promise<void> {
    const rendered = await this.renderCurrentView();
    if (!rendered || this.closed || !this.active || this.activityGeneration !== activityGeneration) return;
    if (this.presentationEvicted) await this.content?.restoreEvictedSearch();
    if (this.closed || !this.active || this.activityGeneration !== activityGeneration) return;
    this.presentationEvicted = false;
    this.presentationDirty = false;
  }
  private async restoreInterruptedSearch(activityGeneration: number): Promise<void> {
    await this.content?.restoreEvictedSearch();
    if (this.closed || !this.active || this.activityGeneration !== activityGeneration) return;
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
    await this.renderCurrentView();
  }

  private rollbackPendingRender(intent: number, activityGeneration: number, failureStatus?: string): void {
    const rollback = this.pendingRenderRollback;
    if (rollback === undefined || rollback.intent !== intent || rollback.activityGeneration !== activityGeneration
      || rollback.activityGeneration !== this.activityGeneration || rollback.documentGeneration !== this.reader.snapshot.documentGeneration
      || this.closed || !this.active) return;
    this.reader.apply({ type: "page.goTo", page: rollback.page });
    this.reader.restoreView(rollback);
    this.pendingRenderRollback = undefined;
    if (failureStatus !== undefined) this.setStatus(failureStatus);
  }

  private onPage(page: number, transform: PdfViewTransform): void {
    const snapshot = this.reader.snapshot;
    this.reader.apply({ type: "page.goTo", page });
    this.reader.restoreView({ zoomMode: snapshot.zoomMode, customScale: transform.scale, rotationQuarterTurns: ((transform.rotation / 90) % 4 + 4) % 4 });
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
      void this.renderOpeningFitPage().finally(() => {
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
