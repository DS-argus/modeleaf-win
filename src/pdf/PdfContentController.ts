import { TextLayer } from "pdfjs-dist";
import {
  RESOURCE_LIMITS,
  type ResourceReservation,
  ResourceReservationManager,
} from "./ResourceBudget";
import { isValidPdfDestination } from "./PdfDestination";

export interface PdfContentTextItem {
  readonly str?: string;
  readonly hasEOL?: boolean;
  readonly fontName?: string;
  readonly [key: string]: unknown;
}

export interface PdfContentTextContent {
  readonly items: readonly PdfContentTextItem[];
  readonly styles?: Readonly<Record<string, unknown>>;
  readonly lang?: string;
}

export interface PdfContentAnnotation {
  readonly subtype?: string;
  readonly rect?: readonly number[];
  readonly url?: string;
  readonly id?: string;
  readonly dest?: unknown;
  readonly action?: string;
  readonly color?: readonly number[] | Uint8ClampedArray;
  readonly borderStyle?: {
    readonly width?: number;
    readonly style?: number;
  };
}

export interface PdfContentPage {
  getTextContent(): Promise<PdfContentTextContent>;
  streamTextContent?(): ReadableStream<PdfContentTextContent>;
  getAnnotations(): Promise<readonly PdfContentAnnotation[]>;
}

export interface PdfContentDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfContentPage>;
  getDestination?(name: string): Promise<unknown>;
  getPageIndex?(reference: unknown): Promise<number>;
}

export interface PdfContentViewport {
  readonly width: number;
  readonly scale: number;
  readonly height: number;
  readonly rotation: number;
  readonly rawDims: {
    readonly pageWidth: number;
    readonly pageHeight: number;
  };
  convertToViewportPoint(x: number, y: number): readonly [number, number];
  convertToPdfPoint(x: number, y: number): readonly [number, number];
}

export interface PdfContentRenderRequest {
  readonly pageNumber: number;
  readonly page: PdfContentPage;
  readonly viewport: PdfContentViewport;
  readonly canvas: HTMLCanvasElement;
  readonly retainedPages?: readonly number[];
  readonly commitCanvas?: (accessory?: HTMLElement) => boolean;
}

export interface PdfExternalLinkRegistration {
  readonly annotationId: string;
  readonly target: string;
}

export interface PdfContentControllerOptions {
  readonly host: HTMLElement;
  readonly resources: ResourceReservationManager;
  readonly onStatus: (message: string) => void;
  readonly navigateToPage: (pageNumber: number) => void;
  readonly navigateToDestination: (pageNumber: number, destination: readonly unknown[]) => void;
  readonly prepareExternalLinks: (
    entries: readonly PdfExternalLinkRegistration[],
    registryRevision: number,
  ) => Promise<void>;
  readonly commitExternalLinks: (registryRevision: number) => Promise<void>;
  readonly finalizeExternalLinks: (registryRevision: number) => Promise<void>;
  readonly abortExternalLinks: (registryRevision: number) => Promise<void>;
  readonly openExternal: (annotationId: string, registryRevision: number, activationOperationId: string, operationSequence: number) => Promise<void>;
}

export interface PdfSearchResult {
  readonly pageNumber: number;
  readonly index: number;
  readonly length: number;
}

export interface PdfContentSnapshot {
  readonly generation: number | null;
  readonly pageNumber: number | null;
  readonly query: string;
  readonly results: readonly PdfSearchResult[];
  readonly currentResult: number;
  readonly searchPending: boolean;
  readonly searchIncomplete: boolean;
  readonly hintsVisible: boolean;
}

interface ResidentContentEntry {
  readonly pageNumber: number;
  readonly layer: HTMLElement;
  readonly textLayer: HTMLElement;
  readonly annotationLayer: HTMLElement;
  readonly viewport: PdfContentViewport;
  readonly canvas: HTMLCanvasElement;
  readonly reservation: ResourceReservation;
  readonly hintGroups: LinkGroup[];
  readonly renderSequence: number;
}

interface LinkGroup {
  readonly key: string;
  readonly annotation: PdfContentAnnotation;
  readonly annotationId: string;
  readonly renderSequence: number;
  registryRevision: number | undefined;
  readonly rectangles: readonly DOMRect[];
}

interface RegistryPublication {
  readonly revision: number;
  readonly staged: Promise<void>;
  commit(): Promise<void>;
  finalize(): Promise<void>;
  readonly settlement: Promise<void>;
  rollback(): Promise<void>;
}
export interface PdfResidentAuthorityTransaction {
  rollback(): Promise<void>;
  finalize(): void;
}
interface DeferredRegistryCleanup {
  readonly revision: number;
  readonly operation: Promise<void>;
  abortSettlement: Promise<void> | undefined;
}
interface PublishedRegistryFinalizer {
  readonly revision: number;
  state: "pending" | "succeeded" | "failed" | "skipped";
  settlement: Promise<void> | undefined;
  reason: unknown;
}
const MAX_RESULTS = 10_000;
const SEARCH_HIGHLIGHT_NAME = "modeleaf-pdf-search-hits";
const CURRENT_SEARCH_HIGHLIGHT_NAME = "modeleaf-pdf-search-current";
type HighlightRegistry = {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
};
type IndexedTextNode = {
  readonly node: Text | HTMLBRElement;
  readonly start: number;
  readonly end: number;
};
type ExactSearchRange = {
  readonly range: Range;
  readonly anchor: HTMLElement | null;
};
const SEARCH_TIMEOUT_MS = 30_000;
const LINK_ACTIVATION_TIMEOUT_MS = 10_000;
const INTERNAL_DESTINATION_RESOLUTION_TIMEOUT_MS = 10_000;
const MAX_LINK_ANNOTATIONS = 256;
const externalFailureTag = (error: unknown): string | undefined => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return typeof error === "object" && error !== null && "tag" in error && typeof error.tag === "string"
    ? error.tag
    : undefined;
};
const isExternalLaunchTimeout = (error: unknown): boolean => externalFailureTag(error) === "LINK_LAUNCH_TIMEOUT";
const isExternalDispatchExpired = (error: unknown): boolean => externalFailureTag(error) === "LINK_DISPATCH_EXPIRED";
export const addPdfTextUtf8Bytes = (
  current: number,
  source: string,
  limit = RESOURCE_LIMITS.maxTextPageBytes,
): number | undefined => {
  const amount = encoder.encode(source).byteLength;
  return Number.isSafeInteger(current)
    && current >= 0
    && Number.isSafeInteger(limit)
    && limit >= 0
    && current <= limit - amount
    ? current + amount
    : undefined;
};
const hintAlphabet = "ASDFGHJKLQWERTYUIOPZXCVBNM";
const assertDeadline = (deadline: number, message = "Search timed out."): void => {
  if (Date.now() >= deadline) throw new Error(message);
};
const encoder = new TextEncoder();
const appendBoundedText = (
  chunks: string[],
  content: PdfContentTextContent,
  pageBytes: { value: number },
  documentBytes: { value: number },
  itemCount: { value: number },
  deadline?: number,
): void => {
  for (const item of content.items) {
    if (deadline !== undefined) assertDeadline(deadline);
    if (itemCount.value >= 100_000) throw new Error("TEXT_LIMIT");
    itemCount.value += 1;
    if (typeof item.str !== "string") continue;
    const value = item.hasEOL ? `${item.str}\n` : item.str;
    const nextPageBytes = addPdfTextUtf8Bytes(pageBytes.value, value);
    const nextDocumentBytes = addPdfTextUtf8Bytes(documentBytes.value, value, RESOURCE_LIMITS.maxTextDocumentBytes);
    if (nextPageBytes === undefined || nextDocumentBytes === undefined) throw new Error("TEXT_LIMIT");
    pageBytes.value = nextPageBytes;
    documentBytes.value = nextDocumentBytes;
    if (value.length > 0) chunks.push(value);
  }
};

export const normalizePdfSearchQuery = (source: string): string => {
  const values: string[] = [];
  const trimmed = source.trim();
  for (let index = 0; index < trimmed.length;) {
    const codePoint = trimmed.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    values.push(character.toLowerCase());
    index += character.length;
  }
  return values.join("");
};

