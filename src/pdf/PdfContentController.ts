import { TextLayer } from "pdfjs-dist";
import {
  RESOURCE_LIMITS,
  type ResourceReservation,
  ResourceReservationManager,
} from "./ResourceBudget";
import { isValidPdfDestination } from "./PdfDestination";
export interface PdfContentTextItem { readonly str?: string; readonly hasEOL?: boolean; readonly fontName?: string; readonly dir?: string; readonly transform?: readonly number[]; readonly width?: number; readonly height?: number; readonly [key: string]: unknown; }
export interface PdfContentTextContent { readonly items: readonly PdfContentTextItem[]; readonly styles?: Readonly<Record<string, unknown>>; readonly lang?: string; }
export interface PdfContentAnnotation { readonly subtype?: string; readonly rect?: readonly number[]; readonly url?: string; readonly id?: string; readonly dest?: unknown; readonly action?: string; readonly color?: readonly number[] | Uint8ClampedArray | null; readonly borderStyle?: { readonly width?: number; readonly style?: number }; }
export interface PdfContentPage { getTextContent(): Promise<PdfContentTextContent>; streamTextContent?(): ReadableStream<PdfContentTextContent>; getAnnotations(options?: { readonly intent?: "display" }): Promise<readonly PdfContentAnnotation[]>; }
export interface PdfContentDocument { readonly numPages: number; getPage(pageNumber: number): Promise<PdfContentPage>; getDestination?(name: string): Promise<unknown>; getPageIndex?(reference: unknown): Promise<number>; cachedPageNumber?(reference: unknown): number | null; }
export interface PdfContentViewport { readonly width: number; readonly scale: number; readonly height: number; readonly rotation: number; readonly rawDims: { readonly pageWidth: number; readonly pageHeight: number }; convertToViewportPoint(x: number, y: number): readonly [number, number]; convertToPdfPoint(x: number, y: number): readonly [number, number]; }
export interface PdfContentRenderRequest { readonly pageNumber: number; readonly page: PdfContentPage; readonly viewport: PdfContentViewport; readonly canvas: HTMLCanvasElement; readonly retainedPages?: readonly number[]; readonly commitCanvas?: (accessory?: HTMLElement) => boolean; }
export interface PdfExternalLinkRegistration { readonly annotationId: string; readonly target: string; }
export interface PdfVisibleLinkGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export type PdfVisibleLinkKind = "external" | "internal";
export type PdfVisibleLinkSelectionId = string;
export interface PdfVisibleLinkCandidate {
  readonly selectionId: PdfVisibleLinkSelectionId;
  readonly pageNumber: number;
  readonly kind: PdfVisibleLinkKind;
  readonly rect: PdfVisibleLinkGeometry;
  readonly url?: string;
}
export interface PdfVisibleLinkSnapshot {
  readonly revision: number;
  readonly generation: number | null;
  readonly viewport: PdfVisibleLinkGeometry;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly truncated: boolean;
  readonly candidates: readonly PdfVisibleLinkCandidate[];
}
export type PdfLinkActivationResult =
  | { readonly kind: "activated"; readonly link: PdfVisibleLinkKind; readonly landing?: { readonly pageIndex: number; readonly x: number; readonly y: number } }
  | { readonly kind: "confirmation-required"; readonly url: string }
  | { readonly kind: "stale" | "rejected" | "unsupported" | "failed" | "in-progress" | "already-activated" | "same-location" };
export type PdfDestinationNavigationOutcome =
  | { readonly kind: "verified"; readonly landing?: { readonly pageIndex: number; readonly x: number; readonly y: number } }
  | { readonly kind: "rejected" | "same-location" | "stale" | "failed" };
