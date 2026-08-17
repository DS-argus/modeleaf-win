import { describe, expect, it } from "vitest";
import {
  capturePdfViewportAnchor,
  isPdfPagePointWithinTolerance,
  pdfPagePointError,
  restorePdfViewportAnchor,
  type PdfViewportTransform,
} from "../../../src/pdf/PdfViewportAnchor";

const pageWidth = 612;
const pageHeight = 792;

function viewport(rotation: 0 | 90 | 180 | 270, scale: number): PdfViewportTransform {
  const toViewport = (x: number, y: number): readonly [number, number] => {
    switch (rotation) {
      case 0: return [x * scale, (pageHeight - y) * scale];
      case 90: return [y * scale, x * scale];
      case 180: return [(pageWidth - x) * scale, y * scale];
      case 270: return [(pageHeight - y) * scale, (pageWidth - x) * scale];
    }
  };
  const toPdf = (x: number, y: number): readonly [number, number] => {
    switch (rotation) {
      case 0: return [x / scale, pageHeight - y / scale];
      case 90: return [y / scale, x / scale];
      case 180: return [pageWidth - x / scale, y / scale];
      case 270: return [pageWidth - y / scale, pageHeight - x / scale];
    }
  };
  return { convertToViewportPoint: toViewport, convertToPdfPoint: toPdf };
}

const sourceHost = { scrollLeft: 140, scrollTop: 210, clientWidth: 600, clientHeight: 400 };
const restoreHost = {
  scrollLeft: 0,
  scrollTop: 0,
  clientWidth: 600,
  clientHeight: 400,
  scrollWidth: 5000,
  scrollHeight: 5000,
};

