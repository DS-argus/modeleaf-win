import { OUTLINE_EDGE_TOLERANCE_POINTS, type RawOutlineDestination, type RawOutlineNode } from "../domain/outlines/OutlineModel";
import { isValidPdfDestination } from "./PdfDestination";

/**
 * Bridges PDF.js outline items onto the pure `OutlineModel` contract.
 *
 * The adapter owns destination resolution because `feature-spec.md` §8 defines
 * it in PDF page space, not in view space: a destination is `pageIndex` plus an
 * unscaled, unrotated page-space point. Resolving it here keeps the pure domain
 * free of PDF.js types while giving the finite/sentinel/8pt policy a single
 * tested home.
 */

export interface PdfOutlineAdapterPage {
  getViewport(options: { readonly scale: number; readonly rotation: number }): {
    readonly width: number;
    readonly height: number;
    readonly viewBox?: readonly number[];
    readonly userUnit?: number;
  };
}

export interface PdfOutlineAdapterItem {
  readonly title?: unknown;
  readonly dest?: unknown;
  readonly items?: readonly PdfOutlineAdapterItem[];
}

export interface PdfOutlineAdapterDocument {
  readonly numPages: number;
  getOutline(): Promise<readonly PdfOutlineAdapterItem[] | null>;
  getDestination?(name: string): Promise<unknown>;
  getPageIndex(reference: unknown): Promise<number>;
  getPage(pageNumber: number): Promise<PdfOutlineAdapterPage>;
}

/** Mirrors `PdfOutlineProbe` so a malformed outline fails closed instead of hanging. */
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;

interface PageBox {
  readonly minimumX: number;
  readonly maximumX: number;
  readonly minimumY: number;
  readonly maximumY: number;
}