export type PdfLinkActivationCause = "internal-link";
export interface PdfSearchGeometry { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
interface PdfSearchGeometryRange { readonly start: number; readonly end: number; readonly originX: number; readonly originY: number; readonly advanceX: number; readonly advanceY: number; readonly thicknessX: number; readonly thicknessY: number; readonly width: number; readonly height: number; readonly reverse: boolean; }
export interface PdfSearchResult { readonly pageNumber: number; readonly index: number; readonly length: number; readonly geometry?: PdfSearchGeometry; }
export type PdfSearchLandingOutcome = "displayedDistinct" | "displayedSame" | "failedWithoutMovement" | "displayedAfterUnverifiedMovement" | "stale";
export interface PdfSearchLandingRequest { readonly searchGeneration: number; readonly selectionSequence: number; readonly resultIndex: number; readonly result: PdfSearchResult; readonly provenance: "initial" | "next" | "previous" | "restore"; }
export interface PdfSearchResultsUpdate { readonly searchGeneration: number; readonly query: string; readonly results: readonly PdfSearchResult[]; readonly hasSearchableText: boolean; readonly searchPending: boolean; readonly searchIncomplete: boolean; }
export interface PdfContentControllerOptions {
  readonly host: HTMLElement;
  readonly resources: ResourceReservationManager;
  readonly onStatus: (message: string, source?: "search") => void;
  readonly onSearchCleared?: () => void;
  readonly navigateToPage: (pageNumber: number) => void;
  readonly navigateToDestination: (pageNumber: number, destination: readonly unknown[], cause: PdfLinkActivationCause, isActivationCurrent: () => boolean, returnLanding?: boolean) => Promise<PdfDestinationNavigationOutcome>;
  readonly resolveDestinationPage?: (reference: unknown) => Promise<number | null>;
  readonly onSearchResults: (update: PdfSearchResultsUpdate) => void;
  readonly requestSearchLanding: (request: PdfSearchLandingRequest) => Promise<PdfSearchLandingOutcome>;
  readonly scheduleSearchWork?: () => Promise<void>;
  readonly prepareExternalLinks: (entries: readonly PdfExternalLinkRegistration[], registryRevision: number) => Promise<void>;
  readonly commitExternalLinks: (registryRevision: number) => Promise<void>;
  readonly finalizeExternalLinks: (registryRevision: number) => Promise<void>;
  readonly abortExternalLinks: (registryRevision: number) => Promise<void>;
  readonly openExternal: (annotationId: string, registryRevision: number, activationOperationId: string, operationSequence: number) => Promise<number>;
}
export interface PdfContentSnapshot {
  readonly generation: number | null;
  readonly pageNumber: number | null;
  readonly query: string;
  readonly results: readonly PdfSearchResult[];
  readonly currentResult: number;
  readonly searchPending: boolean;
  readonly searchIncomplete: boolean;
}

interface ResidentContentEntry {
  readonly pageNumber: number;
  readonly layer: HTMLElement;
  readonly textLayer: HTMLElement;
  readonly annotationLayer: HTMLElement;
  readonly viewport: PdfContentViewport;
  readonly canvas: HTMLCanvasElement;
  readonly reservation: ResourceReservation;
  readonly linkGroups: LinkGroup[];
}

interface LinkGroup {
  readonly pageNumber: number;
  readonly key: string;
  readonly annotation: PdfContentAnnotation;
  readonly annotationId: string;
  readonly selectionId: PdfVisibleLinkSelectionId;
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
const SEARCH_RESULT_PUBLICATION_GROWTH = 2;
const SEARCH_HIGHLIGHT_NAME = "modeleaf-pdf-search-hits";
const CURRENT_SEARCH_HIGHLIGHT_NAME = "modeleaf-pdf-search-current";
type HighlightRegistry = {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
};
const highlightOwners = new WeakMap<object, object>();
type IndexedTextNode = {
  readonly node: Text | HTMLBRElement;
  readonly start: number;
  readonly end: number;
};
type ExactSearchRange = {
  readonly range: Range;
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
  geometryRanges?: PdfSearchGeometryRange[],
  pageCharacters?: { value: number },
): void => {
  for (const item of content.items) {
    if (deadline !== undefined) assertDeadline(deadline);
    if (itemCount.value >= 100_000) throw new Error("TEXT_LIMIT");
    itemCount.value += 1;
    if (typeof item.str !== "string") continue;
    const value = item.hasEOL ? `${item.str}\n` : item.str;
    const start = pageCharacters?.value ?? 0;
    if (pageCharacters !== undefined) pageCharacters.value += value.length;
    if (geometryRanges !== undefined && item.str.length > 0 && item.transform !== undefined && item.transform.length >= 6) {
      const [a, b, c, d, x, y] = item.transform;
      const style = item.fontName === undefined ? undefined : content.styles?.[item.fontName] as { readonly vertical?: boolean } | undefined;
      const vertical = style?.vertical === true;
      const advanceLength = Math.hypot(a ?? 0, b ?? 0);
      const thicknessLength = Math.hypot(c ?? 0, d ?? 0);
      const primaryX = advanceLength > 0 ? a! / advanceLength : 1;
      const primaryY = advanceLength > 0 ? b! / advanceLength : 0;
      const secondaryX = thicknessLength > 0 ? c! / thicknessLength : -primaryY;
      const secondaryY = thicknessLength > 0 ? d! / thicknessLength : primaryX;
      const advanceX = vertical ? secondaryX : primaryX;
      const advanceY = vertical ? secondaryY : primaryY;
      const thicknessX = vertical ? primaryX : secondaryX;
      const thicknessY = vertical ? primaryY : secondaryY;
      const width = Math.abs((vertical ? item.height : item.width) ?? advanceLength);
      const height = Math.abs((vertical ? item.width : item.height) ?? thicknessLength);
      if ([x, y, advanceX, advanceY, thicknessX, thicknessY, width, height].every(Number.isFinite) && width > 0 && height > 0) {
        geometryRanges.push({ start, end: start + item.str.length, originX: x!, originY: y!, advanceX, advanceY, thicknessX, thicknessY, width, height, reverse: item.dir === "rtl" });
      }
    }
    const nextPageBytes = addPdfTextUtf8Bytes(pageBytes.value, value);
    const nextDocumentBytes = addPdfTextUtf8Bytes(documentBytes.value, value, RESOURCE_LIMITS.maxTextDocumentBytes);
    if (nextPageBytes === undefined || nextDocumentBytes === undefined) throw new Error("TEXT_LIMIT");
    pageBytes.value = nextPageBytes;
    documentBytes.value = nextDocumentBytes;
    if (value.length > 0) chunks.push(value);
  }
};

const geometryForTextRange = (ranges: readonly PdfSearchGeometryRange[], start: number, end: number): PdfSearchGeometry | undefined => {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const range of ranges) {
    const overlapStart = Math.max(start, range.start);
    const overlapEnd = Math.min(end, range.end);
    if (overlapStart >= overlapEnd || range.end <= range.start) continue;
    const startRatio = (overlapStart - range.start) / (range.end - range.start);
    const endRatio = (overlapEnd - range.start) / (range.end - range.start);
    const startDistance = range.width * (range.reverse ? 1 - endRatio : startRatio);
    const endDistance = range.width * (range.reverse ? 1 - startRatio : endRatio);
    const startX = range.originX + range.advanceX * startDistance;
    const startY = range.originY + range.advanceY * startDistance;
    const endX = range.originX + range.advanceX * endDistance;
    const endY = range.originY + range.advanceY * endDistance;
    const corners = [
      [startX, startY],
      [endX, endY],
      [startX + range.thicknessX * range.height, startY + range.thicknessY * range.height],
      [endX + range.thicknessX * range.height, endY + range.thicknessY * range.height],
    ] as const;
    for (const [x, y] of corners) {
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  return [left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : undefined;
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
    if (protocol !== "mailto:") return false;
    const separator = value.indexOf(":");
    const remainder = separator < 0 ? "" : value.slice(separator + 1);
    return parsed.host.length === 0
      && !remainder.startsWith("/")
      && parsed.pathname.length > 0
      && parsed.hash.length === 0
      && !remainder.includes("#")
      && !hasInvalidMailtoEscapeOrControl(value);
  } catch {
    return false;
  }
};

const hasInvalidMailtoEscapeOrControl = (value: string): boolean => {
  const isControlByte = (byte: number): boolean => byte <= 0x1f || byte === 0x7f;
  for (let index = 0; index < value.length;) {
    if (value[index] !== "%") {
      index += 1;
      continue;
    }
    const runStart = index;
    const bytes: number[] = [];
    while (index < value.length && value[index] === "%") {
      const high = value.charCodeAt(index + 1);
      const low = value.charCodeAt(index + 2);
      const isHex = (code: number): boolean => (code >= 0x30 && code <= 0x39)
        || (code >= 0x41 && code <= 0x46)
        || (code >= 0x61 && code <= 0x66);
      if (!Number.isFinite(high) || !Number.isFinite(low) || !isHex(high) || !isHex(low)) return true;
      const highValue = high <= 0x39 ? high - 0x30 : high <= 0x46 ? high - 0x41 + 10 : high - 0x61 + 10;
      const lowValue = low <= 0x39 ? low - 0x30 : low <= 0x46 ? low - 0x41 + 10 : low - 0x61 + 10;
      bytes.push((highValue << 4) | lowValue);
      index += 3;
    }
    if (bytes.some(isControlByte)) return true;
    try {
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(decodeURIComponent(value.slice(runStart, index)))) return true;
    } catch {
      if (bytes.some((byte) => byte >= 0x80 && byte <= 0x9f)) return true;
    }
  }
  return false;
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
  private readonly appliedDestinationLandings = new Map<number, { readonly pageIndex: number; readonly x: number; readonly y: number }>();
  private readonly destinationMarkerPoints = new Map<number, { readonly pageIndex: number; readonly x: number; readonly y: number }>();
  private pendingDestination: {
    readonly document: PdfContentDocument;
    readonly generation: number;
    readonly pageNumber: number;
    readonly intentId: number;
    readonly preservedPoint: readonly [number, number] | undefined;
    readonly destination: readonly unknown[];
  } | undefined;
  private destinationScrollSettlement: { readonly intentId: number; readonly promise: Promise<void>; readonly finish: () => void } | undefined;
  private destinationSequence = 0;
  private linkActivationSequence = 0;
  private hintActivationEpoch = 0;
  private visibleLinkRevision = 0;
  private visibleLinkSelectionSequence = 0;
  private readonly activatedVisibleLinkSelections = new WeakMap<PdfVisibleLinkSnapshot, Set<PdfVisibleLinkSelectionId>>();
  private destinationIndicator: HTMLElement | undefined;
  private destinationIndicatorTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly resolvedDestinationPages = new WeakMap<PdfContentAnnotation, number>();
  private renderSequence = 0;
  private sessionId: string | undefined;
  private externalDispatchSequence = 0;
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
  private pendingResultIndex: number | undefined;
  private selectionSequence = 0;
  private extractedPageGeometries: PdfSearchGeometryRange[] = [];
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
  private interactionsEnabled = true;
  private interactionEpoch = 0;
  private registryQuarantined: { readonly revision: number; readonly reason: unknown } | undefined;
  private readonly publishedRegistryFinalizers = new Map<number, PublishedRegistryFinalizer>();
  private unsettledVisibleTextCleanup: Promise<void> | undefined;
  private visibleLinkGroups: LinkGroup[] = [];
  private readonly visiblePageNumbers = new Set<number>();
  private readonly linkActivationSettlements = new Set<Promise<void>>();
  private readonly externalDispatchSettlements = new Set<Promise<void>>();
  private readonly deferredRegistryCleanups = new Map<number, DeferredRegistryCleanup>();
  private mountedEpoch = 0;
  private closingEpoch: number | undefined;

  public constructor(private readonly options: PdfContentControllerOptions) {}

  public get searchQuery(): string { return this.query; }
  public get visibleLinkSnapshot(): PdfVisibleLinkSnapshot {
    const host = this.options.host;
    const bounds = typeof host.getBoundingClientRect === "function" ? host.getBoundingClientRect() : undefined;
    const width = this.viewportExtent(host.clientWidth, bounds?.width);
    const height = this.viewportExtent(host.clientHeight, bounds?.height);
    const candidates: PdfVisibleLinkCandidate[] = [];
    let truncated = false;
    for (const group of this.visibleLinkGroups) {
      if (!this.isActionableLinkGroup(group)) continue;
      const rect = this.visibleLinkGeometry(group);
      if (rect === undefined) continue;
      if (candidates.length >= MAX_VISIBLE_LINK_CANDIDATES) {
        truncated = true;
        break;
      }
      candidates.push(Object.freeze({
        selectionId: group.selectionId,
        pageNumber: group.pageNumber,
        kind: group.annotation.url === undefined ? "internal" : "external",
        rect: Object.freeze(rect),
        ...(group.annotation.url === undefined ? {} : { url: group.annotation.url }),
      }));
    }
    return Object.freeze({
      revision: this.visibleLinkRevision,
      generation: this.generation ?? null,
      viewport: Object.freeze({ x: 0, y: 0, width, height }),
      scrollLeft: Number.isFinite(host.scrollLeft) ? host.scrollLeft : 0,
      scrollTop: Number.isFinite(host.scrollTop) ? host.scrollTop : 0,
      truncated,
      candidates: Object.freeze(candidates),
    });
  }

  public async activateVisibleLink(
    snapshot: PdfVisibleLinkSnapshot,
    selectionId: PdfVisibleLinkSelectionId,
    confirmExternal = false,
  ): Promise<PdfLinkActivationResult> {
    if (!this.interactionsEnabled || this.isClosing() || !this.isVisibleLinkSnapshotCurrent(snapshot)) return { kind: "stale" };
    const group = this.visibleLinkGroups.find((candidate) => candidate.selectionId === selectionId);
    const selected = snapshot.candidates.find((candidate) => candidate.selectionId === selectionId);
    const currentSelected = this.visibleLinkSnapshot.candidates.find((candidate) => candidate.selectionId === selectionId);
    if (currentSelected === undefined || selected === undefined
      || currentSelected.pageNumber !== selected.pageNumber
      || currentSelected.kind !== selected.kind
      || currentSelected.url !== selected.url
      || currentSelected.rect.x !== selected.rect.x
      || currentSelected.rect.y !== selected.rect.y
      || currentSelected.rect.width !== selected.rect.width
      || currentSelected.rect.height !== selected.rect.height) return { kind: "stale" };
    if (group === undefined || selected === undefined || !this.isActionableLinkGroup(group)) return { kind: "stale" };
    if (group.annotation.url !== undefined && !confirmExternal) return { kind: "confirmation-required", url: group.annotation.url };
    const activated = this.activatedVisibleLinkSelections.get(snapshot);
    if (activated?.has(selectionId)) return { kind: "already-activated" };
    if (activated === undefined) this.activatedVisibleLinkSelections.set(snapshot, new Set([selectionId]));
    else activated.add(selectionId);
    const outcome = await this.activateLink(group, "internal-link", true, true, snapshot.revision);
    return outcome;
  }
  public get snapshot(): PdfContentSnapshot {
    return {
      pageNumber: this.renderedPage ?? this.evictedPage ?? null,
      query: this.query,
      generation: this.generation ?? null,
      results: [...this.results],
      currentResult: this.currentResult,
      searchPending: this.searchPending,
      searchIncomplete: this.searchIncomplete,
    };
  }

  public mount(document: PdfContentDocument, generation: number, sessionId: string): void {
    this.cancelDestinationIndicator();
    this.visibleLinkRevision += 1;
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
    this.pendingResultIndex = undefined;
    this.appliedDestinationLandings.clear();
    this.destinationMarkerPoints.clear();
    this.pendingDestination = undefined;
    this.searchCleanupFailure = undefined;
    this.partialSearchReason = undefined;
    this.searchIncomplete = false;
    this.evictedPage = undefined;
    this.evictedCurrentResult = undefined;
    this.evictedPage = undefined;
    this.evictedCurrentResult = undefined;
  }

  /** Cancels foreground rendering/search while retaining completed search state. */
  public suspend(): void {
    this.cancelDestinationIndicator();
    this.visibleLinkRevision += 1;
    this.interactionsEnabled = false;
    this.interactionEpoch += 1;
    this.renderSequence += 1;
    this.searchSequence += 1;
    this.pendingResultIndex = undefined;
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
      this.pendingResultIndex = undefined;
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
    this.cancelDestinationIndicator();
    this.visibleLinkRevision += 1;
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
      this.pendingResultIndex = undefined;
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
          request.page.getAnnotations({ intent: "display" }),
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
      const linkGroups = await awaitOwned(
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
        if (retainedPages.has(residentPage)) for (const group of entry.linkGroups) group.registryRevision = registryPublication.revision;
      }
      linkGroups.forEach((group) => { group.registryRevision = registryPublication!.revision; });
      const previousEntry = this.residentEntries.get(request.pageNumber);
      if (previousEntry !== undefined) this.evictPage(request.pageNumber);
      this.externalEntriesByPage = nextExternalEntries;
      this.layer = presentationRoot;
      this.textLayer = textLayer;
      this.renderedViewport = request.viewport;
      this.renderedCanvas = request.canvas;
      this.pendingTextReservation = undefined;
      this.visibleTextReservation = undefined;
      this.residentEntries.set(request.pageNumber, {
        pageNumber: request.pageNumber, layer: presentationRoot, textLayer, annotationLayer, viewport: request.viewport,
        canvas: request.canvas, reservation: reserved.reservation, linkGroups,
      });
      if (this.visiblePageNumbers.size === 0 && this.residentEntries.size === 1) this.visiblePageNumbers.add(request.pageNumber);
      this.refreshVisibleLinks();
      ownsReservation = false;
      this.renderedPage = request.pageNumber;
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
    try {
      this.refreshVisibleLinks();
      this.applyHighlights();
    } catch (error) {
      this.options.onStatus(`PDF resident decoration limited: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }

  public activateVisiblePages(pageNumbers: readonly number[]): number {
    this.visibleLinkRevision += 1;
    const visible = new Set(pageNumbers);
    this.visiblePageNumbers.clear();
    pageNumbers.forEach((page) => this.visiblePageNumbers.add(page));
    const groups = [...this.residentEntries.values()]
      .filter((entry) => visible.has(entry.pageNumber))
      .flatMap((entry) => entry.linkGroups)
      .sort((left, right) => left.pageNumber - right.pageNumber
        || this.compareRectangles(left.rectangles[0]!, right.rectangles[0]!)
        || this.compareStrings(left.key, right.key)
        || this.compareStrings(left.annotationId, right.annotationId));
    this.visibleLinkGroups = groups;
    const indexByAnnotationId = new Map(groups.map((group, index) => [group.annotationId, index + 1] as const));
    for (const entry of this.residentEntries.values()) {
      entry.annotationLayer.querySelectorAll<HTMLElement>(".pdf-link-overlay[data-annotation-id]").forEach((element) => {
        const index = indexByAnnotationId.get(element.dataset.annotationId ?? "");
        if (index === undefined) {
          delete element.dataset.linkIndex;
          element.setAttribute("aria-label", "PDF link");
        } else {
          element.dataset.linkIndex = String(index);
          element.setAttribute("aria-label", `PDF link ${index}`);
        }
      });
    }
    return groups.length;
  }
  /** Releases one resident page's overlays and reservation without disturbing siblings. */
  public evictPage(pageNumber: number): boolean {
    this.cancelDestinationIndicator();
    const remainingVisiblePages = [...new Set(this.visibleLinkGroups.filter((group) => group.pageNumber !== pageNumber).map((group) => group.pageNumber))];
    const entry = this.residentEntries.get(pageNumber);
    if (entry === undefined) return false;
    this.residentEntries.delete(pageNumber);
    this.visiblePageNumbers.delete(pageNumber);
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
      this.visibleLinkGroups = [];
    }
    this.activateVisiblePages(remainingVisiblePages);
    return true;
  }
  /** Prepares and commits native resident authority while retaining rollback ownership. */
  public async beginResidentPageAuthority(pageNumbers: readonly number[]): Promise<PdfResidentAuthorityTransaction> {
    const pages = new Set(pageNumbers);
    if ([...pages].some((page) => !Number.isSafeInteger(page) || page < 1)) throw new Error("PDF_RESIDENT_PAGE_INVALID");
    const priorRevisions = new Map<LinkGroup, number | undefined>();
    for (const entry of this.residentEntries.values()) for (const group of entry.linkGroups) priorRevisions.set(group, group.registryRevision);
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
      if (pages.has(page)) for (const group of entry.linkGroups) group.registryRevision = publication.revision;
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
    const sequence = ++this.searchSequence;
    this.cancelActiveSearch();
    this.releaseResultReservations();
    this.query = "";
    this.results = [];
    this.currentResult = -1;
    this.pendingResultIndex = undefined;
    this.searchPending = false;
    this.searchIncomplete = false;
    this.evictedPage = undefined;
    this.evictedCurrentResult = undefined;
    this.partialSearchReason = undefined;
    this.publishSearchResults(sequence, false);
    this.clearHighlights();
    this.options.onSearchCleared?.();
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
    this.cancelDestinationIndicator();
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

  public takeDestinationLanding(intentId: number): { readonly pageIndex: number; readonly x: number; readonly y: number } | undefined {
    const landing = this.appliedDestinationLandings.get(intentId);
    this.appliedDestinationLandings.delete(intentId);
    return landing;
  }

  public takeDestinationMarker(intentId: number): { readonly pageIndex: number; readonly x: number; readonly y: number } | undefined {
    const point = this.destinationMarkerPoints.get(intentId);
    this.destinationMarkerPoints.delete(intentId);
    return point;
  }
  public cancelDestination(intentId?: number, preserveLinkActivation = false): void {
    this.cancelDestinationIndicator();
    if (intentId === undefined) {
      this.appliedDestinationLandings.clear();
      this.destinationMarkerPoints.clear();
      if (!preserveLinkActivation) this.linkActivationSequence += 1;
      this.pendingDestination = undefined;
      this.destinationScrollSettlement?.finish();
      return;
    }
    if (this.pendingDestination?.intentId === intentId) this.pendingDestination = undefined;
    this.appliedDestinationLandings.delete(intentId);
    this.destinationMarkerPoints.delete(intentId);
    if (this.destinationScrollSettlement?.intentId === intentId) this.destinationScrollSettlement.finish();
  }
  public applyQueuedDestinationToResidentPage(pageNumber: number): boolean {
    if (this.pendingDestination?.pageNumber !== pageNumber) return false;
    const entry = this.residentEntries.get(pageNumber);
    if (entry === undefined) return false;
    this.applyPendingDestination({ pageNumber, viewport: entry.viewport, canvas: entry.canvas });
    return true;
  }
  public awaitDestinationScroll(intentId: number): Promise<void> {
    return this.destinationScrollSettlement?.intentId === intentId ? this.destinationScrollSettlement.promise : Promise.resolve();
  }

  private applyPendingDestination(request: Pick<PdfContentRenderRequest, "pageNumber" | "viewport" | "canvas">): void {
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
    const scrollTo = (
      point: readonly number[],
      placement: { readonly centerX: boolean; readonly centerY: boolean } = { centerX: false, centerY: false },
    ): void => {
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
      const beforeLeft = this.options.host.scrollLeft;
      const beforeTop = this.options.host.scrollTop;
      const maxScrollLeft = Math.max(0, this.options.host.scrollWidth - this.options.host.clientWidth);
      const maxScrollTop = Math.max(0, this.options.host.scrollHeight - this.options.host.clientHeight);
      const requestedLeft = canvasOrigin[0] + point[0]! - (placement.centerX ? this.options.host.clientWidth / 2 : 0);
      const requestedTop = canvasOrigin[1] + point[1]! - (placement.centerY ? this.options.host.clientHeight / 2 : 0);
      const targetLeft = Math.min(maxScrollLeft, Math.max(0, requestedLeft));
      const targetTop = Math.min(maxScrollTop, Math.max(0, requestedTop));
      this.destinationScrollSettlement?.finish();
      let resolveScroll!: () => void;
      const promise = new Promise<void>((resolve) => { resolveScroll = resolve; });
      const finish = (): void => {
        this.options.host.removeEventListener("scroll", finish);
        if (this.destinationScrollSettlement?.intentId === intent.intentId) this.destinationScrollSettlement = undefined;
        resolveScroll();
      };
      this.destinationScrollSettlement = { intentId: intent.intentId, promise, finish };
      this.options.host.addEventListener("scroll", finish, { once: true });
      this.options.host.scrollLeft = targetLeft;
      this.options.host.scrollTop = targetTop;
      const center = request.viewport.convertToPdfPoint(
        this.options.host.scrollLeft - canvasOrigin[0] + this.options.host.clientWidth / 2,
        this.options.host.scrollTop - canvasOrigin[1] + this.options.host.clientHeight / 2,
      );
      if (Number.isFinite(center[0]) && Number.isFinite(center[1])) {
        this.appliedDestinationLandings.set(intent.intentId, { pageIndex: request.pageNumber - 1, x: center[0], y: center[1] });
      }
      if (this.options.host.scrollLeft === beforeLeft && this.options.host.scrollTop === beforeTop) queueMicrotask(finish);
    };

    if (name === "FitR"
      && finite(intent.destination[2])
      && finite(intent.destination[3])
      && finite(intent.destination[4])
      && finite(intent.destination[5])) {
      const first = request.viewport.convertToViewportPoint(intent.destination[2], intent.destination[3]);
      const second = request.viewport.convertToViewportPoint(intent.destination[4], intent.destination[5]);
      const targetViewportX = Math.min(first[0], second[0]);
      const targetViewportY = Math.min(first[1], second[1]);
      const markerPoint = request.viewport.convertToPdfPoint(targetViewportX, targetViewportY);
      if (Number.isFinite(markerPoint[0]) && Number.isFinite(markerPoint[1])) {
        this.destinationMarkerPoints.set(intent.intentId, { pageIndex: request.pageNumber - 1, x: markerPoint[0], y: markerPoint[1] });
      }
      scrollTo([targetViewportX, targetViewportY]);
      return;
    }

    if (name === "Fit" || name === "FitB") {
      scrollTo([0, 0]);
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
    if (destinationX !== undefined || destinationY !== undefined) {
      this.destinationMarkerPoints.set(intent.intentId, { pageIndex: request.pageNumber - 1, x: targetX, y: targetY });
    }
    const rotation = ((request.viewport.rotation % 360) + 360) % 360;
    const swapsAxes = rotation === 90 || rotation === 270;
    scrollTo(request.viewport.convertToViewportPoint(targetX, targetY), {
      centerX: name === "XYZ" && (swapsAxes ? destinationY !== undefined : destinationX !== undefined),
      centerY: name === "XYZ" && (swapsAxes ? destinationX !== undefined : destinationY !== undefined),
    });
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
    this.pendingResultIndex = undefined;
    this.searchPending = false;
    this.searchIncomplete = false;
    if (!restoreEvictedResult) this.evictedCurrentResult = undefined;
    this.partialSearchReason = undefined;
    this.clearHighlights();
    if (encoder.encode(source).byteLength > RESOURCE_LIMITS.maxTextPageBytes) {
      this.options.onStatus("TEXT_LIMIT", "search");
      return;
    }
    const normalized = normalizePdfSearchQuery(query);
    if (normalized.length === 0) { this.options.onSearchCleared?.(); return; }
    this.query = normalized;
    this.searchPending = true;
    this.options.onStatus(`Searching “${normalized}”…`, "search");
    this.publishSearchResults(sequence, false);
    const failBeforeExtraction = (message: string): void => {
      if (sequence !== this.searchSequence) return;
      this.searchPending = false;
      this.searchIncomplete = true;
      this.publishSearchResults(sequence, false);
      this.options.onStatus(message, "search");
    };
    const previous = this.activeSearchSettlement;
    if (previous !== undefined) {
      try {
        await this.withDeadline(previous, Math.max(1, deadline - Date.now()));
      } catch {
        failBeforeExtraction("Search cleanup timed out.");
        return;
      }
    }
    if (sequence !== this.searchSequence) return;
    const cleanupFailure = this.searchCleanupFailure;
    if (cleanupFailure !== undefined && cleanupFailure.document === this.document && cleanupFailure.generation === this.generation) {
      failBeforeExtraction(cleanupFailure.message);
      return;
    }
    const generation = this.generation;
    const document = this.document;
    const sessionId = this.sessionId;
    if (Date.now() >= deadline) {
      failBeforeExtraction("Search timed out.");
      return;
    }
    this.clearHighlights();
    if (generation === undefined || document === undefined || sessionId === undefined) {
      failBeforeExtraction("Search is unavailable.");
      return;
    }
    const extractor = this.options.resources.reserve({ kind: "search-extractor", amount: 1, sessionId });
    const documentText = this.options.resources.reserve({ kind: "text-document-bytes", amount: RESOURCE_LIMITS.maxTextDocumentBytes, sessionId });
    const reservationFailure = !extractor.ok ? extractor.tag : !documentText.ok ? documentText.tag : undefined;
    if (reservationFailure !== undefined) {
      if (extractor.ok) this.options.resources.release(extractor.reservation);
      if (documentText.ok) this.options.resources.release(documentText.reservation);
      failBeforeExtraction(reservationFailure);
      return;
    }
    if (!extractor.ok || !documentText.ok) return;
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => { resolveSettlement = resolve; });
    this.activeSearchSettlement = settlement;
    const documentBytes = { value: 0 };
    let hasExtractedText = false;
    let deferredSearchCleanup: Promise<void> | undefined;
    let lastPublishedResultCount = 0;
    let lastPublishedHasText = false;
    let lastPublishedPending = true;
    let lastPublishedIncomplete = false;
    let nextPublicationResultCount = 1;
    let initialLandingStarted = false;
    const publishDiscoveredResults = (force: boolean): void => {
      if (!this.isCurrent(generation, document) || sequence !== this.searchSequence) return;
      const changed = this.results.length !== lastPublishedResultCount
        || hasExtractedText !== lastPublishedHasText
        || this.searchPending !== lastPublishedPending
        || this.searchIncomplete !== lastPublishedIncomplete;
      if (!changed || (!force && this.results.length < nextPublicationResultCount)) return;
      this.publishSearchResults(sequence, hasExtractedText);
      lastPublishedResultCount = this.results.length;
      lastPublishedHasText = hasExtractedText;
      lastPublishedPending = this.searchPending;
      lastPublishedIncomplete = this.searchIncomplete;
      if (this.results.length > 0) {
        nextPublicationResultCount = Math.min(
          MAX_RESULTS + 1,
          Math.max(this.results.length + 1, this.results.length * SEARCH_RESULT_PUBLICATION_GROWTH),
        );
      }
    };
    const beginInitialLanding = (): void => {
      if (restoreEvictedResult || initialLandingStarted || this.currentResult >= 0 || this.pendingResultIndex !== undefined) return;
      const index = this.results.findIndex((result) => result.geometry !== undefined);
      if (index < 0) return;
      initialLandingStarted = true;
      publishDiscoveredResults(true);
      if (!this.isCurrent(generation, document) || sequence !== this.searchSequence) return;
      const landing = this.selectMatch(index, "initial", generation, document, sequence);
      void landing.catch((error: unknown) => {
        if (this.isCurrent(generation, document) && sequence === this.searchSequence) {
          this.options.onStatus(`Search result landing failed: ${error instanceof Error ? error.message : String(error)}`, "search");
        }
      });
    };
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
        if (text.trim().length > 0) hasExtractedText = true;
        const folded = foldLiteral(text, deadline);
        let index = folded.value.indexOf(normalized);
        while (index !== -1) {
          assertDeadline(deadline);
          if (this.results.length >= MAX_RESULTS || !this.reserveResultSlot(sessionId)) throw new Error("Search reached the result limit.");
          const originalStart = folded.starts[index]!;
          const originalEnd = folded.ends[index + normalized.length - 1]!;
          const geometry = geometryForTextRange(this.extractedPageGeometries, originalStart, originalEnd);
          this.results.push({ pageNumber, index: originalStart, length: originalEnd - originalStart, ...(geometry === undefined ? {} : { geometry }) });
          index = folded.value.indexOf(normalized, index + Math.max(1, normalized.length));
        }
        beginInitialLanding();
        publishDiscoveredResults(false);
        await (this.options.scheduleSearchWork?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 0)));
        if (!this.isCurrent(generation, document) || sequence !== this.searchSequence) return;
      }
      assertDeadline(deadline);
      if (!this.isCurrent(generation, document) || sequence !== this.searchSequence) return;
      this.searchPending = false;
      if (this.results.length === 0) {
        publishDiscoveredResults(true);
        this.options.onStatus(hasExtractedText ? `No matches · “${this.query}”` : `No searchable text · “${this.query}”`, "search");
      } else {
        this.applyHighlights(deadline);
        if (restoreEvictedResult) {
          const preferredIndex = this.evictedCurrentResult === undefined ? 0 : Math.min(this.evictedCurrentResult, this.results.length - 1);
          const index = this.results[preferredIndex]?.geometry !== undefined ? preferredIndex : this.results.findIndex((result) => result.geometry !== undefined);
          if (index < 0) {
            publishDiscoveredResults(true);
            this.options.onStatus("Search result location unavailable.", "search");
            return;
          }
          const selected = await this.selectMatch(index, "restore", generation, document, sequence);
          if (!this.isCurrent(generation, document) || sequence !== this.searchSequence) return;
          if (selected !== null) this.evictedCurrentResult = undefined;
          else {
            this.evictedCurrentResult = preferredIndex;
            this.searchIncomplete = true;
          }
          publishDiscoveredResults(true);
          if (selected === null) this.options.onStatus("Search result location unavailable.", "search");
        } else {
          publishDiscoveredResults(true);
          if (this.pendingResultIndex !== undefined) {
            this.options.onStatus(`Search complete · ${this.results.length} ${this.results.length === 1 ? "match" : "matches"} · “${this.query}”`, "search");
          } else if (this.currentResult >= 0) {
            this.reportCurrentMatch("");
          } else {
            this.options.onStatus("Search result location unavailable.", "search");
          }
        }
      }
    } catch (error) {
      let cause = error instanceof Error ? error.message : "Search could not be completed.";
      if (deferredSearchCleanup !== undefined && !cause.startsWith("Search cleanup failed:")) cause = `Search cleanup failed: ${cause}`;
      if (cause.startsWith("Search cleanup failed:")) {
        this.searchCleanupFailure = { document, generation, message: cause };
        deferredSearchCleanup = this.unsettledSearchCleanup;
      }
      if (this.isCurrent(generation, document) && sequence === this.searchSequence) {
        this.searchPending = false;
        this.searchIncomplete = true;
        if (this.results.length > 0) this.partialSearchReason = cause;
        publishDiscoveredResults(true);
        if (this.results.length > 0) {
          if (Date.now() < deadline) {
            try { this.applyHighlights(deadline); } catch { /* The primary search failure remains authoritative. */ }
          }
          this.options.onStatus(`Search results are partial: ${cause}`, "search");
        } else {
          this.options.onStatus(cause, "search");
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
  public async nextMatch(reverse = false): Promise<PdfSearchResult | null> {
    const generation = this.generation; const document = this.document; const sequence = this.searchSequence;
    if (this.results.length === 0 || generation === undefined || document === undefined || this.searchIncomplete) return null;
    const cursor = this.pendingResultIndex ?? this.currentResult;
    const baseIndex = cursor >= 0 ? cursor : reverse ? 0 : -1;
    let index = baseIndex;
    for (let offset = 0; offset < this.results.length; offset += 1) {
      index = (index + (reverse ? -1 : 1) + this.results.length) % this.results.length;
      if (this.results[index]?.geometry !== undefined) return this.selectMatch(index, reverse ? "previous" : "next", generation, document, sequence);
    }
    this.options.onStatus("Search result location unavailable.", "search");
    return null;
  }

  private async selectMatch(index: number, provenance: PdfSearchLandingRequest["provenance"], generation: number, document: PdfContentDocument, sequence: number): Promise<PdfSearchResult | null> {
    const result = this.results[index];
    if (result === undefined || !this.isCurrent(generation, document) || sequence !== this.searchSequence) return null;
    if (result.geometry === undefined) {
      this.options.onStatus("Search result location unavailable.", "search");
      return null;
    }
    this.pendingResultIndex = index;
    const selectionSequence = ++this.selectionSequence;
    let outcome: PdfSearchLandingOutcome;
    try { outcome = await this.options.requestSearchLanding({ searchGeneration: sequence, selectionSequence, resultIndex: index, result, provenance }); } catch { outcome = "failedWithoutMovement"; }
    if (!this.isCurrent(generation, document) || sequence !== this.searchSequence || selectionSequence !== this.selectionSequence) return null;
    if (outcome === "stale") { this.pendingResultIndex = undefined; return null; }
    if (outcome !== "displayedDistinct" && outcome !== "displayedSame") { this.pendingResultIndex = undefined; return null; }
    this.currentResult = index; this.pendingResultIndex = undefined; this.reportCurrentMatch(""); this.applyHighlights(); return result;
  }

  public cancelVisibleLinkActivation(): void {
    this.hintActivationEpoch += 1;
    this.visibleLinkRevision += 1;
    this.cancelDestinationIndicator();
  }
  public clearVisibleLinkAuthority(): void {
    this.linkActivationSequence += 1;
    this.visibleLinkRevision += 1;
    this.cancelDestinationIndicator();
    this.appliedDestinationLandings.clear();
    this.destinationMarkerPoints.clear();
    this.visiblePageNumbers.clear();
    this.visibleLinkGroups = [];
    for (const entry of this.residentEntries.values()) {
      entry.annotationLayer.querySelectorAll<HTMLElement>(".pdf-link-overlay[data-annotation-id]").forEach((element) => {
        delete element.dataset.linkIndex;
        element.setAttribute("aria-label", "PDF link");
      });
    }
  }
  private viewportExtent(primary: number, fallback: number | undefined): number {
    if (Number.isFinite(primary) && primary > 0) return primary;
    return fallback !== undefined && Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
  }

  private isActionableLinkGroup(group: LinkGroup): boolean {
    if (group.annotation.url !== undefined) return isExternalUrl(group.annotation.url);
    return group.annotation.action === undefined
      && group.annotation.dest !== undefined
      && !group.key.startsWith("unsupported-");
  }

  private visibleLinkGeometry(group: LinkGroup): PdfVisibleLinkGeometry | undefined {
    const entry = this.residentEntries.get(group.pageNumber);
    const rectangle = group.rectangles[0];
    if (entry === undefined || rectangle === undefined) return undefined;
    const host = this.options.host;
    const bounds = typeof host.getBoundingClientRect === "function" ? host.getBoundingClientRect() : undefined;
    const width = this.viewportExtent(host.clientWidth, bounds?.width);
    const height = this.viewportExtent(host.clientHeight, bounds?.height);
    if (!(width > 0 && height > 0)) return undefined;
    const origin = this.canvasScrollOrigin(entry.canvas);
    const left = origin[0] + rectangle.left - host.scrollLeft;
    const top = origin[1] + rectangle.top - host.scrollTop;
    const right = left + rectangle.width;
    const bottom = top + rectangle.height;
    const clippedLeft = Math.max(0, left);
    const clippedTop = Math.max(0, top);
    const clippedRight = Math.min(width, right);
    const clippedBottom = Math.min(height, bottom);
    return Number.isFinite(clippedLeft) && Number.isFinite(clippedTop)
      && Number.isFinite(clippedRight) && Number.isFinite(clippedBottom)
      && clippedRight > clippedLeft && clippedBottom > clippedTop
      ? { x: clippedLeft, y: clippedTop, width: clippedRight - clippedLeft, height: clippedBottom - clippedTop }
      : undefined;
  }

  private isVisibleLinkSnapshotCurrent(snapshot: PdfVisibleLinkSnapshot): boolean {
    if (snapshot.generation !== (this.generation ?? null)
      || snapshot.revision !== this.visibleLinkRevision) return false;
    const current = this.visibleLinkSnapshot;
    if (current.scrollLeft !== snapshot.scrollLeft || current.scrollTop !== snapshot.scrollTop
      || current.viewport.width !== snapshot.viewport.width || current.viewport.height !== snapshot.viewport.height) return false;
    return true;
  }

  private showDestinationIndicator(
    landing: { readonly pageIndex: number; readonly x: number; readonly y: number },
    isCurrent: () => boolean,
  ): void {
    if (!isCurrent()) return;
    const entry = this.residentEntries.get(landing.pageIndex + 1);
    if (entry === undefined || !Number.isFinite(landing.x) || !Number.isFinite(landing.y)) return;
    const [x, y] = entry.viewport.convertToViewportPoint(landing.x, landing.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)
      || x < 0 || y < 0 || x > entry.viewport.width || y > entry.viewport.height) return;
    this.cancelDestinationIndicator();
    const indicator = documentCreate("div", "pdf-destination-indicator");
    indicator.setAttribute("aria-hidden", "true");
    indicator.style.position = "absolute";
    indicator.style.left = `${x}px`;
    indicator.style.top = `${y}px`;
    indicator.style.width = "28px";
    indicator.style.height = "28px";
    indicator.style.boxSizing = "border-box";
    indicator.style.border = "2px solid currentColor";
    indicator.style.borderRadius = "50%";
    indicator.style.pointerEvents = "none";
    indicator.style.transform = "translate(-50%, -50%) scale(1)";
    indicator.style.opacity = "0.9";
    indicator.style.zIndex = "2";
    entry.annotationLayer.append(indicator);
    this.destinationIndicator = indicator;
    const generation = this.interactionEpoch;
    const timer = setTimeout(() => {
      if (this.destinationIndicator !== indicator || generation !== this.interactionEpoch) return;
      this.cancelDestinationIndicator();
    }, 900);
    this.destinationIndicatorTimer = timer;
  }

  private cancelDestinationIndicator(): void {
    if (this.destinationIndicatorTimer !== undefined) clearTimeout(this.destinationIndicatorTimer);
    this.destinationIndicatorTimer = undefined;
    this.destinationIndicator?.remove();
    this.destinationIndicator = undefined;
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
    const linkGroups: LinkGroup[] = [];
    for (const candidate of candidates.sort((left, right) => this.compareRectangles(left.rect, right.rect) || left.index - right.index)) {
      if (linkGroups.some((group) => group.key === candidate.key
        && group.rectangles[0]!.left === candidate.rect.left
        && group.rectangles[0]!.top === candidate.rect.top
        && group.rectangles[0]!.width === candidate.rect.width
        && group.rectangles[0]!.height === candidate.rect.height)) continue;
      linkGroups.push({
        pageNumber,
        key: candidate.key,
        annotation: candidate.annotation,
        annotationId: candidate.annotationId,
        selectionId: `pdf-link-${this.mountedEpoch}-${++this.visibleLinkSelectionSequence}`,
        registryRevision: undefined,
        rectangles: [candidate.rect],
      });
    }
    linkGroups.sort((left, right) => this.compareRectangles(left.rectangles[0]!, right.rectangles[0]!)
      || this.compareStrings(left.key, right.key)
      || this.compareStrings(left.annotationId, right.annotationId));
    linkGroups.forEach((group) => {
      group.rectangles.forEach((rect) => {
        const target = documentCreate("button", "pdf-link-overlay");
        target.type = "button";
        target.style.position = "absolute";
        target.style.left = `${rect.left}px`;
        target.style.top = `${rect.top}px`;
        target.style.width = `${rect.width}px`;
        target.style.height = `${rect.height}px`;
        target.style.pointerEvents = "auto";
        target.dataset.annotationId = group.annotationId;
        target.setAttribute("aria-label", "PDF link");
        const borderWidth = group.annotation.borderStyle?.width;
        if (typeof borderWidth !== "number" || !Number.isFinite(borderWidth)) {
          target.dataset.pdfBorder = "missing";
        } else if (borderWidth <= 0) {
          target.dataset.pdfBorder = "zero";
          target.dataset.pdfBorderWidth = String(borderWidth);
        } else {
          target.dataset.pdfBorder = "positive";
          target.dataset.pdfBorderWidth = String(borderWidth);
          target.style.borderWidth = `${Math.min(4, Math.max(1, borderWidth))}px`;
          target.style.borderStyle = group.annotation.borderStyle?.style === 2 ? "dashed" : "solid";
          const annotationColor = group.annotation.color;
          if (annotationColor !== undefined && annotationColor !== null && annotationColor.length >= 3) {
            const channels = [annotationColor[0], annotationColor[1], annotationColor[2]].map(Number);
            if (channels.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255)) {
              target.style.setProperty("--pdf-link-border-color", `rgb(${channels.map((channel) => Math.round(channel)).join(" ")})`);
            }
          }
        }
        target.addEventListener("click", () => {
          if (this.interactionsEnabled && this.isCurrent(generation, document) && !this.isClosing()) void this.activateLink(group, "internal-link");
        });
        layer.append(target);
      });
    });
    return linkGroups;
  }

  private async activateLink(
    group: LinkGroup,
    cause: PdfLinkActivationCause,
    externalConfirmed = true,
    showIndicator = false,
    authorityRevision?: number,
  ): Promise<PdfLinkActivationResult> {
    const document = this.document;
    const generation = this.generation;
    if (!this.interactionsEnabled || document === undefined || generation === undefined || this.isClosing()) return { kind: "rejected" };
    const interactionEpoch = this.interactionEpoch;
    const { annotation } = group;
    const activation = ++this.linkActivationSequence;
    const hintActivationEpoch = authorityRevision === undefined ? undefined : this.hintActivationEpoch;
    const isOwnerActive = (): boolean => activation === this.linkActivationSequence
      && interactionEpoch === this.interactionEpoch
      && this.interactionsEnabled
      && this.isCurrent(generation, document)
      && (hintActivationEpoch === undefined || hintActivationEpoch === this.hintActivationEpoch);
    const isAuthorityCurrent = (): boolean => authorityRevision === undefined || authorityRevision === this.visibleLinkRevision;
    const isActive = (): boolean => isOwnerActive()
      && this.visibleLinkGroups.includes(group)
      && this.residentEntries.get(group.pageNumber)?.linkGroups.includes(group) === true;

    if (annotation.url !== undefined) {
      if (!isExternalUrl(annotation.url)) {
        if (isActive()) {
          this.options.onStatus("Unsupported PDF link destination.");
          this.markLinkOutcome(group, "unsupported");
        }
        return { kind: "unsupported" };
      }
      if (!externalConfirmed) return { kind: "confirmation-required", url: annotation.url };
      if (!isActive() || !isAuthorityCurrent() || group.registryRevision === undefined) return { kind: "stale" };
      const operationSequence = ++this.externalDispatchSequence;
      const operationId = `external-${this.sessionId ?? "unmounted"}-${group.registryRevision}-${group.annotationId}-${operationSequence}`;
      let rawActivation: Promise<number>;
      try {
        rawActivation = Promise.resolve(this.options.openExternal(group.annotationId, group.registryRevision, operationId, operationSequence));
      } catch (error) {
        rawActivation = Promise.reject(error);
      }
      this.trackLinkActivation("external", rawActivation.then(() => undefined, () => undefined));
      try {
        const reportedSequence = await this.withDeadline(rawActivation, LINK_ACTIVATION_TIMEOUT_MS, "LINK_LAUNCH_TIMEOUT");
        if (!isOwnerActive() || !isActive() || !isAuthorityCurrent()) return { kind: "stale" };
        if (!Number.isSafeInteger(reportedSequence) || reportedSequence !== operationSequence) {
          this.options.onStatus("PDF link dispatch receipt was invalid.");
          return { kind: "failed" };
        }
        this.markLinkOutcome(group, `opened dispatch ${reportedSequence}`);
        this.options.onStatus(`PDF link opened (dispatch ${reportedSequence}).`);
        return { kind: "activated", link: "external" };
      } catch (error) {
        if (!isOwnerActive() || !isActive() || !isAuthorityCurrent()) return { kind: "stale" };
        this.markLinkOutcome(group, `failed ${externalFailureTag(error) ?? "failed"}`);
        this.options.onStatus(isExternalLaunchTimeout(error)
          ? "PDF link launch outcome is unknown; it may still open later."
          : isExternalDispatchExpired(error)
            ? "PDF link was not opened because dispatch expired."
            : "PDF link could not be opened.");
        return { kind: "failed" };
      }
    }
    if (annotation.action !== undefined || annotation.dest === undefined) {
      if (this.visibleLinkGroups.includes(group)) {
        this.options.onStatus("Unsupported PDF link action.");
        this.markLinkOutcome(group, "unsupported");
      }
      return { kind: "unsupported" };
    }

    let releaseSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    this.trackLinkActivation("internal", settlement);
    let rawSettlement = Promise.resolve();
    const deadline = Date.now() + LINK_ACTIVATION_TIMEOUT_MS;
    const remaining = (): number => {
      const milliseconds = deadline - Date.now();
      if (milliseconds <= 0) throw new Error("Link activation timed out.");
      return milliseconds;
    };
    const awaitRaw = async <T>(operation: Promise<T>): Promise<T> => {
      rawSettlement = rawSettlement.then(() => operation.then(() => undefined, () => undefined));
      return this.withDeadline(operation, Math.min(remaining(), INTERNAL_DESTINATION_RESOLUTION_TIMEOUT_MS), "PDF link destination resolution timed out.");
    };
    try {
      const destination = typeof annotation.dest === "string"
        ? await awaitRaw(Promise.resolve(document.getDestination?.(annotation.dest)))
        : annotation.dest;
      if (!isActive()) return { kind: "stale" };
      if (!Array.isArray(destination) || !isValidPdfDestination(destination)) {
        this.options.onStatus("Unsupported PDF link destination.");
        this.markLinkOutcome(group, "unsupported");
        return { kind: "unsupported" };
      }
      const pageNumber = this.resolvedDestinationPages.get(annotation) ?? await this.destinationPage(destination, document, awaitRaw);
      if (!isActive()) return { kind: "stale" };
      if (pageNumber === null) {
        this.options.onStatus("Unsupported PDF link destination.");
        this.markLinkOutcome(group, "unsupported");
        return { kind: "unsupported" };
      }
      if (!isAuthorityCurrent()) return { kind: "stale" };
      const outcome = await awaitRaw(this.options.navigateToDestination(pageNumber, destination, cause, isOwnerActive, showIndicator));
      if (!isOwnerActive()) return { kind: "stale" };
      if (outcome.kind === "verified") {
        if (showIndicator && outcome.landing !== undefined) this.showDestinationIndicator(outcome.landing, isOwnerActive);
        return { kind: "activated", link: "internal", ...(outcome.landing === undefined ? {} : { landing: outcome.landing }) };
      }
      if (outcome.kind === "same-location") return { kind: "same-location" };
      if (outcome.kind === "stale") return { kind: "stale" };
      this.options.onStatus("PDF link destination could not be reached.");
      this.markLinkOutcome(group, `failed ${outcome.kind}`);
      return { kind: "failed" };
    } catch (error) {
      if (!isActive()) return { kind: "stale" };
      this.options.onStatus(error instanceof Error && error.message === "PDF link destination resolution timed out."
        ? error.message
        : "Unsupported PDF link destination.");
      this.markLinkOutcome(group, "unsupported");
      return { kind: "unsupported" };
    } finally {
      void rawSettlement.then(releaseSettlement);
    }
  }
  private destinationReference(value: unknown): { readonly num: number; readonly gen: number } | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const { num, gen } = value as { readonly num?: unknown; readonly gen?: unknown };
    return Number.isSafeInteger(num) && (num as number) >= 0 && Number.isSafeInteger(gen) && (gen as number) >= 0
      ? { num: num as number, gen: gen as number }
      : undefined;
  }

  private async destinationPage(
    destination: readonly unknown[],
    document: PdfContentDocument,
    wait: <T>(operation: Promise<T>) => Promise<T> = (operation) => operation,
  ): Promise<number | null> {
    if (destination.length === 0) return null;
    const reference = destination[0];
    if (typeof reference === "number") {
      return Number.isSafeInteger(reference) && reference >= 0 && reference < document.numPages ? reference + 1 : null;
    }
    const cachedPageNumber = document.cachedPageNumber?.(reference);
    if (cachedPageNumber !== null && cachedPageNumber !== undefined
      && Number.isSafeInteger(cachedPageNumber) && cachedPageNumber >= 1 && cachedPageNumber <= document.numPages) return cachedPageNumber;
    if (this.options.resolveDestinationPage !== undefined) {
      const resolvedByReader = await wait(this.options.resolveDestinationPage(reference));
      return resolvedByReader !== null && Number.isSafeInteger(resolvedByReader)
        && resolvedByReader >= 1 && resolvedByReader <= document.numPages ? resolvedByReader : null;
    }
    if (document.getPageIndex === undefined) return null;
    const index = await wait(document.getPageIndex(reference));
    return Number.isSafeInteger(index) && index >= 0 && index < document.numPages ? index + 1 : null;
  }
  private async destinationKey(annotation: PdfContentAnnotation, _index: number, document: PdfContentDocument): Promise<string | null> {
    if (annotation.url !== undefined) return isExternalUrl(annotation.url) ? `url:${annotation.url}` : `unsupported-url:${annotation.url}`;
    if (annotation.action !== undefined) return `unsupported-action:${annotation.action}`;
    if (annotation.dest === undefined) return null;
    try {
      const destination = typeof annotation.dest === "string" ? await document.getDestination?.(annotation.dest) : annotation.dest;
      if (!Array.isArray(destination) || !isValidPdfDestination(destination)) return `unsupported-dest:${JSON.stringify(this.destinationOperand(annotation.dest))}`;
      const reference = this.destinationReference(destination[0]);
      const suffix = JSON.stringify(destination.slice(1).map((operand) => this.destinationOperand(operand)));
      if (reference !== undefined) return `goto-ref:${reference.num}:${reference.gen}:${suffix}`;
      const page = await this.destinationPage(destination, document);
      if (page === null) return `unsupported-dest:${JSON.stringify(this.destinationOperand(annotation.dest))}`;
      this.resolvedDestinationPages.set(annotation, page);
      return `goto:${page}:${suffix}`;
    } catch {
      return `unsupported-dest:${JSON.stringify(this.destinationOperand(annotation.dest))}`;
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
  private compareRectangles(left: DOMRect, right: DOMRect): number {
    return left.top - right.top
      || left.left - right.left
      || left.height - right.height
      || left.width - right.width;
  }

  private compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  private refreshVisibleLinks(): void {
    const pages = [...this.visiblePageNumbers];
    this.activateVisiblePages(pages);
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
    const awaitPendingExternalDispatches = (): Promise<void> => {
      const settlements = [...this.externalDispatchSettlements];
      return settlements.length === 0 ? Promise.resolve() : Promise.allSettled(settlements).then(() => undefined);
    };
    const staged = enqueue(async () => {
      if (this.isClosing() || this.registryQuarantined !== undefined) {
        terminate();
        throw new Error("PDF link registry is quarantined until unmount.");
      }
      await this.withDeadline(awaitPendingExternalDispatches(), remaining(), "PDF link registry publication timed out.");
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
          await this.withDeadline(awaitPendingExternalDispatches(), remaining(), "PDF link registry publication timed out.");
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
  private publishSearchResults(searchGeneration: number, hasSearchableText: boolean): void {
    if (searchGeneration !== this.searchSequence) return;
    this.options.onSearchResults({
      searchGeneration,
      query: this.query,
      results: [...this.results],
      hasSearchableText,
      searchPending: this.searchPending,
      searchIncomplete: this.searchIncomplete,
    });
  }
  private reportCurrentMatch(suffix: string): void {
    const progress = this.searchPending ? " · Searching…" : "";
    const disclosure = suffix || (this.partialSearchReason === undefined ? "" : ` Search results are partial: ${this.partialSearchReason}`);
    this.options.onStatus(
      `${this.currentResult + 1} / ${this.results.length} · “${this.query}”${progress}${disclosure}`,
      "search",
    );
  }
  private clearHighlights(): void {
    const registry = (globalThis.CSS as (typeof CSS & { highlights?: HighlightRegistry }) | undefined)?.highlights;
    if (registry !== undefined && highlightOwners.get(registry as object) === this) {
      registry.delete(SEARCH_HIGHLIGHT_NAME);
      registry.delete(CURRENT_SEARCH_HIGHLIGHT_NAME);
      highlightOwners.delete(registry as object);
    }
    const layers = new Set<HTMLElement>([...this.residentEntries.values()].map((entry) => entry.layer));
    if (this.layer !== undefined) layers.add(this.layer);
    for (const layer of layers) layer.querySelectorAll<HTMLElement>("[data-search-fallback]").forEach((rectangle) => rectangle.remove());
  }
  private applyHighlights(deadline = Date.now() + SEARCH_TIMEOUT_MS): void {
    this.clearHighlights();
    const residents = [...this.residentEntries.values()];
    if (residents.length === 0 && this.renderedPage !== undefined && this.textLayer !== undefined && this.layer !== undefined) {
      residents.push({ pageNumber: this.renderedPage, textLayer: this.textLayer, layer: this.layer } as ResidentContentEntry);
    }
    const residentRanges = residents.map((entry) => ({ entry, ranges: this.exactSearchRanges(entry.pageNumber, entry.textLayer, deadline) }));
    const ranges = residentRanges.flatMap(({ ranges: pageRanges }) => pageRanges);
    const current = ranges.find(({ resultIndex }) => resultIndex === this.currentResult);
    const registry = (globalThis.CSS as (typeof CSS & { highlights?: HighlightRegistry }) | undefined)?.highlights;
    const HighlightConstructor = (globalThis as typeof globalThis & {
      Highlight?: new (...ranges: Range[]) => unknown;
    }).Highlight;
    if (registry !== undefined && HighlightConstructor !== undefined && ranges.length > 0) {
      highlightOwners.set(registry as object, this);
      registry.set(SEARCH_HIGHLIGHT_NAME, new HighlightConstructor(...ranges.map(({ exact }) => exact.range)));
      if (current !== undefined) registry.set(CURRENT_SEARCH_HIGHLIGHT_NAME, new HighlightConstructor(current.exact.range));
      return;
    }
    for (const { entry, ranges: pageRanges } of residentRanges) {
      const layerBounds = entry.layer.getBoundingClientRect();
      for (const { exact, resultIndex } of pageRanges) {
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
          entry.layer.append(fallback);
        }
      }
    }
  }

  private exactSearchRanges(pageNumber: number, layer: HTMLElement, deadline: number): { readonly exact: ExactSearchRange; readonly resultIndex: number }[] {
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
      if (result.pageNumber !== pageNumber || result.length <= 0) continue;
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
      matches.push({ exact: { range }, resultIndex });
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
    this.cancelDestinationIndicator();
    this.visibleLinkRevision += 1;
    this.appliedDestinationLandings.clear();
    this.destinationMarkerPoints.clear();
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
    this.visibleLinkGroups = [];
  }
  private trackLinkActivation(kind: "internal" | "external", settlement: Promise<void>): void {
    this.linkActivationSettlements.add(settlement);
    if (kind === "external") this.externalDispatchSettlements.add(settlement);
    void settlement.then(() => {
      this.linkActivationSettlements.delete(settlement);
      if (kind === "external") this.externalDispatchSettlements.delete(settlement);
    });
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
  private markLinkOutcome(group: LinkGroup, outcome: string): void {
    for (const entry of this.residentEntries.values()) {
      for (const target of entry.layer.querySelectorAll<HTMLElement>(".pdf-link-overlay")) {
        if (target.dataset.annotationId !== group.annotationId) continue;
        const index = target.dataset.linkIndex;
        const label = index === undefined ? "PDF link" : `PDF link ${index}`;
        target.setAttribute("aria-label", `${label} ${outcome}`);
      }
    }
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
    this.extractedPageGeometries = [];
    const pageCharacters = { value: 0 };
    const mergedStyles: Record<string, unknown> = {};
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
        Object.assign(mergedStyles, next.value.styles);
        appendBoundedText(chunks, { ...next.value, styles: mergedStyles }, pageBytes, documentBytes, itemCount, deadline, this.extractedPageGeometries, pageCharacters);
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
const MAX_VISIBLE_LINK_CANDIDATES = 256