describe("PdfViewportAnchor", () => {
  it.each([
    [0, 1, 1],
    [90, 1.25, 1.5],
    [180, 2, 2],
    [270, 0.75, 1.25],
  ] as const)("round-trips CSS geometry at rotation %i and scale %f", (rotation, sourceScale, targetScale) => {
    const anchor = capturePdfViewportAnchor({
      pageNumber: 7,
      viewport: viewport(rotation, sourceScale),
      pageFrameOffset: { x: 80, y: 120 },
      host: sourceHost,
    });
    const targetRotation = ((rotation + 90) % 360) as 0 | 90 | 180 | 270;
    const position = restorePdfViewportAnchor(anchor, {
      viewport: viewport(targetRotation, targetScale),
      pageFrameOffset: { x: 230, y: 310 },
      host: restoreHost,
    });
    const restored = capturePdfViewportAnchor({
      pageNumber: 7,
      viewport: viewport(targetRotation, targetScale),
      pageFrameOffset: { x: 230, y: 310 },
      host: { ...restoreHost, ...position },
    });

    expect(restored.viewportOffset).toEqual({ x: 300, y: 200 });
    expect(isPdfPagePointWithinTolerance(anchor.pagePoint, restored.pagePoint)).toBe(true);
    expect(pdfPagePointError(anchor.pagePoint, restored.pagePoint)).toBeLessThanOrEqual(0.5);
  });

  it("uses CSS geometry only, so changing backing-store DPR cannot move an anchor", () => {
    const cssViewport = viewport(90, 1.5);
    const anchors = [1, 1.25, 2, 3].map((_devicePixelRatio) => capturePdfViewportAnchor({
      pageNumber: 3,
      viewport: cssViewport,
      pageFrameOffset: { x: 25, y: 50 },
      host: sourceHost,
    }));

    expect(anchors.every((anchor) => anchor.pagePoint.x === anchors[0]!.pagePoint.x
      && anchor.pagePoint.y === anchors[0]!.pagePoint.y)).toBe(true);
  });

  it("preserves an explicit non-center viewport offset", () => {
    const offset = { x: 43, y: 157 };
    const anchor = capturePdfViewportAnchor({
      pageNumber: 2,
      viewport: viewport(0, 1),
      pageFrameOffset: { x: 100, y: 200 },
      host: sourceHost,
      viewportOffset: offset,
    });
    const position = restorePdfViewportAnchor(anchor, {
      viewport: viewport(180, 1.5),
      pageFrameOffset: { x: 300, y: 400 },
      host: restoreHost,
    });
    const restored = capturePdfViewportAnchor({
      pageNumber: 2,
      viewport: viewport(180, 1.5),
      pageFrameOffset: { x: 300, y: 400 },
      host: { ...restoreHost, ...position },
      viewportOffset: offset,
    });

    expect(restored.viewportOffset).toEqual(offset);
    expect(isPdfPagePointWithinTolerance(anchor.pagePoint, restored.pagePoint)).toBe(true);
    expect(Object.isFrozen(anchor)).toBe(true);
    expect(Object.isFrozen(anchor.pagePoint)).toBe(true);
  });

  it("clamps restored scroll coordinates to the finite host range", () => {
    const viewportIdentity: PdfViewportTransform = {
      convertToPdfPoint: (x, y) => [x, y],
      convertToViewportPoint: (x, y) => [x, y],
    };
    const nearOrigin = capturePdfViewportAnchor({
      pageNumber: 1,
      viewport: viewportIdentity,
      pageFrameOffset: { x: 100, y: 100 },
      host: { scrollLeft: 0, scrollTop: 0, clientWidth: 200, clientHeight: 100 },
      viewportOffset: { x: 0, y: 0 },
    });
    const farPoint = capturePdfViewportAnchor({
      pageNumber: 1,
      viewport: viewportIdentity,
      pageFrameOffset: { x: 0, y: 0 },
      host: { scrollLeft: 2_000, scrollTop: 2_000, clientWidth: 0, clientHeight: 0 },
      viewportOffset: { x: 0, y: 0 },
    });
    const host = { ...restoreHost, scrollWidth: 900, scrollHeight: 700 };

    expect(restorePdfViewportAnchor(nearOrigin, {
      viewport: viewportIdentity, pageFrameOffset: { x: 0, y: 0 }, host,
    })).toEqual({ scrollLeft: 0, scrollTop: 0 });
    expect(restorePdfViewportAnchor(farPoint, {
      viewport: viewportIdentity, pageFrameOffset: { x: 0, y: 0 }, host,
    })).toEqual({ scrollLeft: 300, scrollTop: 300 });
  });

  it("uses the inclusive 0.5 page-point tolerance boundary", () => {
    const expected = { x: 10, y: 20 };
    expect(pdfPagePointError(expected, { x: 10.3, y: 20.4 })).toBeCloseTo(0.5);
    expect(isPdfPagePointWithinTolerance(expected, { x: 10.3, y: 20.4 })).toBe(true);
    expect(isPdfPagePointWithinTolerance(expected, { x: 10.3001, y: 20.4 })).toBe(false);
  });

  it("rejects invalid identities, geometry, conversions, and tolerance", () => {
    const identity: PdfViewportTransform = {
      convertToPdfPoint: (x, y) => [x, y],
      convertToViewportPoint: (x, y) => [x, y],
    };
    const valid = {
      pageNumber: 1,
      viewport: identity,
      pageFrameOffset: { x: 0, y: 0 },
      host: sourceHost,
    };

    expect(() => capturePdfViewportAnchor({ ...valid, pageNumber: 0 })).toThrow(/pageNumber/i);
    expect(() => capturePdfViewportAnchor({ ...valid, pageFrameOffset: { x: Number.NaN, y: 0 } })).toThrow(/pageFrameOffset/i);
    expect(() => capturePdfViewportAnchor({
      ...valid,
      viewport: { ...identity, convertToPdfPoint: () => [1, Number.POSITIVE_INFINITY] },
    })).toThrow(/convertToPdfPoint/i);
    const anchor = capturePdfViewportAnchor(valid);
    expect(() => restorePdfViewportAnchor(anchor, {
      viewport: { ...identity, convertToViewportPoint: () => [1, 2, 3] as unknown as readonly [number, number] },
      pageFrameOffset: { x: 0, y: 0 },
      host: restoreHost,
    })).toThrow(/convertToViewportPoint/i);
    expect(() => restorePdfViewportAnchor(anchor, {
      viewport: identity,
      pageFrameOffset: { x: 0, y: 0 },
      host: { ...restoreHost, scrollWidth: Number.NaN },
    })).toThrow(/scroll dimensions/i);
    expect(() => isPdfPagePointWithinTolerance({ x: 0, y: 0 }, { x: 0, y: 0 }, -1)).toThrow(/tolerance/i);
  });
});