const modeName = (destination: readonly unknown[]): string | undefined => {
  const mode = destination[1];
  return typeof mode === "object" && mode !== null && "name" in mode
    && typeof (mode as { readonly name?: unknown }).name === "string"
    ? (mode as { readonly name: string }).name
    : undefined;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Extracts the raw page-space point a destination names, or `undefined` for
 * each axis the destination leaves unspecified.
 *
 * A PDF destination may omit either coordinate with a `null` sentinel, most
 * commonly `[page, /XYZ, null, null, null]`. `Fit` and `FitB` name no point at
 * all. Both cases are *unspecified*, not invalid, and the caller resolves them
 * to the media-box center.
 */
function rawPoint(destination: readonly unknown[]): { readonly x?: number; readonly y?: number } {
  switch (modeName(destination)) {
    case "XYZ":
      return {
        ...(finite(destination[2]) ? { x: destination[2] } : {}),
        ...(finite(destination[3]) ? { y: destination[3] } : {}),
      };
    case "FitH":
    case "FitBH":
      return finite(destination[2]) ? { y: destination[2] } : {};
    case "FitV":
    case "FitBV":
      return finite(destination[2]) ? { x: destination[2] } : {};
    case "FitR":
      // The rectangle's top-left corner is the landing point.
      return {
        ...(finite(destination[2]) ? { x: destination[2] } : {}),
        ...(finite(destination[5]) ? { y: destination[5] } : {}),
      };
    case "Fit":
    case "FitB":
      return {};
    default:
      return {};
  }
}

function pageBox(page: PdfOutlineAdapterPage): PageBox | undefined {
  let viewport;
  try {
    viewport = page.getViewport({ scale: 1, rotation: 0 });
  } catch {
    return undefined;
  }
  const box = viewport.viewBox;
  const userUnit = finite(viewport.userUnit) && viewport.userUnit > 0 ? viewport.userUnit : 1;
  const usable = box !== undefined && box.length === 4 && box.every(finite);
  const minimumX = usable ? box[0]! : 0;
  const minimumY = usable ? box[1]! : 0;
  const maximumX = usable ? box[2]! : minimumX + viewport.width / userUnit;
  const maximumY = usable ? box[3]! : minimumY + viewport.height / userUnit;
  if (![minimumX, minimumY, maximumX, maximumY].every(Number.isFinite)) return undefined;
  if (maximumX <= minimumX || maximumY <= minimumY) return undefined;
  return { minimumX, maximumX, minimumY, maximumY };
}

/**
 * Applies the documented axis policy.
 *
 * Unspecified resolves to the box center. A value inside the box, or outside it
 * by at most {@link OUTLINE_EDGE_TOLERANCE_POINTS}, clamps onto the box. Any
 * value beyond that tolerance is invalid, so the row stays visible but
 * disabled rather than silently landing somewhere wrong.
 */
function resolveAxis(value: number | undefined, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return (minimum + maximum) / 2;
  if (!Number.isFinite(value)) return undefined;
  if (value < minimum - OUTLINE_EDGE_TOLERANCE_POINTS) return undefined;
  if (value > maximum + OUTLINE_EDGE_TOLERANCE_POINTS) return undefined;
  return Math.min(maximum, Math.max(minimum, value));
}

async function pageIndexFor(document: PdfOutlineAdapterDocument, reference: unknown): Promise<number | undefined> {
  try {
    const pageIndex = Number.isInteger(reference) && (reference as number) >= 0
      ? reference as number
      : await document.getPageIndex(reference);
    return Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < document.numPages ? pageIndex : undefined;
  } catch {
    return undefined;
  }
}

async function resolveDestinationArray(
  document: PdfOutlineAdapterDocument,
  raw: unknown,
): Promise<readonly unknown[] | undefined> {
  try {
    const destination = typeof raw === "string" ? await document.getDestination?.(raw) : raw;
    return Array.isArray(destination) && isValidPdfDestination(destination) ? destination : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves one outline destination to the pure domain's page-space shape. */
export async function resolveOutlineDestination(
  document: PdfOutlineAdapterDocument,
  raw: unknown,
): Promise<RawOutlineDestination | undefined> {
  const destination = await resolveDestinationArray(document, raw);
  if (destination === undefined) return undefined;
  const pageIndex = await pageIndexFor(document, destination[0]);
  if (pageIndex === undefined) return undefined;

  let page: PdfOutlineAdapterPage;
  try {
    page = await document.getPage(pageIndex + 1);
  } catch {
    return undefined;
  }
  const box = pageBox(page);
  if (box === undefined) return undefined;

  const point = rawPoint(destination);
  const x = resolveAxis(point.x, box.minimumX, box.maximumX);
  const y = resolveAxis(point.y, box.minimumY, box.maximumY);
  if (x === undefined || y === undefined) return undefined;

  // The pure model re-checks bounds, so hand it an already box-relative point.
  return Object.freeze({
    pageIndex,
    x: x - box.minimumX,
    y: y - box.minimumY,
    pageWidth: box.maximumX - box.minimumX,
    pageHeight: box.maximumY - box.minimumY,
  });
}

/**
 * Reads the document outline and returns it in pure-domain shape.
 *
 * Returns an empty array when the PDF has no embedded outline. An outline is
 * never generated or inferred; that is explicit non-scope.
 */
export async function readOutlineTree(
  document: PdfOutlineAdapterDocument,
): Promise<readonly RawOutlineNode[]> {
  let outline: readonly PdfOutlineAdapterItem[] | null;
  try {
    outline = await document.getOutline();
  } catch {
    throw new Error("PDF_OUTLINE_UNAVAILABLE");
  }
  if (outline === null || outline.length === 0) return [];

  const seen = new Set<PdfOutlineAdapterItem>();
  let nodeCount = 0;

  const visit = async (item: PdfOutlineAdapterItem, depth: number): Promise<RawOutlineNode> => {
    if (depth > MAX_DEPTH) throw new Error("OUTLINE_DEPTH_LIMIT");
    if (seen.has(item)) throw new Error("OUTLINE_CYCLE");
    seen.add(item);
    nodeCount += 1;
    if (nodeCount > MAX_NODES) throw new Error("OUTLINE_NODE_LIMIT");

    const destination = item.dest === undefined || item.dest === null
      ? undefined
      : await resolveOutlineDestination(document, item.dest);
    const children: RawOutlineNode[] = [];
    for (const child of item.items ?? []) children.push(await visit(child, depth + 1));

    const node: RawOutlineNode = {
      ...(typeof item.title === "string" ? { title: item.title } : {}),
      ...(destination === undefined ? {} : { destination }),
      ...(children.length === 0 ? {} : { children: Object.freeze(children) }),
    };
    // A shared child object is a cycle only along one path, not across siblings.
    seen.delete(item);
    return Object.freeze(node);
  };

  const roots: RawOutlineNode[] = [];
  for (const item of outline) roots.push(await visit(item, 0));
  return Object.freeze(roots);
}
