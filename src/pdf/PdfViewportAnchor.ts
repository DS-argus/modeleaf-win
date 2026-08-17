export interface PdfPagePoint {
  readonly x: number;
  readonly y: number;
}

export interface PdfViewportLanding {
  readonly pageIndex: number;
  readonly x: number;
  readonly y: number;
}
/** The small PDF.js viewport surface needed to convert canonical page points. */
export interface PdfViewportTransform {
  convertToPdfPoint(x: number, y: number): readonly [number, number];
  convertToViewportPoint(x: number, y: number): readonly [number, number];
}

/** CSS-pixel position of a page viewport's origin in the scrolling document. */
export interface PdfPageFrameOffset {
  readonly x: number;
  readonly y: number;
}

/** CSS geometry read from the scrolling host when an anchor is captured. */
export interface PdfViewportHostCaptureGeometry {
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
}

/** CSS geometry needed to restore an anchor, including the scrollable extent. */
export interface PdfViewportHostRestoreGeometry extends PdfViewportHostCaptureGeometry {
  readonly scrollWidth: number;
  readonly scrollHeight: number;
}

/**
 * A location expressed independently of DOM layout, zoom, rotation, and DPR.
 * viewportOffset is CSS geometry only: it determines where the point lands in
 * the host after a later layout, but is not a persisted document coordinate.
 */
export interface PdfViewportAnchor {
  readonly pageNumber: number;
  readonly pagePoint: PdfPagePoint;
  readonly viewportOffset: PdfPagePoint;
}

export interface PdfViewportAnchorCapture {
  readonly pageNumber: number;
  readonly viewport: PdfViewportTransform;
  readonly pageFrameOffset: PdfPageFrameOffset;
  readonly host: PdfViewportHostCaptureGeometry;
  /** CSS offset from the host's client origin; defaults to the client center. */
  readonly viewportOffset?: PdfPagePoint;
}

export interface PdfViewportAnchorRestore {
  readonly viewport: PdfViewportTransform;
  readonly pageFrameOffset: PdfPageFrameOffset;
  readonly host: PdfViewportHostRestoreGeometry;
}

export interface PdfViewportScrollPosition {
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function assertFinitePoint(point: PdfPagePoint, label: string): void {
  if (!finite(point.x) || !finite(point.y)) throw new Error(`${label} must contain finite coordinates`);
}

function assertPageNumber(pageNumber: number): void {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Error("pageNumber must be a positive integer");
  }
}

function assertCaptureHost(host: PdfViewportHostCaptureGeometry): void {
  if (!finite(host.scrollLeft) || !finite(host.scrollTop)) {
    throw new Error("host scroll coordinates must be finite");
  }
  if (!finite(host.clientWidth) || host.clientWidth < 0 || !finite(host.clientHeight) || host.clientHeight < 0) {
    throw new Error("host client dimensions must be non-negative finite numbers");
  }
}

function assertRestoreHost(host: PdfViewportHostRestoreGeometry): void {
  assertCaptureHost(host);
  if (!finite(host.scrollWidth) || host.scrollWidth < host.clientWidth
    || !finite(host.scrollHeight) || host.scrollHeight < host.clientHeight) {
    throw new Error("host scroll dimensions must be finite and at least the client dimensions");
  }
}

function assertViewport(viewport: PdfViewportTransform): void {
  if (typeof viewport.convertToPdfPoint !== "function" || typeof viewport.convertToViewportPoint !== "function") {
    throw new Error("viewport must provide point conversion functions");
  }
}

function conversionPoint(value: unknown, label: string): PdfPagePoint {
  if (!Array.isArray(value) || value.length !== 2 || !finite(value[0]) || !finite(value[1])) {
    throw new Error(`${label} must return a two-coordinate finite point`);
  }
  return { x: value[0], y: value[1] };
}

function frozenPoint(x: number, y: number): PdfPagePoint {
  return Object.freeze({ x, y });
}

