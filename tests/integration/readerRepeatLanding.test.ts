/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfReaderController, type PdfPage } from "../../src/pdf/PdfReaderController";
import { ResourceReservationManager } from "../../src/pdf/ResourceBudget";

// CSSOM integer extents plus physical-pixel scroll setters, measured in WebView2
// on the mixed-rotation fixture at 130% desktop scaling. This models, not certifies, native layout.
async function fixture(displacement = 0, rawScroll = false) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  vi.stubGlobal("devicePixelRatio", 1.3);
  expect(window.devicePixelRatio).toBe(1.3);
  const host = document.createElement("div");
  let top = 0;
  let left = 0;
  let quantize = false;
  const dpr = 1.3;
  Object.defineProperties(host, {
    clientWidth: { value: 632 }, clientHeight: { value: 1021 },
    scrollWidth: { value: 1000 }, scrollHeight: { value: 2400 },
    scrollLeft: { get: () => left, set: (value: number) => { left = quantize ? Math.round(value * dpr) / dpr : value; } },
    scrollTop: { get: () => top, set: (value: number) => {
      top = quantize ? Math.min(Math.floor(1379 * dpr) / dpr, Math.round(value * dpr) / dpr) + displacement : value;
      if (quantize && rawScroll) queueMicrotask(() => { top -= 4; });
    } },
  });
  const page: PdfPage = {
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 400 * scale, scale, rotation: 0,
      rawDims: { pageWidth: 600, pageHeight: 400 },
      convertToPdfPoint: (x, y) => [x / scale, 400 - y / scale],
      convertToViewportPoint: (x, y) => [x * scale, (400 - y) * scale],
    }),
    getTextContent: async () => ({ items: [] }), getAnnotations: async () => [],
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
  };
  const resources = new ResourceReservationManager();
  const controller = new PdfReaderController({
    native: {
      openPdfDialog: async () => ({ sessionId: "quantized", documentGeneration: 1, displayName: "mixed.pdf", length: 10 }),
      cancelSession: async () => ({ barrierId: 1 }), closeSession: async () => undefined,
    },
    pdf: { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => page }), destroy: async () => undefined }), annotationMode: 0 },
    resources, canvasHost: host, onCommitted: vi.fn(), onPage: vi.fn(), onStatus: vi.fn(),
  });
  await controller.open(1);
  const transform = { scale: 0.96, rotation: 0, devicePixelRatio: 1.3 };
  await controller.setPresentationTopology("single-page", 1, transform);
  const frame = host.querySelector<HTMLElement>(".pdf-page-frame")!;
  Object.defineProperties(frame, { offsetLeft: { value: 120 }, offsetTop: { value: 1988 } });
  quantize = true;
  return { controller, resources, host, transform };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("repeat navigation at fractional desktop scaling", () => {
  it("verifies the browser-applied edge without widening canonical half-point tolerance", async () => {
    const { controller, resources, host, transform } = await fixture();
    try {
      const outcome = await controller.restoreViewportLanding({ pageIndex: 0, x: 300, y: 400 }, undefined, transform, "page-top");
      expect(outcome.kind).toBe("constrainedEdgeVerified");
      if (outcome.kind !== "constrainedEdgeVerified") throw new Error("Expected browser-constrained landing");
      expect(host.scrollLeft).toBeCloseTo(92.307692, 5);
      expect(host.scrollTop).toBeCloseTo(1378.461538, 5);
      expect(outcome.expected).toEqual(outcome.landing);
      expect(outcome.landing.x).toBeCloseTo(300.320513, 5);
      expect(outcome.landing.y).toBeCloseTo(1034.935897, 5);
      expect(Math.abs(outcome.landing.y - 1034.375)).toBeGreaterThan(0.5);
      expect(resources.snapshot().totals.render).toBe(0);
    } finally { await controller.dispose(); resources.assertEmpty(); }
  });
  it.each([-0.3, -2])("rejects extra displacement %s beyond the browser scroll quantum", async (displacement) => {
    const { controller, resources, transform } = await fixture(displacement);
    try {
      await expect(controller.restoreViewportLanding({ pageIndex: 0, x: 300, y: 400 }, undefined, transform, "page-top"))
        .resolves.toMatchObject({ kind: "failed" });
    } finally { await controller.dispose(); resources.assertEmpty(); }
  });
  it("does not reinterpret raw movement after the owned assignment as quantization", async () => {
    const { controller, resources, transform } = await fixture(0, true);
    const lost = vi.fn();
    try {
      await expect(controller.restoreViewportLanding({ pageIndex: 0, x: 300, y: 400 }, undefined, transform, "page-top", lost))
        .resolves.toEqual({ kind: "staleOrCancelled" });
      expect(lost).toHaveBeenCalledOnce();
    } finally { await controller.dispose(); resources.assertEmpty(); }
  });
});
