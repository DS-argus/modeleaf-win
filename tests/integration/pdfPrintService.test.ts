// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  printPdfDocument,
  type PdfPrintDocument,
  type PdfPrintPage,
  type PdfPrintProgress,
  type PdfPrintServiceOptions,
} from "../../src/pdf/PdfPrintService";
import { ResourceReservationManager } from "../../src/pdf/ResourceBudget";

/** Records every viewport request so rotation handling is observable. */
interface ViewportCall { readonly scale: number; readonly rotation: number }

function fakeDocument(pageCount: number, options: { readonly rotate?: number; readonly failAtPage?: number } = {}) {
  const viewportCalls: ViewportCall[] = [];
  const cancelled: number[] = [];
  const document: PdfPrintDocument = {
    getPage: async (pageNumber) => {
      if (options.failAtPage === pageNumber) throw new Error("PAGE_LOAD_FAILED");
      const page: PdfPrintPage = {
        ...(options.rotate === undefined ? {} : { rotate: options.rotate }),
        getViewport: (viewportOptions) => {
          viewportCalls.push(viewportOptions);
          // Landscape when rotated a quarter turn, matching PDF.js behavior.
          const quarter = Math.abs(viewportOptions.rotation % 180) === 90;
          return { width: quarter ? 792 : 612, height: quarter ? 612 : 792 };
        },
        render: () => ({
          promise: Promise.resolve(),
          cancel: () => { cancelled.push(pageNumber); },
        }),
      };
      return page;
    },
  };
  return { document, viewportCalls, cancelled };
}

function baseOptions(
  document: PdfPrintDocument,
  pageCount: number,
  overrides: Partial<PdfPrintServiceOptions> = {},
): PdfPrintServiceOptions {
  const urls = new Set<string>();
  let nextUrl = 0;
  return {
    document,
    pageCount,
    annotationMode: 0,
    resources: new ResourceReservationManager(() => undefined),
    sessionId: "print-session",
    invokePrint: () => undefined,
    encodeCanvas: async () => new Blob([new Uint8Array(1024)], { type: "image/png" }),
    createObjectUrl: () => { nextUrl += 1; const url = `blob:print-${String(nextUrl)}`; urls.add(url); return url; },
    revokeObjectUrl: (url) => { urls.delete(url); },
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  // JSDOM has no 2D canvas implementation; the service only needs a context
  // object to hand to PDF.js, which is stubbed at the render boundary.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
});

describe("print page coverage", () => {
  it.each([
    ["single page", 1],
    ["twelve pages", 12],
    ["three hundred pages", 300],
  ])("prints every page of a %s document in order", async (_label, pageCount) => {
    const requested: number[] = [];
    const { document: source } = fakeDocument(pageCount);
    const tracking: PdfPrintDocument = {
      getPage: async (pageNumber) => { requested.push(pageNumber); return source.getPage(pageNumber); },
    };

    const outcome = await printPdfDocument(baseOptions(tracking, pageCount));

    expect(outcome).toMatchObject({ kind: "printed", pageCount });
    // Sequential and complete: no gaps, no reordering, no duplicates.
    expect(requested).toEqual(Array.from({ length: pageCount }, (_, index) => index + 1));
  });

  it("opens the system print flow exactly once", async () => {
    const invokePrint = vi.fn();
    const { document: source } = fakeDocument(12);
    await printPdfDocument(baseOptions(source, 12, { invokePrint }));
    expect(invokePrint).toHaveBeenCalledTimes(1);
  });

  it("rejects a nonsensical page count instead of printing nothing silently", async () => {
    const { document: source } = fakeDocument(1);
    await expect(printPdfDocument(baseOptions(source, 0))).resolves.toMatchObject({ kind: "failed", reason: "PRINT_PAGE_LIMIT" });
    await expect(printPdfDocument(baseOptions(source, -3))).resolves.toMatchObject({ kind: "failed" });
  });
});

