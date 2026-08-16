/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { printPdfPrototype, type PdfPrintDocument, type PdfPrintPage } from "../../src/pdf/PdfPrintPrototype";
import { ResourceReservationManager } from "../../src/pdf/ResourceBudget";

const page = (render: PdfPrintPage["render"]): PdfPrintPage => ({
  getViewport: () => ({ width: 20, height: 30 }),
  render,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const urlBoundary = {
  createObjectUrl: () => "blob:print",
  revokeObjectUrl: vi.fn(),
};

describe("printPdfPrototype", () => {
  it("renders sequential page images, invokes system print, and releases every backing store", async () => {
    const resources = new ResourceReservationManager();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const canvases: HTMLCanvasElement[] = [];
    let activeRenders = 0;
    let peakRenders = 0;
    const render = vi.fn(({ canvas }: { readonly canvas: HTMLCanvasElement }) => ({
      promise: Promise.resolve().then(() => {
        canvases.push(canvas);
        activeRenders += 1;
        peakRenders = Math.max(peakRenders, activeRenders);
        activeRenders -= 1;
      }),
      cancel: vi.fn(),
    }));
    const documentBoundary: PdfPrintDocument = { getPage: vi.fn(async () => page(render)) };
    const host = document.createElement("div");
    document.body.append(host);
    const revoked: string[] = [];
    const invokePrint = vi.fn(() => {
      expect(host.querySelectorAll(".pdf-print-page")).toHaveLength(3);
    });

    const result = await printPdfPrototype({
      document: documentBoundary,
      pageCount: 3,
      annotationMode: 0,
      resources,
      sessionId: "print-test",
      host,
      invokePrint,
      encodeCanvas: async () => new Blob(["png"], { type: "image/png" }),
      createObjectUrl: () => `blob:print-${host.querySelectorAll("img").length}`,
      revokeObjectUrl: (url) => revoked.push(url),
    });
    await Promise.resolve();

    expect(result).toEqual({
      pageCount: 3,
      peakCanvasBytes: 20 * 30 * 4,
      encodedImageBytes: 9,
      decodedImageBytes: 3 * 20 * 30 * 4,
    });
    expect(render).toHaveBeenCalledTimes(3);
    expect(peakRenders).toBe(1);
    expect(invokePrint).toHaveBeenCalledOnce();
    expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
    expect(host.querySelector(".pdf-print-surface")).toBeNull();
    expect(revoked).toHaveLength(3);
    resources.assertEmpty();
  });

  it("rejects aggregate print memory beyond the shared process budget", async () => {
    const resources = new ResourceReservationManager();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    let canvas: HTMLCanvasElement | undefined;
    const render = ({ canvas: rendered }: { readonly canvas: HTMLCanvasElement }) => {
      canvas = rendered;
      return { promise: Promise.resolve(), cancel: vi.fn() };
    };
    const host = document.createElement("div");
    const invokePrint = vi.fn();
    const createObjectUrl = vi.fn();

    await expect(printPdfPrototype({
      document: { getPage: async () => page(render) },
      pageCount: 1,
      annotationMode: 0,
      resources,
      sessionId: "print-test",
      host,
      invokePrint,
      encodeCanvas: async () => ({ size: 256 * 1_048_576 + 1 }) as Blob,
      createObjectUrl,
      revokeObjectUrl: vi.fn(),
    })).rejects.toThrow("PRINT_IMAGE_LIMIT");
    await Promise.resolve();

    expect(invokePrint).not.toHaveBeenCalled();
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(canvas).toMatchObject({ width: 0, height: 0 });
    expect(host.querySelector(".pdf-print-surface")).toBeNull();
    resources.assertEmpty();
  });

  it("cleans the surface, reservations, and backing canvas after render failure", async () => {
    const resources = new ResourceReservationManager();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    let canvas: HTMLCanvasElement | undefined;
    const render = ({ canvas: rendered }: { readonly canvas: HTMLCanvasElement }) => {
      canvas = rendered;
      return { promise: Promise.reject(new Error("render failed")), cancel: vi.fn() };
    };
    const host = document.createElement("div");
    const invokePrint = vi.fn();

    await expect(printPdfPrototype({
      document: { getPage: async () => page(render) },
      pageCount: 1,
      annotationMode: 0,
      resources,
      sessionId: "print-test",
      host,
      invokePrint,
      encodeCanvas: async () => new Blob(),
      ...urlBoundary,
    })).rejects.toThrow("render failed");
    await Promise.resolve();

    expect(invokePrint).not.toHaveBeenCalled();
    expect(canvas).toMatchObject({ width: 0, height: 0 });
    expect(host.querySelector(".pdf-print-surface")).toBeNull();
    resources.assertEmpty();
  });

  it("prints every page beyond the 300-page feasibility fixture without an arbitrary page cap", async () => {
    const resources = new ResourceReservationManager();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const getPage = vi.fn(async () => page(() => ({ promise: Promise.resolve(), cancel: vi.fn() })));
    const result = await printPdfPrototype({
      document: { getPage },
      pageCount: 301,
      annotationMode: 0,
      resources,
      sessionId: "print-301",
      invokePrint: vi.fn(),
      encodeCanvas: async () => new Blob(["x"]),
      ...urlBoundary,
    });
    await Promise.resolve();

    expect(result.pageCount).toBe(301);
    expect(getPage).toHaveBeenCalledTimes(301);
    resources.assertEmpty();
  });
  it("returns promptly on abort but retains hidden-surface ownership until a raw page settles", async () => {
    const resources = new ResourceReservationManager();
    const pendingPage = deferred<PdfPrintPage>();
    const abort = new AbortController();
    const ownerships = new Set<Promise<void>>();
    const host = document.createElement("div");
    const operation = printPdfPrototype({
      document: { getPage: () => pendingPage.promise },
      pageCount: 1,
      annotationMode: 0,
      resources,
      sessionId: "print-test",
      signal: abort.signal,
      stageTimeoutMs: 1_000,
      host,
      onOwnershipSettlement: (settlement) => ownerships.add(settlement),
      ...urlBoundary,
    });

    abort.abort();
    await expect(operation).rejects.toThrow("PRINT_CANCELLED");
    expect(host.querySelector(".pdf-print-surface")).not.toBeNull();
    pendingPage.resolve(page(() => ({ promise: Promise.resolve(), cancel: vi.fn() })));
    await Promise.all([...ownerships]);
    expect(host.querySelector(".pdf-print-surface")).toBeNull();
    resources.assertEmpty();
  });
});
