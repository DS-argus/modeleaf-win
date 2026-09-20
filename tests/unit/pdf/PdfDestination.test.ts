import { describe, expect, it } from "vitest";
import { isValidPdfDestination, pdfDestinationNeedsPageSize, resolvePdfDestinationView } from "../../../src/pdf/PdfDestination";

import { clampReaderScale as clamp } from "../../../src/domain/navigation/ZoomPolicy";
const mode = (name: string, ...operands: unknown[]) => [0, { name }, ...operands] as const;

describe("PDF destination view resolution", () => {
  it("uses target-page dimensions for all page-fit destinations", () => {
    const target = { width: 400, height: 800 };
    const available = { width: 600, height: 600 };

    expect(resolvePdfDestinationView(mode("Fit"), 1.25, target, available, 0, clamp))
      .toEqual({ zoomMode: "fit-page", scale: 0.75 });
    expect(resolvePdfDestinationView(mode("FitH", 20), 1.25, target, available, 0, clamp))
      .toEqual({ zoomMode: "fit-width", scale: 1.5 });
    expect(resolvePdfDestinationView(mode("FitV", 20), 1.25, target, available, 0, clamp))
      .toEqual({ zoomMode: "custom", scale: 0.75 });
    expect(pdfDestinationNeedsPageSize(mode("FitBV", 20))).toBe(true);
    expect(resolvePdfDestinationView(mode("Fit"), 1.25, undefined, available, 0, clamp)).toBeUndefined();
  });

  it("preserves null XYZ zoom and applies positive zoom exactly", () => {
    const available = { width: 600, height: 400 };
    expect(resolvePdfDestinationView(mode("XYZ", null, null, null), 1.75, undefined, available, 0, clamp))
      .toEqual({ zoomMode: "custom", scale: 1.75 });
    expect(resolvePdfDestinationView(mode("XYZ", null, null, 2.5), 1, undefined, available, 0, clamp))
      .toEqual({ zoomMode: "custom", scale: 2.5 });
  });

  it("projects non-square FitR rectangles through quarter-turn rotations", () => {
    const available = { width: 600, height: 400 };
    const destination = mode("FitR", 0, 0, 300, 100);

    expect(resolvePdfDestinationView(destination, 1, undefined, available, 0, clamp))
      .toEqual({ zoomMode: "custom", scale: 2 });
    expect(resolvePdfDestinationView(destination, 1, undefined, available, 1, clamp))
      .toEqual({ zoomMode: "custom", scale: 4 / 3 });
    expect(resolvePdfDestinationView(destination, 1, undefined, available, 3, clamp))
      .toEqual({ zoomMode: "custom", scale: 4 / 3 });
  });

  it("rejects unknown and malformed destination modes", () => {
    const available = { width: 600, height: 400 };
    expect(isValidPdfDestination(mode("Bogus"))).toBe(false);
    expect(isValidPdfDestination(mode("FitR", 0, 0, 100))).toBe(false);
    expect(isValidPdfDestination(mode("XYZ", undefined, null, 1))).toBe(false);
    expect(resolvePdfDestinationView(mode("Bogus"), 1.25, undefined, available, 0, clamp)).toBeUndefined();
    expect(resolvePdfDestinationView(mode("FitR", 0, 0, 100), 1.25, undefined, available, 0, clamp)).toBeUndefined();
  });
  it("requires a non-null Name-shaped mode operand", () => {
    expect(isValidPdfDestination([0, "Fit"])).toBe(false);
    expect(isValidPdfDestination([0, null])).toBe(false);
    expect(isValidPdfDestination([0, {}])).toBe(false);
    expect(isValidPdfDestination([0, { name: 1 }])).toBe(false);
    expect(isValidPdfDestination([0, { name: "Fit" }])).toBe(true);
  });
  it("bounds extreme destination zooms using the reader policy", () => {
    const available = { width: 600, height: 400 };
    expect(resolvePdfDestinationView(mode("XYZ", 0, 0, 100), 1, undefined, available, 0, clamp))
      .toEqual({ zoomMode: "custom", scale: 4 });
    expect(resolvePdfDestinationView(mode("XYZ", 0, 0, 0.01), 1, undefined, available, 0, clamp))
      .toEqual({ zoomMode: "custom", scale: 0.25 });
  });
});