describe("bounded memory", () => {
  it("keeps peak retained bytes flat as the document grows", async () => {
    // The documented OOM failure mode is retaining all 300 pages at once.
    const small = await printPdfDocument(baseOptions(fakeDocument(12).document, 12, { maxRetainedPages: 8 }));
    const large = await printPdfDocument(baseOptions(fakeDocument(300).document, 300, { maxRetainedPages: 8 }));

    expect(small.kind).toBe("printed");
    expect(large.kind).toBe("printed");
    if (small.kind !== "printed" || large.kind !== "printed") return;
    // A 25x longer document must not raise peak retention at all.
    expect(large.peakRetainedBytes).toBe(small.peakRetainedBytes);
    // The newest page is appended before the oldest is evicted, so the true
    // ceiling is window + 1 pages, independent of document length.
    expect(large.peakRetainedBytes).toBeLessThanOrEqual(9 * 1024);
  });

  it("retains at most the configured window of prepared pages in the DOM", async () => {
    let maximumImages = 0;
    const { document: source } = fakeDocument(60);
    await printPdfDocument(baseOptions(source, 60, {
      maxRetainedPages: 5,
      onProgress: () => {
        maximumImages = Math.max(maximumImages, document.querySelectorAll(".pdf-print-page").length);
      },
    }));
    expect(maximumImages).toBeLessThanOrEqual(5);
  });

  it("revokes every object URL it created", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const { document: source } = fakeDocument(20);
    await printPdfDocument(baseOptions(source, 20, {
      maxRetainedPages: 4,
      createObjectUrl: () => { const url = `blob:page-${String(created.length)}`; created.push(url); return url; },
      revokeObjectUrl: (url) => { revoked.push(url); },
    }));
    await Promise.resolve();
    expect(created.length).toBe(20);
    expect(new Set(revoked)).toEqual(new Set(created));
  });

  it("rejects an invalid retention window rather than defaulting silently", async () => {
    const { document: source } = fakeDocument(3);
    await expect(printPdfDocument(baseOptions(source, 3, { maxRetainedPages: 0 })))
      .resolves.toMatchObject({ kind: "failed", reason: "PRINT_RETENTION_LIMIT" });
  });
});

describe("page rotation", () => {
  it("preserves a page's intrinsic rotation", async () => {
    // PDF.js replaces /Rotate with an explicit rotation option, so passing 0
    // would silently unrotate a landscape source page.
    const { document: source, viewportCalls } = fakeDocument(3, { rotate: 90 });
    const outcome = await printPdfDocument(baseOptions(source, 3));
    expect(outcome.kind).toBe("printed");
    expect(viewportCalls).toHaveLength(3);
    expect(viewportCalls.every((call) => call.rotation === 90)).toBe(true);
  });

  it("uses zero only when the page declares no rotation", async () => {
    const { document: source, viewportCalls } = fakeDocument(2);
    await printPdfDocument(baseOptions(source, 2));
    expect(viewportCalls.every((call) => call.rotation === 0)).toBe(true);
  });

  it("ignores a non-finite rotation instead of producing NaN geometry", async () => {
    const { document: source, viewportCalls } = fakeDocument(1, { rotate: Number.NaN });
    await printPdfDocument(baseOptions(source, 1));
    expect(viewportCalls[0]?.rotation).toBe(0);
  });

  it("renders at unscaled page size so output matches the source", async () => {
    const { document: source, viewportCalls } = fakeDocument(2);
    await printPdfDocument(baseOptions(source, 2));
    expect(viewportCalls.every((call) => call.scale === 1)).toBe(true);
  });
});

