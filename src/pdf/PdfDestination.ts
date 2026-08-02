import type { ZoomMode } from "../core/ReaderState";

export interface PdfDestinationSize {
  readonly width: number;
  readonly height: number;
}

export interface PdfDestinationView {
  readonly zoomMode: ZoomMode;
  readonly scale: number;
}

const modeName = (destination: readonly unknown[]): string | undefined => {
  const mode = destination[1];
  return typeof mode === "object" && mode !== null
    && "name" in mode
    && typeof (mode as { readonly name?: unknown }).name === "string"
    ? (mode as { readonly name: string }).name
    : undefined;
};

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const nullableFinite = (value: unknown): boolean => value === null || finite(value);

export function isValidPdfDestination(destination: readonly unknown[]): boolean {
  const name = modeName(destination);
  if (name === undefined) return false;
  switch (name) {
    case "XYZ":
      return destination.length === 5
        && nullableFinite(destination[2])
        && nullableFinite(destination[3])
        && (destination[4] === null || (finite(destination[4]) && destination[4] >= 0));
    case "Fit":
    case "FitB":
      return destination.length === 2;
    case "FitH":
    case "FitBH":
    case "FitV":
    case "FitBV":
      return destination.length === 3 && nullableFinite(destination[2]);
    case "FitR":
      return destination.length === 6
        && finite(destination[2])
        && finite(destination[3])
        && finite(destination[4])
        && finite(destination[5])
        && destination[2] !== destination[4]
        && destination[3] !== destination[5];
    default:
      return false;
  }
}

export function pdfDestinationNeedsPageSize(destination: readonly unknown[]): boolean {
  const name = modeName(destination);
  return name === "Fit"
    || name === "FitB"
    || name === "FitH"
    || name === "FitBH"
    || name === "FitV"
    || name === "FitBV";
}

export function resolvePdfDestinationView(
  destination: readonly unknown[],
  retainedScale: number,
  targetSize: PdfDestinationSize | undefined,
  available: PdfDestinationSize,
  rotationQuarterTurns: number,
  clampScale: (scale: number) => number,
): PdfDestinationView | undefined {
  if (!isValidPdfDestination(destination)) return undefined;
  const name = modeName(destination);
  if (name === undefined) return undefined;
  if (pdfDestinationNeedsPageSize(destination) && targetSize === undefined) return undefined;

  let scale = retainedScale;
  let zoomMode: ZoomMode = "custom";
  if (name === "XYZ" && finite(destination[4]) && destination[4] > 0) {
    scale = destination[4];
  } else if ((name === "Fit" || name === "FitB") && targetSize !== undefined) {
    zoomMode = "fit-page";
    scale = Math.min(available.width / targetSize.width, available.height / targetSize.height);
  } else if ((name === "FitH" || name === "FitBH") && targetSize !== undefined) {
    zoomMode = "fit-width";
    scale = available.width / targetSize.width;
  } else if ((name === "FitV" || name === "FitBV") && targetSize !== undefined) {
    scale = available.height / targetSize.height;
  } else if (
    name === "FitR"
    && finite(destination[2])
    && finite(destination[3])
    && finite(destination[4])
    && finite(destination[5])
  ) {
    let width = Math.abs(destination[4] - destination[2]);
    let height = Math.abs(destination[5] - destination[3]);
    if (Math.abs(rotationQuarterTurns) % 2 === 1) [width, height] = [height, width];
    if (width > 0 && height > 0) {
      scale = Math.min(available.width / width, available.height / height);
    }
  }
  return { zoomMode, scale: clampScale(scale) };
}
