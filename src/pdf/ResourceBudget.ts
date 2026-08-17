export const MEBIBYTE = 1_048_576;

/** Authoritative CP0 process-wide limits. */
export const RESOURCE_LIMITS = Object.freeze({
  maxDocumentBytes: 512 * MEBIBYTE,
  maxSessions: 8,
  normalRangeBytes: MEBIBYTE,
  maxRangeBytes: 4 * MEBIBYTE,
  maxRangeWorkProcess: 4,
  maxRangeWorkSession: 2,
  maxRangeQueueProcess: 32,
  maxRangeQueueSession: 8,
  maxRendersProcess: 1,
  maxResidentPageViews: 16,
  maxDevicePixelRatio: 2,
  maxCanvasDimension: 32_768,
  maxCanvasPixels: 64_000_000,
  maxCanvasBytes: 256 * MEBIBYTE,
  maxCanvasCacheBytes: 128 * MEBIBYTE,
  maxImagePixels: 25_000_000,
  maxTextPageBytes: 2 * MEBIBYTE,
  maxTextDocumentBytes: 64 * MEBIBYTE,
  maxTextProcessBytes: 128 * MEBIBYTE,
  maxSearchResultsDocument: 10_000,
  maxSearchResultsProcess: 20_000,
  maxSearchExtractors: 1,
  maxTabs: 8,
  maxWindows: 4,
} as const);

export type ResourceTag =
  | "DOCUMENT_TOO_LARGE"
  | "SESSION_CAPACITY"
  | "RANGE_INVALID"
  | "RANGE_CAPACITY"
  | "RENDER_CAPACITY"
  | "CANVAS_LIMIT"
  | "IMAGE_LIMIT"
  | "TEXT_LIMIT"
  | "SEARCH_LIMIT"
  | "TAB_CAPACITY"
  | "WINDOW_CAPACITY"
  | "RESOURCE_ACCOUNTING";

export type ResourceKind =
  | "session"
  | "range-work"
  | "range-queue"
  | "render"
  | "canvas-bytes"
  | "canvas-cache-bytes"
  | "image-pixels"
  | "text-page-bytes"
  | "text-document-bytes"
  | "text-process-bytes"
  | "search-document-results"
  | "search-process-results"
  | "search-extractor"
  | "tab"
  | "window";

export interface ReservationRequest {
  readonly kind: ResourceKind;
  readonly amount: number;
  readonly sessionId?: string;
}

export interface ResourceReservation {
  readonly id: number;
  readonly kind: ResourceKind;
  readonly amount: number;
  readonly sessionId?: string;
}

export type ReservationResult =
  | { readonly ok: true; readonly reservation: ResourceReservation }
  | { readonly ok: false; readonly tag: ResourceTag };

export interface ResourceBudgetSnapshot {
  readonly totals: Readonly<Record<ResourceKind, number>>;
  readonly sessionTotals: Readonly<Record<string, Readonly<Partial<Record<ResourceKind, number>>>> >;
  readonly reservationCount: number;
}

export type InactiveHeavyResourceEvictor = (needed: ReservationRequest, amount: number) => void;

const EMPTY_TOTALS = (): Record<ResourceKind, number> => ({
  "session": 0, "range-work": 0, "range-queue": 0, render: 0,
  "canvas-bytes": 0, "canvas-cache-bytes": 0, "image-pixels": 0,
  "text-page-bytes": 0, "text-document-bytes": 0, "text-process-bytes": 0,
  "search-document-results": 0, "search-process-results": 0, "search-extractor": 0,
  tab: 0, window: 0,
});

function capacityFor(kind: ResourceKind, sessionScoped: boolean): number {
  const limits = RESOURCE_LIMITS;
  switch (kind) {
    case "session": return limits.maxSessions;
    case "range-work": return sessionScoped ? limits.maxRangeWorkSession : limits.maxRangeWorkProcess;
    case "range-queue": return sessionScoped ? limits.maxRangeQueueSession : limits.maxRangeQueueProcess;
    case "render": return limits.maxRendersProcess;
    case "canvas-bytes": return limits.maxCanvasBytes;
    case "canvas-cache-bytes": return limits.maxCanvasCacheBytes;
    case "image-pixels": return limits.maxImagePixels;
    case "text-page-bytes": return sessionScoped ? limits.maxTextPageBytes * limits.maxResidentPageViews : limits.maxTextProcessBytes;
    case "text-document-bytes": return sessionScoped ? limits.maxTextDocumentBytes : limits.maxTextProcessBytes;
    case "text-process-bytes": return limits.maxTextProcessBytes;
    case "search-document-results": return sessionScoped ? limits.maxSearchResultsDocument : limits.maxSearchResultsProcess;
    case "search-process-results": return limits.maxSearchResultsProcess;
    case "search-extractor": return limits.maxSearchExtractors;
    case "tab": return limits.maxTabs;
    case "window": return limits.maxWindows;
  }
}

function tagFor(kind: ResourceKind): ResourceTag {
  if (kind === "session") return "SESSION_CAPACITY";
  if (kind === "range-work" || kind === "range-queue") return "RANGE_CAPACITY";
  if (kind === "render") return "RENDER_CAPACITY";
  if (kind === "canvas-bytes" || kind === "canvas-cache-bytes") return "CANVAS_LIMIT";
  if (kind === "image-pixels") return "IMAGE_LIMIT";
  if (kind.startsWith("text-")) return "TEXT_LIMIT";
  if (kind.startsWith("search-")) return "SEARCH_LIMIT";
  if (kind === "tab") return "TAB_CAPACITY";
  return "WINDOW_CAPACITY";
}