function assertAnchor(anchor: PdfViewportAnchor): void {
  assertPageNumber(anchor.pageNumber);
  assertFinitePoint(anchor.pagePoint, "anchor.pagePoint");
  assertFinitePoint(anchor.viewportOffset, "anchor.viewportOffset");
}

/** Captures the PDF point under a CSS viewport offset, using the client center by default. */
export function capturePdfViewportAnchor(input: PdfViewportAnchorCapture): PdfViewportAnchor {
  assertPageNumber(input.pageNumber);
  assertViewport(input.viewport);
  assertFinitePoint(input.pageFrameOffset, "pageFrameOffset");
  assertCaptureHost(input.host);
  const viewportOffset = input.viewportOffset ?? {
    x: input.host.clientWidth / 2,
    y: input.host.clientHeight / 2,
  };
  assertFinitePoint(viewportOffset, "viewportOffset");

  const pageViewportX = input.host.scrollLeft + viewportOffset.x - input.pageFrameOffset.x;
  const pageViewportY = input.host.scrollTop + viewportOffset.y - input.pageFrameOffset.y;
  const pagePoint = conversionPoint(
    input.viewport.convertToPdfPoint(pageViewportX, pageViewportY),
    "convertToPdfPoint",
  );

  return Object.freeze({
    pageNumber: input.pageNumber,
    pagePoint: frozenPoint(pagePoint.x, pagePoint.y),
    viewportOffset: frozenPoint(viewportOffset.x, viewportOffset.y),
  });
}

/** Restores an anchor into the current CSS layout, clamped to the host's scroll range. */
export function restorePdfViewportAnchor(
  anchor: PdfViewportAnchor,
  input: PdfViewportAnchorRestore,
): PdfViewportScrollPosition {
  assertAnchor(anchor);
  assertViewport(input.viewport);
  assertFinitePoint(input.pageFrameOffset, "pageFrameOffset");
  assertRestoreHost(input.host);

  const point = conversionPoint(
    input.viewport.convertToViewportPoint(anchor.pagePoint.x, anchor.pagePoint.y),
    "convertToViewportPoint",
  );
  const maxScrollLeft = input.host.scrollWidth - input.host.clientWidth;
  const maxScrollTop = input.host.scrollHeight - input.host.clientHeight;
  return Object.freeze({
    scrollLeft: Math.min(maxScrollLeft, Math.max(0, input.pageFrameOffset.x + point.x - anchor.viewportOffset.x)),
    scrollTop: Math.min(maxScrollTop, Math.max(0, input.pageFrameOffset.y + point.y - anchor.viewportOffset.y)),
  });
}

/** Euclidean error in unscaled, pre-rotation PDF page space. */
export function pdfPagePointError(expected: PdfPagePoint, actual: PdfPagePoint): number {
  assertFinitePoint(expected, "expected page point");
  assertFinitePoint(actual, "actual page point");
  return Math.hypot(actual.x - expected.x, actual.y - expected.y);
}

/** Tests the page-space <= 0.5-point location contract (or a supplied tolerance). */
export function isPdfPagePointWithinTolerance(
  expected: PdfPagePoint,
  actual: PdfPagePoint,
  tolerance = 0.5,
): boolean {
  if (!finite(tolerance) || tolerance < 0) throw new Error("tolerance must be a non-negative finite number");
  return pdfPagePointError(expected, actual) <= tolerance;
}

export function isValidPdfViewportLanding(landing: PdfViewportLanding): boolean {
  return Number.isSafeInteger(landing.pageIndex) && landing.pageIndex >= 0
    && Number.isFinite(landing.x) && Number.isFinite(landing.y);
}

/** W07 landing verification uses independent axes, never Euclidean distance. */
export function samePdfViewportLanding(left: PdfViewportLanding, right: PdfViewportLanding): boolean {
  return left.pageIndex === right.pageIndex
    && Math.abs(left.x - right.x) <= 0.5 + 1e-9
    && Math.abs(left.y - right.y) <= 0.5 + 1e-9;
}
