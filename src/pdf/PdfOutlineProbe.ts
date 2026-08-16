import { isValidPdfDestination } from "./PdfDestination";

export interface PdfOutlineItem {
  readonly title?: unknown;
  readonly dest?: unknown;
  readonly items?: readonly PdfOutlineItem[];
}

export interface PdfOutlinePage {
  getViewport(options: { readonly scale: number; readonly rotation: number }): {
    readonly height: number;
    readonly viewBox?: readonly number[];
    readonly userUnit?: number;
  };
}

export interface PdfOutlineDocument {
  readonly numPages: number;
  getOutline(): Promise<readonly PdfOutlineItem[] | null>;
  getDestination?(name: string): Promise<unknown>;
  getPageIndex(reference: unknown): Promise<number>;
  getPage(pageNumber: number): Promise<PdfOutlinePage>;
}

export type PdfOutlineDestinationStatus =
  | "wrapper"
  | "resolved"
  | "duplicate"
  | "edge-clamped"
  | "invalid";

export interface PdfOutlineProbeRow {
  readonly index: number;
  readonly depth: number;
  readonly title: string;
  readonly destinationStatus: PdfOutlineDestinationStatus;
  readonly pageNumber?: number;
  readonly y?: number;
  readonly clampedY?: number;
}

const MAX_OUTLINE_ROWS = 10_000;
const MAX_OUTLINE_DEPTH = 32;

const modeName = (destination: readonly unknown[]): string | undefined => {
  const mode = destination[1];
  return typeof mode === "object" && mode !== null
    && "name" in mode
    && typeof (mode as { readonly name?: unknown }).name === "string"
    ? (mode as { readonly name: string }).name
    : undefined;
};

async function resolveDestination(
  document: PdfOutlineDocument,
  raw: unknown,
): Promise<readonly unknown[] | undefined> {
  try {
    const destination = typeof raw === "string"
      ? await document.getDestination?.(raw)
      : raw;
    return Array.isArray(destination) && isValidPdfDestination(destination)
      ? destination
      : undefined;
  } catch {
    return undefined;
  }
}

async function pageIndexFor(
  document: PdfOutlineDocument,
  reference: unknown,
): Promise<number | undefined> {
  try {
    const pageIndex = Number.isInteger(reference) && (reference as number) >= 0
      ? reference as number
      : await document.getPageIndex(reference);
    return Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < document.numPages
      ? pageIndex
      : undefined;
  } catch {
    return undefined;
  }
}

const rawYFor = (destination: readonly unknown[]): number | undefined => {
  const mode = modeName(destination);
  const value = mode === "XYZ"
    ? destination[3]
    : mode === "FitH" || mode === "FitBH"
      ? destination[2]
      : mode === "FitR"
        ? destination[5]
        : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

function canonicalDestination(
  pageNumber: number,
  destination: readonly unknown[],
): string | undefined {
  const mode = modeName(destination);
  if (mode === undefined) return undefined;
  const operands = destination.slice(2);
  if (!operands.every((value) => value === null || (typeof value === "number" && Number.isFinite(value)))) {
    return undefined;
  }
  try {
    return JSON.stringify([pageNumber, mode, ...operands]);
  } catch {
    return undefined;
  }
}

async function resolveDestinationRow(
  document: PdfOutlineDocument,
  destination: readonly unknown[],
): Promise<{
  readonly key: string;
  readonly coordinates: Pick<PdfOutlineProbeRow, "pageNumber" | "y" | "clampedY">;
} | undefined> {
  const pageIndex = await pageIndexFor(document, destination[0]);
  if (pageIndex === undefined) return undefined;
  const pageNumber = pageIndex + 1;
  const key = canonicalDestination(pageNumber, destination);
  if (key === undefined) return undefined;
  const rawY = rawYFor(destination);
  if (rawY === undefined) return { key, coordinates: { pageNumber } };

  try {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1, rotation: 0 });
    const viewBox = viewport.viewBox;
    const userUnit = viewport.userUnit ?? 1;
    const minimumY = viewBox !== undefined && viewBox.length === 4 && Number.isFinite(viewBox[1])
      ? viewBox[1]!
      : 0;
    const maximumY = viewBox !== undefined && viewBox.length === 4 && Number.isFinite(viewBox[3])
      ? viewBox[3]!
      : minimumY + viewport.height / userUnit;
    if (!Number.isFinite(minimumY) || !Number.isFinite(maximumY) || maximumY <= minimumY) return undefined;
    return {
      key,
      coordinates: {
        pageNumber,
        y: rawY,
        clampedY: Math.min(maximumY, Math.max(minimumY, rawY)),
      },
    };
  } catch {
    return undefined;
  }
}

export async function probePdfOutline(document: PdfOutlineDocument): Promise<readonly PdfOutlineProbeRow[]> {
  const outline = await document.getOutline();
  if (outline === null || outline.length === 0) return [];

  const rows: PdfOutlineProbeRow[] = [];
  const seenItems = new Set<PdfOutlineItem>();
  const seenDestinations = new Set<string>();

  const visit = async (items: readonly PdfOutlineItem[], depth: number): Promise<void> => {
    if (depth > MAX_OUTLINE_DEPTH) throw new Error("OUTLINE_DEPTH_LIMIT");
    for (const item of items) {
      if (rows.length >= MAX_OUTLINE_ROWS) throw new Error("OUTLINE_ROW_LIMIT");
      if (seenItems.has(item)) throw new Error("OUTLINE_CYCLE");
      seenItems.add(item);

      const children = Array.isArray(item.items) ? item.items : [];
      const title = typeof item.title === "string" && item.title.trim().length > 0
        ? item.title
        : "Untitled outline item";
      const destination = await resolveDestination(document, item.dest);
      let destinationStatus: PdfOutlineDestinationStatus;
      let coordinates: Pick<PdfOutlineProbeRow, "pageNumber" | "y" | "clampedY"> | undefined;

      if (destination === undefined) {
        destinationStatus = children.length > 0 ? "wrapper" : "invalid";
      } else {
        const resolved = await resolveDestinationRow(document, destination);
        coordinates = resolved?.coordinates;
        if (resolved === undefined) destinationStatus = "invalid";
        else if (seenDestinations.has(resolved.key)) destinationStatus = "duplicate";
        else if (coordinates?.y !== undefined && coordinates.clampedY !== coordinates.y) {
          destinationStatus = "edge-clamped";
        } else destinationStatus = "resolved";
        if (resolved !== undefined) seenDestinations.add(resolved.key);
      }

      rows.push({
        index: rows.length,
        depth,
        title,
        destinationStatus,
        ...coordinates,
      });
      if (children.length > 0) await visit(children, depth + 1);
    }
  };

  await visit(outline, 0);
  return rows;
}