export function validateDocumentBytes(byteLength: number): ResourceTag | undefined {
  return Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= RESOURCE_LIMITS.maxDocumentBytes
    ? undefined
    : "DOCUMENT_TOO_LARGE";
}

export function validateImagePixels(pixelCount: number): ResourceTag | undefined {
  return Number.isSafeInteger(pixelCount) && pixelCount >= 0 && pixelCount <= RESOURCE_LIMITS.maxImagePixels
    ? undefined
    : "IMAGE_LIMIT";
}
export function checkedCanvasBytes(width: number, height: number, dpr: number): number | ResourceTag {
  if (![width, height, dpr].every(Number.isFinite) || ![width, height, dpr].every(Number.isSafeInteger) || width < 0 || height < 0 || dpr < 1 || dpr > RESOURCE_LIMITS.maxDevicePixelRatio || width > RESOURCE_LIMITS.maxCanvasDimension || height > RESOURCE_LIMITS.maxCanvasDimension) return "CANVAS_LIMIT";
  const pixels = width * height * dpr * dpr;
  if (!Number.isSafeInteger(pixels) || pixels > RESOURCE_LIMITS.maxCanvasPixels) return "CANVAS_LIMIT";
  const bytes = pixels * 4;
  return Number.isSafeInteger(bytes) && bytes <= RESOURCE_LIMITS.maxCanvasBytes ? bytes : "CANVAS_LIMIT";
}

export function validateRange(offset: number, length: number, documentBytes: number): ResourceTag | undefined {
  if (
    ![offset, length, documentBytes].every(Number.isSafeInteger)
    || offset < 0
    || length < 0
    || documentBytes < 0
    || length > RESOURCE_LIMITS.maxRangeBytes
    || offset > documentBytes
    || length > documentBytes - offset
  ) return "RANGE_INVALID";
  return undefined;
}

/** Central reservation authority. All counters are checked before mutation and cannot underflow. */
export class ResourceReservationManager {
  private readonly totals = EMPTY_TOTALS();
  private readonly sessionTotals = new Map<string, Partial<Record<ResourceKind, number>>>();
  private readonly reservations = new Map<number, ResourceReservation>();
  private nextId = 1;

  public constructor(private readonly evictInactiveHeavyResources?: InactiveHeavyResourceEvictor) {}

  public reserve(request: ReservationRequest): ReservationResult {
    if (!Number.isSafeInteger(request.amount) || request.amount <= 0) return { ok: false, tag: "RESOURCE_ACCOUNTING" };
    const first = this.tryReserve(request);
    if (first.ok || this.evictInactiveHeavyResources === undefined || !this.isHeavy(request.kind)) return first;
    const needed = this.processShortfall(request);
    if (needed === 0) return first;
    this.evictInactiveHeavyResources(request, needed);
    return this.tryReserve(request);
  }

  public release(reservation: ResourceReservation): boolean {
    const held = this.reservations.get(reservation.id);
    if (held === undefined) return false;
    this.reservations.delete(reservation.id);
    this.totals[held.kind] -= held.amount;
    if (held.sessionId !== undefined) {
      const totals = this.sessionTotals.get(held.sessionId);
      if (totals === undefined) throw new Error("Resource accounting lost a session total");
      totals[held.kind] = (totals[held.kind] ?? 0) - held.amount;
      if (totals[held.kind] === 0 && Object.values(totals).every((value) => value === 0)) this.sessionTotals.delete(held.sessionId);
    }
    if (this.totals[held.kind] < 0) throw new Error("Resource accounting underflow");
    return true;
  }

  public snapshot(): ResourceBudgetSnapshot {
    const sessionTotals: Record<string, Readonly<Partial<Record<ResourceKind, number>>>> = {};
    for (const [session, totals] of this.sessionTotals) sessionTotals[session] = Object.freeze({ ...totals });
    return Object.freeze({ totals: Object.freeze({ ...this.totals }), sessionTotals: Object.freeze(sessionTotals), reservationCount: this.reservations.size });
  }

  public assertEmpty(): void {
    if (this.reservations.size !== 0 || Object.values(this.totals).some((value) => value !== 0)) throw new Error("Resource reservations are not empty");
  }

  private tryReserve(request: ReservationRequest): ReservationResult {
    const processCapacity = capacityFor(request.kind, false);
    const sessionCapacity = request.sessionId === undefined ? undefined : capacityFor(request.kind, true);
    const sessionTotal = request.sessionId === undefined ? 0 : (this.sessionTotals.get(request.sessionId)?.[request.kind] ?? 0);
    if (request.amount > processCapacity || this.totals[request.kind] > processCapacity - request.amount || (sessionCapacity !== undefined && (request.amount > sessionCapacity || sessionTotal > sessionCapacity - request.amount))) return { ok: false, tag: tagFor(request.kind) };
    const reservation: ResourceReservation = Object.freeze({ id: this.nextId++, kind: request.kind, amount: request.amount, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }) });
    this.totals[request.kind] += request.amount;
    if (request.sessionId !== undefined) {
      const totals = this.sessionTotals.get(request.sessionId) ?? {};
      totals[request.kind] = sessionTotal + request.amount;
      this.sessionTotals.set(request.sessionId, totals);
    }
    this.reservations.set(reservation.id, reservation);
    return { ok: true, reservation };
  }

  private processShortfall(request: ReservationRequest): number {
    return Math.max(0, this.totals[request.kind] + request.amount - capacityFor(request.kind, false));
  }

  private isHeavy(kind: ResourceKind): boolean {
    return kind === "canvas-bytes" || kind === "canvas-cache-bytes" || kind.startsWith("text-") || kind.startsWith("search-");
  }
}