describe("cancellation", () => {
  it("reports cancellation as a normal outcome, not a throw", async () => {
    const controller = new AbortController();
    const { document: source } = fakeDocument(300);
    const running = printPdfDocument(baseOptions(source, 300, {
      signal: controller.signal,
      onProgress: (progress: PdfPrintProgress) => { if (progress.preparedPages === 3) controller.abort(); },
    }));
    const outcome = await running;
    expect(outcome.kind).toBe("cancelled");
    if (outcome.kind === "cancelled") expect(outcome.preparedPages).toBeGreaterThan(0);
  });

  it("leaves no print surface behind after cancellation", async () => {
    const controller = new AbortController();
    const { document: source } = fakeDocument(50);
    await printPdfDocument(baseOptions(source, 50, {
      signal: controller.signal,
      onProgress: (progress) => { if (progress.preparedPages === 2) controller.abort(); },
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector(".pdf-print-surface")).toBeNull();
  });

  it("never opens the print dialog when cancelled during preparation", async () => {
    const invokePrint = vi.fn();
    const controller = new AbortController();
    const { document: source } = fakeDocument(40);
    await printPdfDocument(baseOptions(source, 40, {
      signal: controller.signal,
      invokePrint,
      onProgress: (progress) => { if (progress.preparedPages === 1) controller.abort(); },
    }));
    expect(invokePrint).not.toHaveBeenCalled();
  });

  it("returns cancelled immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const { document: source } = fakeDocument(10);
    const outcome = await printPdfDocument(baseOptions(source, 10, { signal: controller.signal }));
    expect(outcome).toMatchObject({ kind: "cancelled", preparedPages: 0 });
  });
});

describe("failure reporting", () => {
  it("reports a page-load failure truthfully rather than as success", async () => {
    const { document: source } = fakeDocument(10, { failAtPage: 4 });
    const outcome = await printPdfDocument(baseOptions(source, 10));
    expect(outcome).toMatchObject({ kind: "failed", reason: "PAGE_LOAD_FAILED" });
    if (outcome.kind === "failed") expect(outcome.preparedPages).toBe(3);
  });

  it("reports an encode failure and never opens the dialog", async () => {
    const invokePrint = vi.fn();
    const { document: source } = fakeDocument(5);
    const outcome = await printPdfDocument(baseOptions(source, 5, {
      invokePrint,
      encodeCanvas: async () => new Blob([], { type: "image/png" }),
    }));
    expect(outcome).toMatchObject({ kind: "failed", reason: "PRINT_ENCODE_FAILED" });
    expect(invokePrint).not.toHaveBeenCalled();
  });

  it("cleans up the surface after a failure", async () => {
    const { document: source } = fakeDocument(10, { failAtPage: 2 });
    await printPdfDocument(baseOptions(source, 10));
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector(".pdf-print-surface")).toBeNull();
  });
});

describe("progress reporting", () => {
  it("reports monotonic progress through every phase", async () => {
    const phases: string[] = [];
    const fractions: number[] = [];
    const { document: source } = fakeDocument(6);
    await printPdfDocument(baseOptions(source, 6, {
      onProgress: (progress) => { phases.push(progress.phase); fractions.push(progress.fraction); },
    }));

    expect(phases[0]).toBe("preparing");
    expect(phases).toContain("opening-dialog");
    expect(phases.at(-1)).toBe("complete");
    // Never decreases, and finishes at exactly 1.
    for (let index = 1; index < fractions.length; index += 1) {
      expect(fractions[index]!).toBeGreaterThanOrEqual(fractions[index - 1]!);
    }
    expect(fractions.at(-1)).toBe(1);
  });

  it("counts prepared pages accurately", async () => {
    const counts: number[] = [];
    const { document: source } = fakeDocument(4);
    await printPdfDocument(baseOptions(source, 4, {
      onProgress: (progress) => { if (progress.phase === "preparing") counts.push(progress.preparedPages); },
    }));
    expect(counts).toEqual([0, 1, 2, 3, 4]);
  });

  it("reports the failed phase on error", async () => {
    const phases: string[] = [];
    const { document: source } = fakeDocument(3, { failAtPage: 2 });
    await printPdfDocument(baseOptions(source, 3, { onProgress: (progress) => phases.push(progress.phase) }));
    expect(phases.at(-1)).toBe("failed");
  });
});

describe("print surface isolation", () => {
  it("marks the surface hidden from assistive technology", async () => {
    let surfaceHidden: string | null = null;
    const { document: source } = fakeDocument(2);
    await printPdfDocument(baseOptions(source, 2, {
      onProgress: () => {
        surfaceHidden ??= document.querySelector(".pdf-print-surface")?.getAttribute("aria-hidden") ?? null;
      },
    }));
    expect(surfaceHidden).toBe("true");
  });

  it("uses a dedicated surface rather than the reader DOM", async () => {
    const readerHost = document.createElement("main");
    readerHost.className = "reader-surface";
    document.body.append(readerHost);
    const { document: source } = fakeDocument(3);
    await printPdfDocument(baseOptions(source, 3));
    // Nothing was ever appended to the reader surface.
    expect(readerHost.children).toHaveLength(0);
  });
});