const foldLiteral = (source: string, deadline?: number): {
  readonly value: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
} => {
  const values: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < source.length;) {
    if (deadline !== undefined) assertDeadline(deadline);
    const codePoint = source.codePointAt(index)!;
    const original = String.fromCodePoint(codePoint);
    const folded = original.toLowerCase();
    values.push(folded);
    for (let foldedIndex = 0; foldedIndex < folded.length; foldedIndex += 1) {
      starts.push(index);
      ends.push(index + original.length);
    }
    index += original.length;
  }
  return { value: values.join(""), starts, ends };
};
const isExternalUrl = (value: string): boolean => {
  if (
    value.length === 0
    || value.length > 8_192
    || encoder.encode(value).byteLength > 8_192
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) return false;
  try {
    const parsed = new URL(value);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:") {
      const separator = value.indexOf(":");
      const remainder = separator < 0 ? "" : value.slice(separator + 1);
      const authority = remainder.startsWith("//")
        ? remainder.slice(2).split(/[/?#]/u, 1)[0] ?? ""
        : "";
      return parsed.host.length > 0
        && parsed.username.length === 0
        && parsed.password.length === 0
        && !authority.includes("@");
    }
    return false;
  } catch {
    return false;
  }
};

/** Renders the selectable PDF content that is deliberately kept outside the raster canvas. */
export class PdfContentController {
  private document: PdfContentDocument | undefined;
  private generation: number | undefined;
  private readonly residentEntries = new Map<number, ResidentContentEntry>();
  private externalEntriesByPage = new Map<number, readonly PdfExternalLinkRegistration[]>();
  private layer: HTMLElement | undefined;
  private textLayer: HTMLElement | undefined;
  private renderedPage: number | undefined;
  private renderedViewport: PdfContentViewport | undefined;
  private renderedCanvas: HTMLCanvasElement | undefined;
  private pendingDestination: {
    readonly document: PdfContentDocument;
    readonly generation: number;
    readonly pageNumber: number;
    readonly intentId: number;
    readonly preservedPoint: readonly [number, number] | undefined;
    readonly destination: readonly unknown[];
  } | undefined;
  private destinationSequence = 0;
  private linkActivationSequence = 0;
  private renderSequence = 0;
  private internalDestinationActivation: Promise<void> | undefined;
  private renderedSequence: number | undefined;
  private sessionId: string | undefined;
  private visibleTextReservation: ResourceReservation | undefined;
  private pendingTextReservation: ResourceReservation | undefined;
  private pendingRenderSettlement: Promise<void> | undefined;
  private pendingTextRenderer: TextLayer | undefined;
  private registryRevision = 0;
  private registryPublication: Promise<void> = Promise.resolve();
  private searchSequence = 0;
  private query = "";
  private results: PdfSearchResult[] = [];
  private resultReservations: ResourceReservation[] = [];
  private currentResult = -1;
  private evictedPage: number | undefined;
  private evictedCurrentResult: number | undefined;
  private searchIncomplete = false;
  private searchPending = false;
  private activeSearchSettlement: Promise<void> | undefined;
  private activeTextReader: ReadableStreamDefaultReader<PdfContentTextContent> | undefined;
  private readonly textReaderCancellation = new WeakMap<ReadableStreamDefaultReader<PdfContentTextContent>, Promise<void>>();
  private unsettledSearchCleanup: Promise<void> | undefined;
  private searchCleanupFailure: {
    readonly document: PdfContentDocument;
    readonly generation: number;
    readonly message: string;
  } | undefined;
  private partialSearchReason: string | undefined;
  private hintsVisible = false;
  private interactionsEnabled = true;
  private registryQuarantined: { readonly revision: number; readonly reason: unknown } | undefined;
  private readonly publishedRegistryFinalizers = new Map<number, PublishedRegistryFinalizer>();
  private unsettledVisibleTextCleanup: Promise<void> | undefined;
  private hintGroups: LinkGroup[] = [];
  private hintInput = "";
  private readonly linkActivationSettlements = new Set<Promise<void>>();
  private readonly deferredRegistryCleanups = new Map<number, DeferredRegistryCleanup>();
  private mountedEpoch = 0;
  private closingEpoch: number | undefined;

  public constructor(private readonly options: PdfContentControllerOptions) {}

  public get snapshot(): PdfContentSnapshot {
    return {
      pageNumber: this.renderedPage ?? this.evictedPage ?? null,
      query: this.query,
      generation: this.generation ?? null,
      results: [...this.results],
      currentResult: this.currentResult,
      searchPending: this.searchPending,
      searchIncomplete: this.searchIncomplete,
      hintsVisible: this.hintsVisible,
    };
  }

  public mount(document: PdfContentDocument, generation: number, sessionId: string): void {
    void this.unmount().catch(() => undefined);
    this.mountedEpoch += 1;
    this.closingEpoch = undefined;
    this.interactionsEnabled = true;
    this.document = document;
    this.generation = generation;
    this.sessionId = sessionId;
    this.query = "";
    this.results = [];
    this.searchPending = false;
    this.currentResult = -1;
    this.pendingDestination = undefined;
    this.searchCleanupFailure = undefined;
    this.partialSearchReason = undefined;
    this.evictedPage = undefined;
    this.evictedCurrentResult = undefined;
  }

  /** Cancels foreground rendering/search while retaining completed search state. */
  public suspend(): void {
    this.interactionsEnabled = false;
    this.renderSequence += 1;
    this.searchSequence += 1;
    if (this.activeSearchSettlement !== undefined && this.query.length > 0) {
      this.releaseResultReservations();
      this.results = [];
      this.currentResult = -1;
      if (this.evictedCurrentResult === undefined) this.evictedCurrentResult = 0;
      this.searchIncomplete = true;
    }
    this.searchPending = false;
    this.cancelDestination();
    this.cancelActiveSearch();
    if (typeof this.pendingTextRenderer?.cancel === "function") this.pendingTextRenderer.cancel();
  }

  public resumeInteractions(): void {
    if (!this.isClosing() && this.document !== undefined) this.interactionsEnabled = true;
  }
  /** Releases published inactive-tab content only after its foreground work has settled. */
  public evictInactiveHeavyResources(): boolean {
    let evicted = false;
    if (this.pendingRenderSettlement === undefined && this.pendingTextReservation === undefined && this.unsettledVisibleTextCleanup === undefined) {
      this.evictedPage = this.renderedPage ?? this.evictedPage;
      this.clearRenderedContent();
      evicted = true;
    }
    if (this.activeSearchSettlement === undefined && this.activeTextReader === undefined && this.unsettledSearchCleanup === undefined && this.results.length > 0) {
      this.evictedCurrentResult = this.currentResult;
      this.releaseResultReservations();
      this.results = [];
      this.currentResult = -1;
      evicted = true;
    }
    return evicted;
  }

  /** Recomputes results evicted or interrupted while the tab was inactive. */
  public async restoreEvictedSearch(): Promise<void> {
    if ((this.evictedCurrentResult === undefined && !this.searchIncomplete) || this.query.length === 0 || this.searchPending) return;
    await this.search(this.query, true);
  }

  public async unmount(): Promise<void> {
    this.closingEpoch = this.mountedEpoch;
    const document = this.document;
    const generation = this.generation;
    const sessionId = this.sessionId;
    const deadline = Date.now() + SEARCH_TIMEOUT_MS;
    const deferredRegistryCleanups = this.retryDeferredRegistryCleanups();
    const pendingFinalizers = [...this.publishedRegistryFinalizers.values()]
      .filter((finalizer) => finalizer.state === "pending")
      .map((finalizer) => finalizer.settlement)
      .filter((settlement): settlement is Promise<void> => settlement !== undefined);
    const settlements = [...new Set([
      this.pendingRenderSettlement,
      this.activeSearchSettlement,
      this.unsettledSearchCleanup,
      this.unsettledVisibleTextCleanup,
      this.internalDestinationActivation,
      ...this.linkActivationSettlements,
      this.registryPublication,
      ...pendingFinalizers,
      ...deferredRegistryCleanups,
    ].filter((settlement): settlement is Promise<void> => settlement !== undefined))];
    this.cancelDestination();
    this.cancelActiveSearch();
    if (typeof this.pendingTextRenderer?.cancel === "function") this.pendingTextRenderer.cancel();
      this.searchIncomplete = false;
    this.renderSequence += 1;
    this.searchSequence += 1;
    this.linkActivationSequence += 1;
    const outcomes = await Promise.allSettled(settlements.map((settlement) => this.withDeadline(
      settlement,
      Math.max(1, deadline - Date.now()),
      "PDF cleanup pending.",
    )));
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    const publishedFailure = this.registryQuarantined !== undefined
      && this.hasTerminalPublishedRegistryFinalizer(this.registryQuarantined.revision);
    const cleanupPending = rejected !== undefined || (this.registryQuarantined !== undefined && !publishedFailure);
    const reason = rejected?.reason ?? this.registryQuarantined?.reason;
    if (cleanupPending) {
      this.options.onStatus(`PDF cleanup pending: ${reason instanceof Error ? reason.message : String(reason)}`);
      throw new Error("PDF cleanup pending.");
    }
    if (
      this.document === document
      && this.generation === generation
      && this.sessionId === sessionId
    ) {
      this.searchPending = false;
      this.query = "";
      this.results = [];
      this.currentResult = -1;
      this.searchCleanupFailure = undefined;
      this.partialSearchReason = undefined;
      this.clearRenderedContent();
      this.releaseResultReservations();
      this.document = undefined;
      this.generation = undefined;
      this.sessionId = undefined;
      this.registryQuarantined = undefined;
      this.publishedRegistryFinalizers.clear();
    }
  }
  public async renderPage(request: PdfContentRenderRequest): Promise<void> {
    const generation = this.generation;
    const document = this.document;
    const sessionId = this.sessionId;
    if (generation === undefined || document === undefined || sessionId === undefined || this.isClosing()) return;
    if (!this.options.host.contains(request.canvas) && request.commitCanvas === undefined) return;
    const sequence = ++this.renderSequence;
    const deadline = Date.now() + SEARCH_TIMEOUT_MS;
    if (typeof this.pendingTextRenderer?.cancel === "function") this.pendingTextRenderer.cancel();
    const previous = this.pendingRenderSettlement;
    if (previous !== undefined) {
      try {
        await this.withDeadline(previous, SEARCH_TIMEOUT_MS);
      } catch {
        if (!this.isCurrent(generation, document) || sequence !== this.renderSequence) return;
        throw new Error("Overlay replacement timed out.");
      }
    }
    if (!this.isCurrent(generation, document) || sequence !== this.renderSequence) return;
    const reserved = this.options.resources.reserve({
      kind: "text-page-bytes",
      amount: RESOURCE_LIMITS.maxTextPageBytes,
      sessionId,
    });
    if (!reserved.ok) throw new Error(reserved.tag);
    this.pendingTextReservation = reserved.reservation;
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => { resolveSettlement = resolve; });
    let published = false;
    this.pendingRenderSettlement = settlement;
    let ownsReservation = true;
    let renderer: TextLayer | undefined;
    let registryPublication: RegistryPublication | undefined;
    let deferredOwnership: Promise<void> | undefined;
    const awaitOwned = async <T>(operation: Promise<T>, milliseconds: number): Promise<T> => {
      let settled = false;
      const tracked = operation.finally(() => { settled = true; });
      try {
        return await this.withDeadline(tracked, milliseconds);
      } catch (error) {
        if (!settled) deferredOwnership = tracked.then(() => undefined, () => undefined);
        throw error;
      }
    };
    try {
      const [contentResult, annotationsResult] = await awaitOwned(
        Promise.allSettled([
          request.page.streamTextContent === undefined ? request.page.getTextContent() : this.readVisibleText(request.page, deadline),
          request.page.getAnnotations(),
        ]),
        Math.max(1, deadline - Date.now()),
      );
      if (annotationsResult.status === "rejected") throw annotationsResult.reason;
      if (contentResult.status === "rejected") throw contentResult.reason;
      const content = contentResult.value;
      const annotations = annotationsResult.value;
      const linkCount = annotations.reduce(
        (total, annotation) => total + (annotation.subtype === "Link" ? 1 : 0),
        0,
      );
      if (linkCount > MAX_LINK_ANNOTATIONS) throw new Error("LINK_CAPACITY");
      const pageBytes = { value: 0 };
      appendBoundedText([], content, pageBytes, { value: 0 }, { value: 0 }, deadline);
      assertDeadline(deadline);
      if (!this.isCurrent(generation, document) || sequence !== this.renderSequence) return;

      const externalEntries = annotations.flatMap((annotation, index) =>
        annotation.subtype === "Link" && typeof annotation.url === "string" && isExternalUrl(annotation.url)
          ? [{ annotationId: `page-${request.pageNumber}-render-${sequence}-annotation-${index}`, target: annotation.url }]
          : []);

      const layer = documentCreate("div", "pdf-content-layer");
      layer.style.position = "absolute";
      layer.style.width = `${request.viewport.width}px`;
      layer.style.height = `${request.viewport.height}px`;
      layer.style.pointerEvents = "none";
      layer.dataset.page = String(request.pageNumber);
      const textLayer = documentCreate("div", "textLayer");
      const annotationLayer = documentCreate("div", "annotationLayer");
      annotationLayer.style.position = "absolute";
      annotationLayer.style.inset = "0";
      annotationLayer.style.pointerEvents = "none";
      textLayer.style.position = "absolute";
      textLayer.style.inset = "0";
      textLayer.style.pointerEvents = "auto";
      textLayer.style.userSelect = "text";
      const totalScaleFactor = request.viewport.scale;
      textLayer.style.setProperty("--total-scale-factor", Number.isFinite(totalScaleFactor) && totalScaleFactor > 0 ? String(totalScaleFactor) : "1");
      textLayer.style.setProperty("--scale-round-x", "1px");
      textLayer.style.setProperty("--scale-round-y", "1px");
      renderer = new TextLayer({
        textContentSource: content as never,
        container: textLayer,
        viewport: request.viewport as never,
      });
      this.pendingTextRenderer = renderer;
      await awaitOwned(renderer.render(), Math.max(1, deadline - Date.now()));
      const rawWidth = request.viewport.rawDims.pageWidth * request.viewport.scale;
      const rawHeight = request.viewport.rawDims.pageHeight * request.viewport.scale;
      if (!Number.isFinite(rawWidth) || rawWidth <= 0 || !Number.isFinite(rawHeight) || rawHeight <= 0) {
        throw new Error("PDF_GEOMETRY_INVALID");
      }
      textLayer.style.width = `${request.viewport.width}px`;
      textLayer.style.height = `${request.viewport.height}px`;
      annotationLayer.style.width = `${request.viewport.width}px`;
      annotationLayer.style.height = `${request.viewport.height}px`;
      if (!this.isCurrent(generation, document) || sequence !== this.renderSequence) return;
      layer.append(textLayer, annotationLayer);
      const hintGroups = await awaitOwned(
        this.appendLinkGroups(annotationLayer, annotations, request.viewport, request.pageNumber, sequence, generation, document),
        Math.max(1, deadline - Date.now()),
      );
      if (!this.isCurrent(generation, document) || sequence !== this.renderSequence) return;

      const nextExternalEntries = new Map(this.externalEntriesByPage);
      const retainedPages = new Set(request.retainedPages ?? [...nextExternalEntries.keys(), request.pageNumber]);
      if (!retainedPages.has(request.pageNumber)) throw new Error("PDF_RESIDENT_PAGE_INVALID");
      nextExternalEntries.set(request.pageNumber, externalEntries);
      registryPublication = this.stageExternalLinks(
        [...nextExternalEntries].filter(([page]) => retainedPages.has(page)).flatMap(([, entries]) => entries),
        deadline,
      );
      await this.withDeadline(registryPublication.staged, Math.max(1, deadline - Date.now()));
      if (!this.isCurrent(generation, document) || sequence !== this.renderSequence) {
        await registryPublication.rollback();
        return;
      }
      await registryPublication.commit();
      if (!this.isCurrent(generation, document) || sequence !== this.renderSequence) {
        await registryPublication.rollback();
        return;
      }
      if (request.commitCanvas !== undefined) {
        if (!request.commitCanvas(layer)) {
          await registryPublication.rollback();
          return;
        }
      } else {
        this.options.host.replaceChildren(request.canvas, layer);
      }
      const presentationRoot = textLayer.closest<HTMLElement>(".pdf-page-frame") ?? layer;
      for (const [residentPage, entry] of this.residentEntries) {
        if (retainedPages.has(residentPage)) for (const group of entry.hintGroups) group.registryRevision = registryPublication.revision;
      }
      hintGroups.forEach((group) => { group.registryRevision = registryPublication!.revision; });
      const previousEntry = this.residentEntries.get(request.pageNumber);
      if (previousEntry !== undefined) this.evictPage(request.pageNumber);
      this.externalEntriesByPage = nextExternalEntries;
      this.layer = presentationRoot;
      this.textLayer = textLayer;
      this.renderedViewport = request.viewport;
      this.renderedCanvas = request.canvas;
      this.hintGroups = hintGroups;
      this.updateHintVisibility();
      this.pendingTextReservation = undefined;
      this.visibleTextReservation = undefined;
      this.residentEntries.set(request.pageNumber, {
        pageNumber: request.pageNumber, layer: presentationRoot, textLayer, annotationLayer, viewport: request.viewport,
        canvas: request.canvas, reservation: reserved.reservation, hintGroups, renderSequence: sequence,
      });
      ownsReservation = false;
      this.renderedPage = request.pageNumber;
      this.renderedSequence = sequence;
      this.evictedPage = undefined;
      published = true;
      try {
        this.applyPendingDestination(request);
        this.applyHighlights();
      } catch (error) {
        this.options.onStatus(`PDF overlay published with limited search decoration: ${error instanceof Error ? error.message : String(error)}`);
      }
      const finalization = registryPublication.finalize();
      void finalization.catch((error: unknown) => {
        this.options.onStatus(`PDF link registry cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      if (!published) await registryPublication?.rollback();
      if (!published && deferredOwnership === undefined) deferredOwnership = this.unsettledVisibleTextCleanup;
      if (!published && this.isCurrent(generation, document) && sequence === this.renderSequence) throw error;
    } finally {
      const finishOwnership = (): void => {
        if (ownsReservation) {
          if (this.pendingTextReservation === reserved.reservation) this.pendingTextReservation = undefined;
          this.options.resources.release(reserved.reservation);
        }
        if (this.pendingTextRenderer === renderer) this.pendingTextRenderer = undefined;
        resolveSettlement();
        if (this.pendingRenderSettlement === settlement) this.pendingRenderSettlement = undefined;
      };
      if (deferredOwnership === undefined) finishOwnership();
      else void deferredOwnership.then(finishOwnership, finishOwnership);
    }
  }

  public activateResidentPage(pageNumber: number): boolean {
    const entry = this.residentEntries.get(pageNumber);
    if (entry === undefined) return false;
    this.layer = entry.layer;
    this.textLayer = entry.textLayer;
    this.renderedViewport = entry.viewport;
    this.renderedCanvas = entry.canvas;
    this.renderedPage = entry.pageNumber;
    this.renderedSequence = entry.renderSequence;
    this.hintGroups = entry.hintGroups;
    try {
      this.updateHintVisibility();
      this.applyHighlights();
    } catch (error) {
      this.options.onStatus(`PDF resident decoration limited: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }

  /** Releases one resident page's overlays and reservation without disturbing siblings. */
  public evictPage(pageNumber: number): boolean {
    const entry = this.residentEntries.get(pageNumber);
    if (entry === undefined) return false;
    this.residentEntries.delete(pageNumber);
    this.externalEntriesByPage.delete(pageNumber);
    entry.layer.remove();
    entry.textLayer.remove();
    entry.annotationLayer.remove();
    this.options.resources.release(entry.reservation);
    if (this.renderedPage === pageNumber) {
      this.layer = undefined;
      this.textLayer = undefined;
      this.renderedViewport = undefined;
      this.renderedCanvas = undefined;
      this.renderedPage = undefined;
      this.renderedSequence = undefined;
      this.hintGroups = [];
      this.hintsVisible = false;
      this.hintInput = "";
    }
    return true;
  }
  /** Prepares and commits native resident authority while retaining rollback ownership. */
  public async beginResidentPageAuthority(pageNumbers: readonly number[]): Promise<PdfResidentAuthorityTransaction> {
    const pages = new Set(pageNumbers);
    if ([...pages].some((page) => !Number.isSafeInteger(page) || page < 1)) throw new Error("PDF_RESIDENT_PAGE_INVALID");
    const priorRevisions = new Map<LinkGroup, number | undefined>();
    for (const entry of this.residentEntries.values()) for (const group of entry.hintGroups) priorRevisions.set(group, group.registryRevision);
    const publication = this.stageExternalLinks(
      [...this.externalEntriesByPage].filter(([page]) => pages.has(page)).flatMap(([, entries]) => entries),
      Date.now() + SEARCH_TIMEOUT_MS,
    );
    try {
      await publication.staged;
      await publication.commit();
    } catch (error) {
      await publication.rollback();
      throw error;
    }
    for (const [page, entry] of this.residentEntries) {
      if (pages.has(page)) for (const group of entry.hintGroups) group.registryRevision = publication.revision;
    }
    let finalized = false;
    return {
      rollback: async () => {
        if (finalized) return;
        await publication.rollback();
        for (const [group, revision] of priorRevisions) group.registryRevision = revision;
        finalized = true;
      },
      finalize: () => {
        if (finalized) return;
        finalized = true;
        void publication.finalize().catch((error: unknown) => {
          this.options.onStatus(`PDF link registry cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      },
    };
  }
  /** Reconciles the native link registry after one resident-set transaction commits. */
  public async synchronizeResidentPages(pageNumbers: readonly number[]): Promise<void> {
    const transaction = await this.beginResidentPageAuthority(pageNumbers);
    transaction.finalize();
  }
  public invalidateSearch(): void {
    this.searchSequence += 1;
    this.cancelActiveSearch();
    this.releaseResultReservations();
    this.query = "";
    this.results = [];
    this.currentResult = -1;
    this.searchPending = false;
    this.partialSearchReason = undefined;
    this.applyHighlights();
  }

  private canvasScrollOrigin(canvas: HTMLCanvasElement): readonly [number, number] {
    let current: HTMLElement | null = canvas;
    let x = 0;
    let y = 0;
    while (current !== null && current !== this.options.host) {
      x += current.offsetLeft;
      y += current.offsetTop;
      const offsetParent = current.offsetParent as HTMLElement | null;
      if (offsetParent !== null) current = offsetParent;
      else if (current.parentElement === this.options.host) current = this.options.host;
      else break;
    }
    if (current === this.options.host) return [x, y];

    const hostRect = this.options.host.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return [
      this.options.host.scrollLeft + canvasRect.left - hostRect.left - this.options.host.clientLeft,
      this.options.host.scrollTop + canvasRect.top - hostRect.top - this.options.host.clientTop,
    ];
  }
  public queueDestination(pageNumber: number, destination: readonly unknown[]): number | undefined {
    const document = this.document;
    const generation = this.generation;
    if (document === undefined || generation === undefined) return undefined;
    const viewport = this.renderedViewport;
    const canvas = this.renderedCanvas;
    const canvasOrigin = canvas === undefined ? undefined : this.canvasScrollOrigin(canvas);
    const preservedPoint = viewport?.convertToPdfPoint === undefined
      || canvas === undefined
      || canvasOrigin === undefined
      ? undefined
      : viewport.convertToPdfPoint(
        this.options.host.scrollLeft - canvasOrigin[0],
        this.options.host.scrollTop - canvasOrigin[1],
      );
    this.pendingDestination = {
      document,
      generation,
      pageNumber,
      intentId: ++this.destinationSequence,
      preservedPoint,
      destination,
    };
    return this.pendingDestination.intentId;
  }

  public cancelDestination(intentId?: number): void {
    if (intentId === undefined) {
      this.linkActivationSequence += 1;
      this.pendingDestination = undefined;
      return;
    }
    if (this.pendingDestination?.intentId === intentId) this.pendingDestination = undefined;
  }

  private applyPendingDestination(request: PdfContentRenderRequest): void {
    const intent = this.pendingDestination;
    if (intent === undefined) return;
    if (intent.document !== this.document || intent.generation !== this.generation) {
      this.pendingDestination = undefined;
      return;
    }
    if (intent.pageNumber !== request.pageNumber) return;
    this.pendingDestination = undefined;

    const mode = intent.destination[1];
    const name = typeof mode === "object" && mode !== null && "name" in mode
      ? String((mode as { readonly name?: unknown }).name)
      : String(mode ?? "");
    const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
    const canvasOrigin = this.canvasScrollOrigin(request.canvas);
    const scrollTo = (point: readonly number[]): void => {
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
      this.options.host.scrollLeft = Math.max(0, canvasOrigin[0] + point[0]!);
      this.options.host.scrollTop = Math.max(0, canvasOrigin[1] + point[1]!);
    };

    if (name === "FitR"
      && finite(intent.destination[2])
      && finite(intent.destination[3])
      && finite(intent.destination[4])
      && finite(intent.destination[5])) {
      const first = request.viewport.convertToViewportPoint(intent.destination[2], intent.destination[3]);
      const second = request.viewport.convertToViewportPoint(intent.destination[4], intent.destination[5]);
      scrollTo([Math.min(first[0], second[0]), Math.min(first[1], second[1])]);
      return;
    }

    const destinationX = name === "XYZ" && finite(intent.destination[2])
      ? intent.destination[2]
      : (name === "FitV" || name === "FitBV") && finite(intent.destination[2])
        ? intent.destination[2]
        : undefined;
    const destinationY = name === "XYZ" && finite(intent.destination[3])
      ? intent.destination[3]
      : (name === "FitH" || name === "FitBH") && finite(intent.destination[2])
        ? intent.destination[2]
        : undefined;
    const x = destinationX ?? intent.preservedPoint?.[0];
    const y = destinationY ?? intent.preservedPoint?.[1];
    if (x === undefined && y === undefined) return;

    const current = intent.preservedPoint ?? request.viewport.convertToPdfPoint(
      this.options.host.scrollLeft - canvasOrigin[0],
      this.options.host.scrollTop - canvasOrigin[1],
    );
    const targetX = x ?? current[0];
    const targetY = y ?? current[1];
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return;
    scrollTo(request.viewport.convertToViewportPoint(targetX, targetY));
  }
  public async search(query: string, restoreEvictedResult = false): Promise<void> {
    const deadline = Date.now() + SEARCH_TIMEOUT_MS;
    const sequence = ++this.searchSequence;
    const source = query.trim();
    this.cancelActiveSearch();
    this.releaseResultReservations();
    this.query = "";
    this.results = [];
    this.currentResult = -1;
    this.searchPending = false;
    this.searchIncomplete = false;
    if (!restoreEvictedResult) this.evictedCurrentResult = undefined;
    this.partialSearchReason = undefined;
    this.applyHighlights(deadline);
    if (encoder.encode(source).byteLength > RESOURCE_LIMITS.maxTextPageBytes) {
      this.options.onStatus("TEXT_LIMIT");
      return;
    }
    const normalized = normalizePdfSearchQuery(query);
    if (normalized.length === 0) return;
    const previous = this.activeSearchSettlement;
    if (previous !== undefined) {
      try {
        await this.withDeadline(previous, Math.max(1, deadline - Date.now()));
      } catch {
        if (sequence === this.searchSequence) this.options.onStatus("Search cleanup timed out.");
        return;
      }
    }
    if (sequence !== this.searchSequence) return;
    const cleanupFailure = this.searchCleanupFailure;
    if (cleanupFailure !== undefined && cleanupFailure.document === this.document && cleanupFailure.generation === this.generation) {
      this.options.onStatus(cleanupFailure.message);
      return;
    }
    const generation = this.generation;
    const document = this.document;
    const sessionId = this.sessionId;
    assertDeadline(deadline);
    this.query = normalized;
    this.applyHighlights(deadline);
    if (generation === undefined || document === undefined || sessionId === undefined) return;
    const extractor = this.options.resources.reserve({ kind: "search-extractor", amount: 1, sessionId });
    const documentText = this.options.resources.reserve({ kind: "text-document-bytes", amount: RESOURCE_LIMITS.maxTextDocumentBytes, sessionId });
    const reservationFailure = !extractor.ok ? extractor.tag : !documentText.ok ? documentText.tag : undefined;
    if (reservationFailure !== undefined) {
      if (extractor.ok) this.options.resources.release(extractor.reservation);
      if (documentText.ok) this.options.resources.release(documentText.reservation);
      this.options.onStatus(reservationFailure);
      return;
    }
    if (!extractor.ok || !documentText.ok) return;
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => { resolveSettlement = resolve; });
    this.activeSearchSettlement = settlement;
    const documentBytes = { value: 0 };
    let hasExtractedText = false;
    this.searchPending = true;
    let deferredSearchCleanup: Promise<void> | undefined;
    const awaitPageOwned = async <T>(operation: Promise<T>): Promise<T> => {
      let settled = false;
      const tracked = operation.finally(() => { settled = true; });
      try {
        return await this.withDeadline(tracked, Math.max(1, deadline - Date.now()));
      } catch (error) {
        if (!settled) {
          deferredSearchCleanup = tracked.then(() => undefined, () => undefined);
          this.unsettledSearchCleanup = deferredSearchCleanup;
        }
        throw error;
      }
    };
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        assertDeadline(deadline);
        if (!this.isCurrent(generation, document) || sequence !== this.searchSequence) return;
        const page = await awaitPageOwned(Promise.resolve(document.getPage(pageNumber)));
        if (!this.isCurrent(generation, document) || sequence !== this.searchSequence) return;
        const text = await awaitPageOwned(this.extractPageText(page, deadline, generation, document, sequence, documentBytes));
        if (text === null) return;
        if (text.length > 0) hasExtractedText = true;
        const folded = foldLiteral(text, deadline);
        let index = folded.value.indexOf(normalized);
        while (index !== -1) {
          assertDeadline(deadline);
          if (this.results.length >= MAX_RESULTS || !this.reserveResultSlot(sessionId)) throw new Error("Search reached the result limit.");
          const originalStart = folded.starts[index]!;
          const originalEnd = folded.ends[index + normalized.length - 1]!;
          this.results.push({ pageNumber, index: originalStart, length: originalEnd - originalStart });
          index = folded.value.indexOf(normalized, index + Math.max(1, normalized.length));
        }
      }
      assertDeadline(deadline);
      if (!this.isCurrent(generation, document) || sequence !== this.searchSequence) return;
      if (this.results.length === 0) {
        this.options.onStatus(hasExtractedText ? "No text matches found in this PDF." : "This PDF has no searchable text. OCR is unavailable.");
      } else {
        this.currentResult = restoreEvictedResult && this.evictedCurrentResult !== undefined && this.evictedCurrentResult >= 0
          ? Math.min(this.evictedCurrentResult, this.results.length - 1)
          : 0;
        this.evictedCurrentResult = undefined;
        assertDeadline(deadline);
        this.options.navigateToPage(this.results[this.currentResult]!.pageNumber);
        this.reportCurrentMatch("");
      }
      this.applyHighlights(deadline);
    } catch (error) {
      let cause = error instanceof Error ? error.message : "Search could not be completed.";
      if (deferredSearchCleanup !== undefined && !cause.startsWith("Search cleanup failed:")) cause = `Search cleanup failed: ${cause}`;
      if (cause.startsWith("Search cleanup failed:")) {
        this.searchCleanupFailure = { document, generation, message: cause };
        deferredSearchCleanup = this.unsettledSearchCleanup;
      }
      if (this.isCurrent(generation, document) && sequence === this.searchSequence) {
        if (Date.now() < deadline && this.results.length > 0) {
          this.currentResult = 0;
          this.options.navigateToPage(this.results[0]!.pageNumber);
          this.partialSearchReason = cause;
          this.reportCurrentMatch("");
          this.applyHighlights(deadline);
        } else {
          this.options.onStatus(cause);
        }
      }
    } finally {
      const finishSearchOwnership = (): void => {
        this.options.resources.release(extractor.reservation);
        this.options.resources.release(documentText.reservation);
        resolveSettlement();
        if (this.activeSearchSettlement === settlement) this.activeSearchSettlement = undefined;
        if (this.unsettledSearchCleanup === deferredSearchCleanup) this.unsettledSearchCleanup = undefined;
        if (this.searchCleanupFailure?.document === document && this.searchCleanupFailure.generation === generation) this.searchCleanupFailure = undefined;
      };
      if (this.isCurrent(generation, document) && sequence === this.searchSequence) this.searchPending = false;
      if (deferredSearchCleanup === undefined) finishSearchOwnership();
      else void deferredSearchCleanup.then(finishSearchOwnership, finishSearchOwnership);
    }
  }

  public nextMatch(reverse = false): PdfSearchResult | null {
    if (this.results.length === 0) return null;
    this.currentResult = (this.currentResult + (reverse ? -1 : 1) + this.results.length) % this.results.length;
    const result = this.results[this.currentResult]!;
    this.options.navigateToPage(result.pageNumber);
    this.reportCurrentMatch("");
    this.applyHighlights();
    return result;
  }

  public toggleHints(): void {
    if (!this.hintsVisible && this.hintGroups.length === 0) {
      this.options.onStatus("No links are available on this page.");
      return;
    }
    this.hintsVisible = !this.hintsVisible;
    this.hintInput = "";
    this.updateHintVisibility();
  }

  public cancelHints(): void {
    this.hintsVisible = false;
    this.hintInput = "";
    this.updateHintVisibility();
  }
  public handleHintKey(key: string): boolean {
    if (key === "Escape" && this.hintsVisible) {
      this.cancelHints();
      return true;
    }
    if (!this.hintsVisible || key.length !== 1) return false;
    const input = (this.hintInput + key).toUpperCase();
    const exact = this.hintGroups.findIndex((_group, index) => this.hintLabel(index) === input);
    if (exact >= 0) {
      void this.activateLink(this.hintGroups[exact]!);
      this.cancelHints();
      return true;
    }
    if (this.hintGroups.some((_group, index) => this.hintLabel(index).startsWith(input))) {
      this.hintInput = input;
      return true;
    }
    this.hintInput = "";
    return false;
  }

  private async appendLinkGroups(
    layer: HTMLElement,
    annotations: readonly PdfContentAnnotation[],
    viewport: PdfContentViewport,
    pageNumber: number,
    sequence: number,
    generation: number,
    document: PdfContentDocument,
  ): Promise<LinkGroup[]> {
    const indexedLinks = annotations.flatMap((annotation, index) =>
      annotation.subtype === "Link" && annotation.rect !== undefined ? [{ annotation, index }] : []);
    const candidates = (await Promise.all(indexedLinks.map(async ({ annotation, index }) => {
      const key = await this.destinationKey(annotation, index, document);
      const rect = key === null ? null : this.toRectangle(annotation.rect!, viewport);
      return key === null || rect === null ? null : {
        annotation, annotationId: `page-${pageNumber}-render-${sequence}-annotation-${index}`, rect, index, key,
      };
    }))).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
    const groups: LinkGroup[] = [];
    for (const candidate of candidates.sort((left, right) =>
      this.compareRectangles(left.rect, right.rect) || left.index - right.index)) {
      if (groups.some((group) =>
        this.sameDestination(group.key, candidate.key) && this.sameRectangle(group.rectangles[0]!, candidate.rect))) continue;
      groups.push({
        key: candidate.key,
        annotation: candidate.annotation,
        annotationId: candidate.annotationId,
        renderSequence: sequence,
        registryRevision: undefined,
        rectangles: [candidate.rect],
      });
    }
    const hintGroups = groups.sort((left, right) => this.compareRectangles(left.rectangles[0]!, right.rectangles[0]!) || this.compareStrings(left.key, right.key) || this.compareStrings(left.annotationId, right.annotationId));
    hintGroups.forEach((group, index) => {
      group.rectangles.forEach((rect) => {
        const target = documentCreate("button", "pdf-link-overlay");
        target.type = "button";
        target.style.position = "absolute";
        target.style.left = `${rect.left}px`;
        target.style.top = `${rect.top}px`;
        target.style.width = `${rect.width}px`;
        target.style.height = `${rect.height}px`;
        target.style.pointerEvents = "auto";
        target.dataset.hintTarget = this.hintLabelFor(index, hintGroups.length);
        target.setAttribute("aria-label", `PDF link ${this.hintLabelFor(index, hintGroups.length)}`);
        const annotationColor = group.annotation.color;
        if (annotationColor !== undefined && annotationColor.length >= 3) {
          const channels = [annotationColor[0], annotationColor[1], annotationColor[2]].map(Number);
          if (channels.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255)) {
            target.style.setProperty("--pdf-link-color", `rgb(${channels.map((channel) => Math.round(channel)).join(" ")})`);
          }
        }
        const borderWidth = group.annotation.borderStyle?.width;
        if (typeof borderWidth === "number" && Number.isFinite(borderWidth) && borderWidth > 0) {
          target.style.borderWidth = `${Math.min(4, Math.max(1, borderWidth))}px`;
        }
        if (group.annotation.borderStyle?.style === 2) target.style.borderStyle = "dashed";
        target.addEventListener("click", () => {
          if (this.interactionsEnabled && this.isCurrent(generation, document) && !this.isClosing()) void this.activateLink(group);
        });
        layer.append(target);
      });
      const first = group.rectangles[0];
      if (first === undefined) return;
      const hint = documentCreate("span", "pdf-link-hint");
      hint.textContent = this.hintLabelFor(index, hintGroups.length);
      hint.dataset.hintLabel = this.hintLabelFor(index, hintGroups.length);
      hint.style.position = "absolute";
      hint.style.left = `${first.left}px`;
      hint.style.top = `${first.top}px`;
      hint.style.display = this.hintsVisible ? "block" : "none";
      layer.append(hint);
    });
    return hintGroups;
  }

  private async activateLink(group: LinkGroup): Promise<void> {
    const document = this.document;
    const generation = this.generation;
    if (!this.interactionsEnabled || document === undefined || generation === undefined || this.isClosing()) return;
    const { annotation } = group;
    if (annotation.url !== undefined) {
      const activation = ++this.linkActivationSequence;
      if (!isExternalUrl(annotation.url)) this.options.onStatus("Unsupported PDF link destination.");
      else if (activation === this.linkActivationSequence && group.registryRevision !== undefined) {
        const operationId = `external-${this.sessionId ?? "unmounted"}-${group.registryRevision}-${group.annotationId}-${activation}`;
        let rawActivation: Promise<void>;
        try {
          rawActivation = Promise.resolve(this.options.openExternal(group.annotationId, group.registryRevision!, operationId, activation));
        } catch (error) {
          rawActivation = Promise.reject(error);
        }
        this.trackLinkActivation(rawActivation);
        this.reportLinkActivation(this.withDeadline(rawActivation, LINK_ACTIVATION_TIMEOUT_MS, "LINK_LAUNCH_TIMEOUT"));
      }
      return;
    }
    if (annotation.action !== undefined || annotation.dest === undefined) {
      if (this.hintGroups.includes(group)) this.options.onStatus("Unsupported PDF link action.");
      return;
    }
    if (this.internalDestinationActivation !== undefined) return;
    let releaseLease!: () => void;
    const lease = new Promise<void>((resolve) => { releaseLease = resolve; });
    this.internalDestinationActivation = lease;
    const rawSettlements: Promise<void>[] = [];
    const activation = ++this.linkActivationSequence;
    const deadline = Date.now() + LINK_ACTIVATION_TIMEOUT_MS;
    const isActive = (): boolean => activation === this.linkActivationSequence
      && group.renderSequence === this.renderedSequence
      && this.hintGroups.includes(group)
      && this.isCurrent(generation, document);
    const remaining = (): number => {
      const milliseconds = deadline - Date.now();
      if (milliseconds <= 0) throw new Error("Link activation timed out.");
      return milliseconds;
    };
    const awaitRaw = async <T>(operation: Promise<T>): Promise<T> => {
      const settlement = operation.then(() => undefined, () => undefined);
      rawSettlements.push(settlement);
      this.linkActivationSettlements.add(settlement);
      void settlement.finally(() => this.linkActivationSettlements.delete(settlement));
      return this.withDeadline(operation, Math.min(remaining(), INTERNAL_DESTINATION_RESOLUTION_TIMEOUT_MS), "PDF link destination resolution timed out.");
    };
    try {
      const destination = typeof annotation.dest === "string"
        ? await awaitRaw(Promise.resolve(document.getDestination?.(annotation.dest)))
        : annotation.dest;
      if (!isActive()) return;
      if (!Array.isArray(destination) || !isValidPdfDestination(destination)) {
        this.options.onStatus("Unsupported PDF link destination.");
        return;
      }
      const reference = destination[0];
      const pageNumber = typeof reference === "number"
        ? (Number.isSafeInteger(reference) && reference >= 0 && reference < document.numPages ? reference + 1 : null)
        : document.getPageIndex === undefined ? null : await awaitRaw(document.getPageIndex(reference)).then((index) =>
          Number.isSafeInteger(index) && index >= 0 && index < document.numPages ? index + 1 : null);
      if (!isActive()) return;
      if (pageNumber === null) this.options.onStatus("Unsupported PDF link destination.");
      else this.options.navigateToDestination(pageNumber, destination);
    } catch (error) {
      if (isActive()) this.options.onStatus(error instanceof Error && error.message === "PDF link destination resolution timed out."
        ? error.message
        : "Unsupported PDF link destination.");
    } finally {
      void Promise.allSettled(rawSettlements).then(() => {
        if (this.internalDestinationActivation === lease) this.internalDestinationActivation = undefined;
        releaseLease();
      });
    }
  }
  private async destinationPage(destination: unknown, document: PdfContentDocument): Promise<number | null> {
    if (!Array.isArray(destination) || destination.length === 0) return null;
    const reference = destination[0];
    if (typeof reference === "number") {
      return Number.isSafeInteger(reference) && reference >= 0 && reference < document.numPages
        ? reference + 1
        : null;
    }
    if (document.getPageIndex === undefined) return null;
    const index = await document.getPageIndex(reference);
    return Number.isSafeInteger(index) && index >= 0 && index < document.numPages ? index + 1 : null;
  }

  private async destinationKey(annotation: PdfContentAnnotation, index: number, document: PdfContentDocument): Promise<string | null> {
    if (annotation.url !== undefined) return isExternalUrl(annotation.url) ? `url:${annotation.url}` : `unsupported-url:${index}`;
    if (annotation.action !== undefined) return `unsupported-action:${index}`;
    if (annotation.dest === undefined) return null;
    try {
      const destination = typeof annotation.dest === "string" ? await document.getDestination?.(annotation.dest) : annotation.dest;
      if (!Array.isArray(destination) || !isValidPdfDestination(destination)) return `unsupported-dest:${index}`;
      const page = await this.destinationPage(destination, document);
      if (page === null) return `unsupported-dest:${index}`;
      return `goto:${page}:${JSON.stringify(destination.slice(1).map((operand) => this.destinationOperand(operand)))}`;
    } catch {
      return `unsupported-dest:${index}`;
    }
  }
  private destinationOperand(value: unknown): unknown {
    if (value === null) return ["null"];
    if (value === undefined) return ["undefined"];
    if (typeof value === "string" || typeof value === "boolean") return [typeof value, value];
    if (typeof value === "number") return ["number", Number.isFinite(value) ? value : String(value)];
    if (Array.isArray(value)) return ["array", value.map((operand) => this.destinationOperand(operand))];
    if (typeof value === "object") {
      return ["object", Object.entries(value).sort(([left], [right]) => this.compareStrings(left, right)).map(([key, operand]) => [key, this.destinationOperand(operand)])];
    }
    return [typeof value, String(value)];
  }
  private sameDestination(left: string, right: string): boolean {
    return left === right;
  }

  private toRectangle(rectangle: readonly number[], viewport: PdfContentViewport): DOMRect | null {
    if (rectangle.length !== 4) return null;
    const first = viewport.convertToViewportPoint(rectangle[0]!, rectangle[1]!);
    const second = viewport.convertToViewportPoint(rectangle[2]!, rectangle[3]!);
    const left = Math.min(first[0], second[0]);
    const top = Math.min(first[1], second[1]);
    const width = Math.abs(second[0] - first[0]);
    const height = Math.abs(second[1] - first[1]);
    return width > 0 && height > 0 ? new DOMRect(left, top, width, height) : null;
  }

  private sameRectangle(left: DOMRect, right: DOMRect): boolean {
    return left.left === right.left
      && left.top === right.top
      && left.width === right.width
      && left.height === right.height;
  }
  private compareRectangles(left: DOMRect, right: DOMRect): number {
    return left.top - right.top
      || left.left - right.left
      || left.height - right.height
      || left.width - right.width;
  }

  private compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  private hintLabel(index: number): string {
    return this.hintLabelFor(index, this.hintGroups.length);
  }

  private hintLabelFor(index: number, total: number): string {
    let width = 1;
    let capacity = hintAlphabet.length;
    while (capacity < total) {
      width += 1;
      capacity *= hintAlphabet.length;
    }
    let value = index;
    let label = "";
    for (let position = 0; position < width; position += 1) {
      label = hintAlphabet[value % hintAlphabet.length]! + label;
      value = Math.floor(value / hintAlphabet.length);
    }
    return label;
  }


  private updateHintVisibility(): void {
    this.layer?.querySelectorAll<HTMLElement>("[data-hint-label]").forEach((hint) => {
      hint.style.display = this.hintsVisible ? "block" : "none";
    });
    this.layer?.classList.toggle("pdf-link-hints-active", this.hintsVisible);
  }

  private stageExternalLinks(
    entries: readonly PdfExternalLinkRegistration[],
    deadline: number,
  ): RegistryPublication {
    const revision = ++this.registryRevision;
    const previousTurn = this.registryPublication;
    let releaseTurn!: () => void;
    let released = false;
    const turnComplete = new Promise<void>((resolve) => { releaseTurn = resolve; });
    this.registryPublication = turnComplete;
    let phase: "waiting" | "prepare-unknown" | "prepared" | "committed" | "done" = "waiting";
    let prepareInvoked = false;
    let operation: Promise<void> = previousTurn;
    let rollbackRequested = false;
    let abortScheduled = false;
    let resolveFinalization!: () => void;
    let rawOwnership: Promise<void> | undefined;
    const settlement = new Promise<void>((resolve) => { resolveFinalization = resolve; });
    const terminate = (): void => {
      if (phase === "done") return;
      phase = "done";
      if (!released) {
        released = true;
        releaseTurn();
      }
      resolveFinalization();
    };
    const remaining = (): number => {
      const milliseconds = deadline - Date.now();
      if (milliseconds <= 0) throw new Error("PDF link registry publication timed out.");
      return milliseconds;
    };
    const quarantine = (reason: unknown): void => {
      if (this.registryQuarantined === undefined) this.registryQuarantined = { revision, reason };
    };
    const scheduleLateAbort = (after = rawOwnership): void => {
      if (abortScheduled || !prepareInvoked || after === undefined) return;
      abortScheduled = true;
      this.deferRegistryCleanup(revision, after);
      void after.then(
        () => Promise.all(this.retryDeferredRegistryCleanups()).then(() => undefined),
        () => Promise.all(this.retryDeferredRegistryCleanups()).then(() => undefined),
      ).catch(quarantine);
    };
    const enqueue = (action: () => Promise<void>, abortOnFailure = true): Promise<void> => {
      const started = operation.then(() => {
        remaining();
        const raw = Promise.resolve().then(() => {
          remaining();
          return action();
        });
        const supervised = raw.then(() => undefined, () => undefined);
        rawOwnership = supervised;
        return { raw, supervised };
      });
      let rawSettlement: Promise<void> | undefined;
      const foreground = started.then(({ raw, supervised }) => {
        rawSettlement = supervised;
        return this.withDeadline(raw, remaining(), "PDF link registry publication timed out.");
      }).catch((error) => {
        if (!prepareInvoked) {
          terminate();
          throw error;
        }
        quarantine(error);
        if (abortOnFailure) scheduleLateAbort(rawSettlement ?? rawOwnership);
        terminate();
        throw error;
      });
      operation = foreground.then(() => undefined, () => undefined);
      return foreground;
    };
    const awaitPendingActivations = (): Promise<void> => {
      const settlements = [...this.linkActivationSettlements];
      return settlements.length === 0 ? Promise.resolve() : Promise.allSettled(settlements).then(() => undefined);
    };
    const staged = enqueue(async () => {
      if (this.isClosing() || this.registryQuarantined !== undefined) {
        terminate();
        throw new Error("PDF link registry is quarantined until unmount.");
      }
      await this.withDeadline(awaitPendingActivations(), remaining(), "PDF link registry publication timed out.");
      remaining();
      if (this.isClosing() || this.registryQuarantined !== undefined) {
        terminate();
        throw new Error("PDF link registry is quarantined until unmount.");
      }
      prepareInvoked = true;
      phase = "prepare-unknown";
      try {
        await this.options.prepareExternalLinks(entries, revision);
        phase = "prepared";
      } catch (error) {
        phase = "prepare-unknown";
        throw error;
      }
    });
    const rollback = (): Promise<void> => {
      if (phase === "done" || rollbackRequested) return settlement;
      rollbackRequested = true;
      if (!prepareInvoked) {
        terminate();
        return settlement;
      }
      if (phase === "prepare-unknown") {
        scheduleLateAbort();
        terminate();
        return settlement;
      }
      return enqueue(async () => {
        if (phase === "done") return;
        try {
          await this.options.abortExternalLinks(revision);
        } catch (error) {
          quarantine(error);
          throw error;
        } finally {
          terminate();
        }
      }).catch((error) => {
        scheduleLateAbort();
        terminate();
        throw error;
      });
    };
    return {
      revision,
      staged,
      commit: () => enqueue(async () => {
        if (phase !== "prepared") throw new Error("LINK_REGISTRY_PHASE");
        await this.options.commitExternalLinks(revision);
        phase = "committed";
      }),
      finalize: () => {
        let invoked = false;
        const started = operation.then(async () => {
          if (this.isClosing()) {
            this.retainSkippedPublishedRegistryFinalizer(revision, undefined);
            terminate();
            return;
          }
          remaining();
          if (phase !== "committed") throw new Error("LINK_REGISTRY_PHASE");
          await this.withDeadline(awaitPendingActivations(), remaining(), "PDF link registry publication timed out.");
          if (this.isClosing()) {
            this.retainSkippedPublishedRegistryFinalizer(revision, undefined);
            terminate();
            return;
          }
          remaining();
          invoked = true;
          let raw: Promise<void>;
          try {
            raw = Promise.resolve(this.options.finalizeExternalLinks(revision));
          } catch (error) {
            raw = Promise.reject(error);
          }
          rawOwnership = raw.then(() => undefined, () => undefined);
          this.retainPublishedRegistryFinalizer(revision, raw);
          await this.withDeadline(raw, remaining(), "PDF link registry publication timed out.");
          terminate();
        });
        const foreground = started.catch((error) => {
          if (!invoked && !this.isClosing()) this.retainSkippedPublishedRegistryFinalizer(revision, error);
          if (!this.isClosing()) quarantine(error);
          terminate();
          throw error;
        });
        operation = foreground.then(() => undefined, () => undefined);
        return foreground;
      },
      settlement,
      rollback,
    };
  }
  private reportCurrentMatch(suffix: string): void {
    const disclosure = suffix || (this.partialSearchReason === undefined ? "" : ` Search results are partial: ${this.partialSearchReason}`);
    this.options.onStatus(
      `Match ${this.currentResult + 1} of ${this.results.length}.${disclosure}`,
    );
  }
  private clearHighlights(): void {
    const registry = (globalThis.CSS as (typeof CSS & { highlights?: HighlightRegistry }) | undefined)?.highlights;
    registry?.delete(SEARCH_HIGHLIGHT_NAME);
    registry?.delete(CURRENT_SEARCH_HIGHLIGHT_NAME);
    this.layer?.querySelectorAll<HTMLElement>("[data-search-fallback]").forEach((rectangle) => rectangle.remove());
  }

  private applyHighlights(deadline = Date.now() + SEARCH_TIMEOUT_MS): void {
    this.clearHighlights();
    if (this.renderedPage === undefined || this.textLayer === undefined || this.layer === undefined) return;
    const layer = this.layer;
    const ranges = this.exactSearchRanges(deadline);
    const current = ranges.find(({ resultIndex }) => resultIndex === this.currentResult);
    const registry = (globalThis.CSS as (typeof CSS & { highlights?: HighlightRegistry }) | undefined)?.highlights;
    const HighlightConstructor = (globalThis as typeof globalThis & {
      Highlight?: new (...ranges: Range[]) => unknown;
    }).Highlight;
    if (registry !== undefined && HighlightConstructor !== undefined) {
      registry.set(SEARCH_HIGHLIGHT_NAME, new HighlightConstructor(...ranges.map(({ exact }) => exact.range)));
      if (current !== undefined) registry.set(CURRENT_SEARCH_HIGHLIGHT_NAME, new HighlightConstructor(current.exact.range));
    } else {
      const layerBounds = layer.getBoundingClientRect();
      for (const { exact, resultIndex } of ranges) {
        assertDeadline(deadline);
        const getClientRects = (exact.range as Range & { getClientRects?: () => DOMRectList }).getClientRects;
        if (typeof getClientRects !== "function") continue;
        for (const rectangle of Array.from(getClientRects.call(exact.range))) {
          assertDeadline(deadline);
          if (rectangle.width <= 0 || rectangle.height <= 0) continue;
          const fallback = documentCreate("div", "pdf-search-fallback");
          fallback.dataset.searchFallback = "true";
          fallback.dataset.searchCurrent = String(resultIndex === this.currentResult);
          fallback.style.position = "absolute";
          fallback.style.left = `${rectangle.left - layerBounds.left}px`;
          fallback.style.top = `${rectangle.top - layerBounds.top}px`;
          fallback.style.width = `${rectangle.width}px`;
          fallback.style.height = `${rectangle.height}px`;
          layer.append(fallback);
        }
      }
    }
    current?.exact.anchor?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  private exactSearchRanges(deadline: number): { readonly exact: ExactSearchRange; readonly resultIndex: number }[] {
    const layer = this.textLayer;
    if (layer === undefined || this.renderedPage === undefined) return [];
    const nodes: IndexedTextNode[] = [];
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let offset = 0;
    let node: Node | null = walker.nextNode();
    while (node !== null) {
      assertDeadline(deadline);
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node as Text;
        const length = text.data.length;
        if (length > 0) {
          nodes.push({ node: text, start: offset, end: offset + length });
          offset += length;
        }
      } else if (node instanceof HTMLBRElement) {
        nodes.push({ node, start: offset, end: offset + 1 });
        offset += 1;
      }
      node = walker.nextNode();
    }
    const pointAt = (indexed: IndexedTextNode, position: number): [Node, number] => {
      if (indexed.node instanceof Text) return [indexed.node, Math.max(0, Math.min(indexed.node.data.length, position - indexed.start))];
      const parent = indexed.node.parentNode;
      if (parent === null) return [indexed.node, 0];
      const index = Array.prototype.indexOf.call(parent.childNodes, indexed.node) as number;
      return [parent, position <= indexed.start ? index : index + 1];
    };
    const matches: { readonly exact: ExactSearchRange; readonly resultIndex: number }[] = [];
    let cursor = 0;
    for (let resultIndex = 0; resultIndex < this.results.length; resultIndex += 1) {
      assertDeadline(deadline);
      const result = this.results[resultIndex]!;
      if (result.pageNumber !== this.renderedPage || result.length <= 0) continue;
      const end = result.index + result.length;
      while (cursor < nodes.length && nodes[cursor]!.end <= result.index) cursor += 1;
      if (cursor >= nodes.length || nodes[cursor]!.start > result.index) continue;
      let endCursor = cursor;
      while (endCursor < nodes.length && nodes[endCursor]!.end < end) endCursor += 1;
      if (endCursor >= nodes.length || nodes[endCursor]!.start > end) continue;
      const range = document.createRange();
      const [startNode, startOffset] = pointAt(nodes[cursor]!, result.index);
      const [endNode, endOffset] = pointAt(nodes[endCursor]!, end);
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      matches.push({ exact: { range, anchor: startNode.parentElement?.closest<HTMLElement>("span") ?? null }, resultIndex });
      cursor = endCursor;
    }
    return matches;
  }

  private isCurrent(generation: number, document: PdfContentDocument): boolean {
    return this.generation === generation && this.document === document;
  }

  private cancelActiveSearch(): void {
    const reader = this.activeTextReader;
    if (reader !== undefined) {
      void this.cancelTextReader(reader, Date.now() + SEARCH_TIMEOUT_MS).catch(() => undefined);
    }
  }
  private reserveResultSlot(sessionId: string): boolean {
    const result = this.options.resources.reserve({
      kind: "search-document-results",
      amount: 1,
      sessionId,
    });
    if (!result.ok) return false;
    this.resultReservations.push(result.reservation);
    return true;
  }
  private releaseResultReservations(): void {
    this.resultReservations.forEach((reservation) => this.options.resources.release(reservation));
    this.resultReservations = [];
  }

  private async cancelTextReader(
    reader: ReadableStreamDefaultReader<PdfContentTextContent>,
    deadline: number,
  ): Promise<void> {
    let cancellation = this.textReaderCancellation.get(reader);
    if (cancellation === undefined) {
      cancellation = Promise.resolve(reader.cancel());
      this.textReaderCancellation.set(reader, cancellation);
    }
    await this.withDeadline(cancellation, Math.max(1, deadline - Date.now()));
  }
  private clearRenderedContent(): void {
    for (const entry of this.residentEntries.values()) {
      entry.layer.remove();
      entry.textLayer.remove();
      entry.annotationLayer.remove();
      this.options.resources.release(entry.reservation);
    }
    this.residentEntries.clear();
    this.externalEntriesByPage.clear();
    this.layer?.remove();
    this.clearHighlights();
    this.layer = undefined;
    this.textLayer = undefined;
    this.renderedViewport = undefined;
    this.renderedCanvas = undefined;
    this.visibleTextReservation = undefined;
    this.renderedPage = undefined;
    this.renderedSequence = undefined;
    this.hintGroups = [];
    this.hintsVisible = false;
    this.hintInput = "";
  }
  private trackLinkActivation(rawOperation: Promise<void>): void {
    const settlement = rawOperation.then(() => undefined, () => undefined);
    this.linkActivationSettlements.add(settlement);
    void settlement.then(() => this.linkActivationSettlements.delete(settlement));
  }

  private deferRegistryCleanup(revision: number, operation: Promise<void>): void {
    if (!this.deferredRegistryCleanups.has(revision)) this.deferredRegistryCleanups.set(revision, { revision, operation, abortSettlement: undefined });
  }
  private retryDeferredRegistryCleanups(): Promise<void>[] {
    return [...this.deferredRegistryCleanups.values()].map((deferred) => {
      if (deferred.abortSettlement === undefined) deferred.abortSettlement = deferred.operation.then(
        () => this.options.abortExternalLinks(deferred.revision),
      ).then(() => {
        this.deferredRegistryCleanups.delete(deferred.revision);
        if (this.registryQuarantined?.revision === deferred.revision) this.registryQuarantined = undefined;
      }, (reason: unknown) => {
        deferred.abortSettlement = undefined;
        this.registryQuarantined = { revision: deferred.revision, reason };
        throw reason;
      });
      return deferred.abortSettlement;
    });
  }
  private retainPublishedRegistryFinalizer(revision: number, raw: Promise<void>): void {
    const finalizer: PublishedRegistryFinalizer = {
      revision,
      state: "pending",
      settlement: raw.then(() => undefined, () => undefined),
      reason: undefined,
    };
    this.publishedRegistryFinalizers.set(revision, finalizer);
    void raw.then(
      () => {
        if (this.publishedRegistryFinalizers.get(revision) !== finalizer) return;
        finalizer.state = "succeeded";
        if (this.registryQuarantined?.revision === revision) this.registryQuarantined = undefined;
        this.publishedRegistryFinalizers.delete(revision);
      },
      (reason: unknown) => {
        if (this.publishedRegistryFinalizers.get(revision) !== finalizer) return;
        finalizer.state = "failed";
        finalizer.settlement = undefined;
        finalizer.reason = reason;
        if (this.registryQuarantined === undefined) this.registryQuarantined = { revision, reason };
      },
    );
  }
  private retainSkippedPublishedRegistryFinalizer(revision: number, reason: unknown): void {
    if (this.publishedRegistryFinalizers.has(revision)) return;
    this.publishedRegistryFinalizers.set(revision, {
      revision,
      state: "skipped",
      settlement: undefined,
      reason,
    });
  }
  private hasTerminalPublishedRegistryFinalizer(revision: number): boolean {
    const finalizer = this.publishedRegistryFinalizers.get(revision);
    return finalizer?.state === "failed" || finalizer?.state === "skipped";
  }
  private isClosing(): boolean { return this.closingEpoch === this.mountedEpoch; }

  private reportLinkActivation(operation: Promise<void>): void {
    void operation.then(
      () => undefined,
      (error: unknown) => this.options.onStatus(isExternalLaunchTimeout(error)
        ? "PDF link launch outcome is unknown; it may still open later."
        : isExternalDispatchExpired(error)
          ? "PDF link was not opened because dispatch expired."
          : "PDF link could not be opened."),
    );
  }

  private async readVisibleText(page: PdfContentPage, deadline: number): Promise<PdfContentTextContent> {
    const stream = page.streamTextContent?.();
    const items: PdfContentTextItem[] = [];
    if (stream === undefined) return page.getTextContent();
    const reader = stream.getReader();
    const styles: Record<string, unknown> = {};
    const bytes = { value: 0 };
    let styleCount = 0;
    let metadataBytes = 0;
    let lang: string | undefined;
    let readSettlement: Promise<void> = Promise.resolve();
    try {
      while (true) {
        const rawRead = reader.read();
        readSettlement = rawRead.then(() => undefined, () => undefined);
        const next = await this.withDeadline(rawRead, Math.max(1, deadline - Date.now()));
        if (next.done) return { items, styles, ...(lang === undefined ? {} : { lang }) };
        if (lang === undefined && typeof next.value.lang === "string") lang = next.value.lang;
        for (const [name, style] of Object.entries(next.value.styles ?? {})) {
          if (Object.hasOwn(styles, name)) continue;
          if (styleCount >= 10_000) throw new Error("TEXT_LIMIT");
          const encoded = encoder.encode(`${name}:${JSON.stringify(style)}`).byteLength;
          if (metadataBytes > RESOURCE_LIMITS.maxTextPageBytes - encoded) throw new Error("TEXT_LIMIT");
          metadataBytes += encoded;
          styles[name] = style;
          styleCount += 1;
        }
        for (const item of next.value.items) {
          if (items.length >= 100_000) throw new Error("TEXT_LIMIT");
          const value = typeof item.str === "string" ? (item.hasEOL ? `${item.str}\n` : item.str) : "";
          const nextBytes = addPdfTextUtf8Bytes(bytes.value, value);
          if (nextBytes === undefined) throw new Error("TEXT_LIMIT");
          bytes.value = nextBytes;
          items.push(item);
        }
      }
    } finally {
      const cancellation = Promise.resolve(reader.cancel());
      const ownership = Promise.allSettled([readSettlement, cancellation]).then(() => undefined);
      this.unsettledVisibleTextCleanup = ownership;
      void ownership.finally(() => {
        try { reader.releaseLock(); } catch { /* Lock may already be released. */ }
        if (this.unsettledVisibleTextCleanup === ownership) this.unsettledVisibleTextCleanup = undefined;
      });
      await ownership;
    }
  }
  private async extractPageText(
    page: PdfContentPage,
    deadline: number,
    generation: number,
    document: PdfContentDocument,
    sequence: number,
    documentBytes: { value: number },
  ): Promise<string | null> {
    const stream = page.streamTextContent?.();
    const chunks: string[] = [];
    const itemCount = { value: 0 };
    const pageBytes = { value: 0 };
    if (stream === undefined) throw new Error("Search streaming is unavailable.");
    const reader = stream.getReader();
    this.activeTextReader = reader;
    let readSettlement: Promise<void> = Promise.resolve();
    try {
      while (true) {
        assertDeadline(deadline);
        if (!this.isCurrent(generation, document) || sequence !== this.searchSequence) return null;
        const rawRead = reader.read();
        readSettlement = rawRead.then(() => undefined, () => undefined);
        const next = await this.withDeadline(rawRead, Math.max(1, deadline - Date.now()));
        assertDeadline(deadline);
        if (!this.isCurrent(generation, document) || sequence !== this.searchSequence) return null;
        if (next.done) break;
        appendBoundedText(chunks, next.value, pageBytes, documentBytes, itemCount, deadline);
      }
      assertDeadline(deadline);
      return chunks.join("");
    } finally {
      const cancellation = this.textReaderCancellation.get(reader) ?? Promise.resolve(reader.cancel());
      this.textReaderCancellation.set(reader, cancellation);
      const cleanup = await Promise.allSettled([readSettlement, cancellation]);
      if (this.activeTextReader === reader) this.activeTextReader = undefined;
      try { reader.releaseLock(); } catch { /* Lock may already be released. */ }
      if (cleanup[1]?.status === "rejected") {
        const detail = cleanup[1].reason instanceof Error ? cleanup[1].reason.message : String(cleanup[1].reason);
        throw new Error(`Search cleanup failed: ${detail}`);
      }
    }
  }
  private async withDeadline<T>(operation: Promise<T>, milliseconds: number, message = "Search timed out."): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), milliseconds); }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
const documentCreate = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className: string,
): HTMLElementTagNameMap[Tag] => {
  const element = document.createElement(tag);
  element.className = className;
  return element;
};
