// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  printPdfDocument,
  type PdfPrintDocument,
  type PdfPrintNative,
  type PdfPrintPage,
  type PdfPrintPageRange,
  type PdfPrintProgress,
  type PdfPrintServiceOptions,
  type PdfPrintSnapshot,
} from "../../src/pdf/PdfPrintService";
import { TauriPdfPrintBoundary } from "../../src/pdf/TauriPdfPrintBoundary";
import { ResourceReservationManager, RESOURCE_LIMITS } from "../../src/pdf/ResourceBudget";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const JOB_ID = "a".repeat(64);
const PRINT_SCALE = 300 / 72;
type Pixel = readonly [number, number, number, number];
let currentRenderedPixel: Pixel = [17, 34, 51, 255];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(
  phase: PdfPrintSnapshot["phase"],
  pageCount: number,
  pageRanges: readonly PdfPrintPageRange[] = [],
  submittedPages = 0,
  error: string | null = phase === "failed" ? "PRINT_NATIVE_FAILED" : null,
): PdfPrintSnapshot {
  return { jobId: JOB_ID, phase, pageCount, pageRanges, submittedPages, error };
}

interface DeliveredPage {
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly widthPoints: number;
  readonly heightPoints: number;
  readonly firstPixel: readonly number[];
  readonly byteLength: number;
}

function decodeDelivered(payload: Uint8Array): DeliveredPage {
  const header = new DataView(payload.buffer, payload.byteOffset, 32);
  expect(header.getUint32(0, true)).toBe(0x3152_504d);
  const width = header.getUint32(8, true);
  const height = header.getUint32(12, true);
  expect(payload.byteLength).toBe(32 + width * height * 4);
  return {
    pageNumber: header.getUint32(4, true),
    width,
    height,
    widthPoints: header.getFloat64(16, true),
    heightPoints: header.getFloat64(24, true),
    firstPixel: [...payload.subarray(32, 36)],
    byteLength: payload.byteLength,
  };
}

interface FakeNativeState {
  ready: boolean;
  submitted: number;
  readonly delivered: DeliveredPage[];
}

function fakeNative(
  pageCount: number,
  pageRanges: readonly PdfPrintPageRange[] = [{ from: 1, to: pageCount }],
): { readonly native: PdfPrintNative; readonly state: FakeNativeState } {
  const state: FakeNativeState = { ready: false, submitted: 0, delivered: [] };
  const native: PdfPrintNative = {
    start: vi.fn(async () => snapshot("dialog", pageCount)),
    poll: vi.fn(async () => {
      state.ready = true;
      return snapshot("ready", pageCount, pageRanges);
    }),
    submit: vi.fn(async (_jobId, payload) => {
      state.delivered.push(decodeDelivered(payload));
      state.submitted += 1;
      return snapshot("printing", pageCount, pageRanges, state.submitted);
    }),
    finish: vi.fn(async () => snapshot("submitted", pageCount, pageRanges, state.submitted)),
    cancel: vi.fn(async () => snapshot(
      "cancelled",
      pageCount,
      state.ready ? pageRanges : [],
      state.submitted,
    )),
    release: vi.fn(async () => undefined),
  };
  return { native, state };
}

interface PageSpec {
  readonly widthPoints?: number;
  readonly heightPoints?: number;
  readonly rotate?: number;
  readonly pixel?: Pixel;
  readonly load?: () => Promise<void>;
  readonly render?: () => { readonly promise: Promise<void>; cancel(): void };
}

interface FakeDocumentResult {
  readonly document: PdfPrintDocument;
  readonly requested: number[];
  readonly viewportCalls: { readonly pageNumber: number; readonly scale: number; readonly rotation: number }[];
  readonly renderCalls: { readonly pageNumber: number; readonly options: Parameters<PdfPrintPage["render"]>[0] }[];
}

function fakeDocument(pageCount: number, specs: Readonly<Record<number, PageSpec>> = {}): FakeDocumentResult {
  const requested: number[] = [];
  const viewportCalls: FakeDocumentResult["viewportCalls"] extends readonly (infer T)[] ? T[] : never = [];
  const renderCalls: FakeDocumentResult["renderCalls"] extends readonly (infer T)[] ? T[] : never = [];
  const document: PdfPrintDocument = {
    getPage: vi.fn(async (pageNumber) => {
      requested.push(pageNumber);
      const spec = specs[pageNumber] ?? {};
      await spec.load?.();
      const page: PdfPrintPage = {
        ...(spec.rotate === undefined ? {} : { rotate: spec.rotate }),
        getViewport: ({ scale, rotation }) => {
          viewportCalls.push({ pageNumber, scale, rotation });
          const quarterTurn = Math.abs(rotation % 180) === 90;
          const width = spec.widthPoints ?? 1;
          const height = spec.heightPoints ?? 1;
          return {
            width: (quarterTurn ? height : width) * scale,
            height: (quarterTurn ? width : height) * scale,
          };
        },
        render: (options) => {
          renderCalls.push({ pageNumber, options });
          currentRenderedPixel = spec.pixel ?? [pageNumber & 0xff, pageNumber * 3 & 0xff, pageNumber * 7 & 0xff, 255];
          options.canvas.dataset.printPage = String(pageNumber);
          return spec.render?.() ?? { promise: Promise.resolve(), cancel: vi.fn() };
        },
      };
      return page;
    }),
  };
  return { document, requested, viewportCalls, renderCalls };
}

function baseOptions(
  document: PdfPrintDocument,
  native: PdfPrintNative,
  pageCount: number,
  overrides: Partial<PdfPrintServiceOptions> = {},
): PdfPrintServiceOptions {
  return {
    document,
    native,
    pageCount,
    currentPage: 1,
    title: "fixture.pdf",
    annotationMode: 0,
    resources: new ResourceReservationManager(),
    sessionId: "print-session",
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  currentRenderedPixel = [17, 34, 51, 255];
  vi.mocked(invoke).mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let offset = 0; offset < data.length; offset += 4) data.set(currentRenderedPixel, offset);
      return { data } as ImageData;
    },
  } as CanvasRenderingContext2D);
});

describe("native print consumer page delivery", () => {
  it.each([1, 12, 24, 25, 30, 300])(
    "delivers all %i page headers and pixel sentinels in source order",
    async (pageCount) => {
      const events: string[] = [];
      const source = fakeDocument(pageCount);
      const tracked: PdfPrintDocument = {
        getPage: async (pageNumber) => {
          events.push(`page:${String(pageNumber)}`);
          return source.document.getPage(pageNumber);
        },
      };
      const consumer = fakeNative(pageCount);
      vi.mocked(consumer.native.start).mockImplementation(async (request) => {
        events.push("start");
        expect(request).toEqual({ pageCount, currentPage: 1, title: "fixture.pdf" });
        return snapshot("dialog", pageCount);
      });

      const outcome = await printPdfDocument(baseOptions(tracked, consumer.native, pageCount));

      expect(outcome).toEqual({ kind: "submitted", pageCount });
      expect(events[0]).toBe("start");
      expect(source.requested).toEqual(Array.from({ length: pageCount }, (_, index) => index + 1));
      expect(consumer.state.delivered.map((page) => page.pageNumber))
        .toEqual(Array.from({ length: pageCount }, (_, index) => index + 1));
      for (const delivered of consumer.state.delivered) {
        const page = delivered.pageNumber;
        expect(delivered.firstPixel).toEqual([page * 7 & 0xff, page * 3 & 0xff, page & 0xff, 255]);
      }
      expect(consumer.native.finish).toHaveBeenCalledOnce();
      expect(consumer.native.release).toHaveBeenCalledWith(JOB_ID);
    },
  );

  it("renders only normalized native-selected ranges, sequentially", async () => {
    const ranges = [{ from: 2, to: 3 }, { from: 7, to: 7 }] as const;
    const source = fakeDocument(9);
    const consumer = fakeNative(9, ranges);

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 9));

    expect(outcome).toEqual({ kind: "submitted", pageCount: 3 });
    expect(source.requested).toEqual([2, 3, 7]);
    expect(consumer.state.delivered.map((page) => page.pageNumber)).toEqual([2, 3, 7]);
  });

  it("does not load or render a page until the native dialog reports ready", async () => {
    const source = fakeDocument(2);
    const consumer = fakeNative(2);
    const poll = deferred<PdfPrintSnapshot>();
    vi.mocked(consumer.native.poll).mockReturnValueOnce(poll.promise);

    const operation = printPdfDocument(baseOptions(source.document, consumer.native, 2));
    await vi.waitFor(() => expect(consumer.native.poll).toHaveBeenCalledOnce());
    expect(source.requested).toEqual([]);
    poll.resolve(snapshot("ready", 2, [{ from: 1, to: 2 }]));

    await expect(operation).resolves.toEqual({ kind: "submitted", pageCount: 2 });
  });

  it("preserves mixed point sizes, intrinsic rotation, blank pages, and print render intent", async () => {
    const source = fakeDocument(3, {
      1: { widthPoints: 1.25, heightPoints: 2.5, pixel: [0, 0, 0, 0] },
      2: { widthPoints: 2.75, heightPoints: 1.5, rotate: 90, pixel: [10, 20, 30, 128] },
      3: { widthPoints: 0.5, heightPoints: 3.125, rotate: 180, pixel: [200, 100, 50, 255] },
    });
    const consumer = fakeNative(3);

    await printPdfDocument(baseOptions(source.document, consumer.native, 3));

    expect(consumer.state.delivered.map(({ widthPoints, heightPoints }) => [widthPoints, heightPoints])).toEqual([
      [1.25, 2.5],
      [1.5, 2.75],
      [0.5, 3.125],
    ]);
    expect(consumer.state.delivered[0]?.firstPixel).toEqual([255, 255, 255, 255]);
    expect(consumer.state.delivered[1]?.firstPixel).toEqual([142, 137, 132, 255]);
    expect(source.viewportCalls.filter((call) => call.scale === PRINT_SCALE).map((call) => call.rotation))
      .toEqual([0, 90, 180]);
    expect(source.renderCalls.every(({ options }) => options.intent === "print"
      && options.background === "rgb(255,255,255)")).toBe(true);
  });

  it("uses 300 DPI without silently reducing oversized pages", async () => {
    const source = fakeDocument(1, { 1: { widthPoints: 4_000, heightPoints: 4_000 } });
    const consumer = fakeNative(1);

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 1));

    expect(outcome).toMatchObject({ kind: "failed", reason: "PRINT_IMAGE_LIMIT", preparedPages: 0 });
    expect(source.viewportCalls).toContainEqual({ pageNumber: 1, scale: PRINT_SCALE, rotation: 0 });
    expect(source.renderCalls).toHaveLength(0);
    expect(consumer.native.submit).not.toHaveBeenCalled();
    expect(consumer.native.cancel).toHaveBeenCalledWith(JOB_ID);
    expect(consumer.native.release).toHaveBeenCalledWith(JOB_ID);
  });
});

describe("bounded producer ownership and backpressure", () => {
  it("prints within two page buffers without evicting the reader reservation", async () => {
    const resources = new ResourceReservationManager();
    const source = fakeDocument(1);
    const consumer = fakeNative(1);
    const pageBytes = Math.ceil(PRINT_SCALE) ** 2 * 4;
    const reader = resources.reserve({ kind: "canvas-bytes", amount: RESOURCE_LIMITS.maxCanvasBytes - (pageBytes * 2 + 32), sessionId: "reader" });
    if (!reader.ok) throw new Error("Reader fixture reservation failed");
    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 1, { resources }));
    expect(outcome).toEqual({ kind: "submitted", pageCount: 1 });
    expect(source.renderCalls[0]!.options.canvas).toMatchObject({ width: 0, height: 0 });
    expect(resources.snapshot().reservationCount).toBe(1);
    expect(resources.release(reader.reservation)).toBe(true);
    resources.assertEmpty();
  });
  it("releases reservations when canvas creation throws synchronously", async () => {
    const resources = new ResourceReservationManager();
    const source = fakeDocument(1);
    const consumer = fakeNative(1);
    vi.spyOn(document, "createElement").mockImplementationOnce(() => { throw new Error("CANVAS_ALLOCATION_FAILED"); });
    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 1, { resources }));
    expect(outcome).toEqual({ kind: "failed", reason: "CANVAS_ALLOCATION_FAILED", preparedPages: 0 });
    expect(consumer.native.submit).not.toHaveBeenCalled();
    expect(consumer.native.cancel).toHaveBeenCalledOnce();
    expect(consumer.native.release).toHaveBeenCalledOnce();
    resources.assertEmpty();
  });
  it("holds one controlled page allocation through native acknowledgement and leaves zero resources", async () => {
    const resources = new ResourceReservationManager();
    const source = fakeDocument(30);
    const consumer = fakeNative(30);
    const canvasTotals: number[] = [];
    vi.mocked(consumer.native.submit).mockImplementation(async (_jobId, payload) => {
      canvasTotals.push(resources.snapshot().totals["canvas-bytes"]);
      consumer.state.delivered.push(decodeDelivered(payload));
      consumer.state.submitted += 1;
      return snapshot("printing", 30, [{ from: 1, to: 30 }], consumer.state.submitted);
    });

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 30, { resources }));

    expect(outcome.kind).toBe("submitted");
    expect(canvasTotals).toHaveLength(30);
    expect(new Set(canvasTotals).size).toBe(1);
    expect(canvasTotals[0]).toBeGreaterThan(0);
    expect(resources.snapshot().totals.render).toBe(0);
    resources.assertEmpty();
    expect(document.querySelectorAll("canvas, img, .pdf-print-surface")).toHaveLength(0);
  });

  it("does not render the next page while native submit is blocked", async () => {
    const source = fakeDocument(2);
    const consumer = fakeNative(2);
    const firstSubmit = deferred<PdfPrintSnapshot>();
    vi.mocked(consumer.native.submit)
      .mockReturnValueOnce(firstSubmit.promise)
      .mockImplementationOnce(async (_jobId, payload) => {
        consumer.state.delivered.push(decodeDelivered(payload));
        consumer.state.submitted = 2;
        return snapshot("printing", 2, [{ from: 1, to: 2 }], 2);
      });

    const operation = printPdfDocument(baseOptions(source.document, consumer.native, 2));
    await vi.waitFor(() => expect(consumer.native.submit).toHaveBeenCalledOnce());
    expect(source.requested).toEqual([1]);
    expect(source.renderCalls.map((call) => call.pageNumber)).toEqual([1]);
    firstSubmit.resolve(snapshot("printing", 2, [{ from: 1, to: 2 }], 1));

    await expect(operation).resolves.toEqual({ kind: "submitted", pageCount: 2 });
    expect(source.requested).toEqual([1, 2]);
  });

  it("does not apply the PDF stage timeout to a blocking native submit", async () => {
    const source = fakeDocument(1);
    const consumer = fakeNative(1);
    const submit = deferred<PdfPrintSnapshot>();
    vi.mocked(consumer.native.submit).mockReturnValue(submit.promise);
    let settled = false;

    const operation = printPdfDocument(baseOptions(source.document, consumer.native, 1, { stageTimeoutMs: 1 }));
    void operation.then(() => { settled = true; });
    await vi.waitFor(() => expect(consumer.native.submit).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    consumer.state.submitted = 1;
    submit.resolve(snapshot("printing", 1, [{ from: 1, to: 1 }], 1));

    await expect(operation).resolves.toEqual({ kind: "submitted", pageCount: 1 });
  });

  it("waits boundedly for the shared global render slot", async () => {
    const resources = new ResourceReservationManager();
    const occupied = resources.reserve({ kind: "render", amount: 1, sessionId: "reader" });
    if (!occupied.ok) throw new Error("fixture reservation failed");
    const source = fakeDocument(1);
    const consumer = fakeNative(1);

    const operation = printPdfDocument(baseOptions(source.document, consumer.native, 1, {
      resources,
      stageTimeoutMs: 100,
    }));
    await vi.waitFor(() => expect(source.requested).toEqual([1]));
    expect(source.renderCalls).toHaveLength(0);
    resources.release(occupied.reservation);

    await expect(operation).resolves.toEqual({ kind: "submitted", pageCount: 1 });
    resources.assertEmpty();
  });
});

describe("native state validation and truthful outcomes", () => {
  it.each([
    ["overlapping", [{ from: 1, to: 2 }, { from: 2, to: 3 }]],
    ["adjacent non-normalized", [{ from: 1, to: 1 }, { from: 2, to: 2 }]],
    ["descending", [{ from: 4, to: 4 }, { from: 2, to: 2 }]],
    ["out of bounds", [{ from: 1, to: 6 }]],
  ] as const)("rejects %s native page ranges", async (_label, badRanges) => {
    const source = fakeDocument(5);
    const consumer = fakeNative(5);
    vi.mocked(consumer.native.poll).mockResolvedValue({
      ...snapshot("ready", 5, [{ from: 1, to: 1 }]),
      pageRanges: badRanges,
    });

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 5));

    expect(outcome).toMatchObject({ kind: "failed", reason: "PRINT_NATIVE_CONTRACT_INVALID" });
    expect(source.requested).toHaveLength(0);
    expect(consumer.native.cancel).toHaveBeenCalled();
    expect(consumer.native.release).toHaveBeenCalled();
  });

  it("rejects more than the native 16-range bound", async () => {
    const source = fakeDocument(34);
    const consumer = fakeNative(34);
    const ranges = Array.from({ length: 17 }, (_, index) => ({ from: index * 2 + 1, to: index * 2 + 1 }));
    vi.mocked(consumer.native.poll).mockResolvedValue(snapshot("ready", 34, ranges));

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 34));

    expect(outcome).toMatchObject({ kind: "failed", reason: "PRINT_NATIVE_CONTRACT_INVALID" });
    expect(source.requested).toHaveLength(0);
  });
  it("rejects an optimistic or duplicate submit acknowledgement", async () => {
    const source = fakeDocument(2);
    const consumer = fakeNative(2);
    vi.mocked(consumer.native.submit).mockResolvedValue(snapshot("printing", 2, [{ from: 1, to: 2 }], 2));

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 2));

    expect(outcome).toMatchObject({ kind: "failed", reason: "PRINT_NATIVE_CONTRACT_INVALID", preparedPages: 1 });
    expect(source.requested).toEqual([1]);
    expect(consumer.native.finish).not.toHaveBeenCalled();
  });

  it("rejects ranges that change after the dialog selection", async () => {
    const source = fakeDocument(3);
    const consumer = fakeNative(3, [{ from: 1, to: 2 }]);
    vi.mocked(consumer.native.submit).mockResolvedValue(snapshot("printing", 3, [{ from: 2, to: 3 }], 1));

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 3));

    expect(outcome).toMatchObject({ kind: "failed", reason: "PRINT_NATIVE_CONTRACT_INVALID" });
  });

  it("rejects malformed snapshots rather than trusting TypeScript annotations", async () => {
    const source = fakeDocument(1);
    const consumer = fakeNative(1);
    vi.mocked(consumer.native.poll).mockResolvedValue({
      ...snapshot("ready", 1, [{ from: 1, to: 1 }]),
      unexpected: "field",
    } as PdfPrintSnapshot);

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 1));

    expect(outcome).toMatchObject({ kind: "failed", reason: "PRINT_NATIVE_CONTRACT_INVALID" });
  });

  it("reports native dialog cancellation without loading a page", async () => {
    const source = fakeDocument(4);
    const consumer = fakeNative(4);
    vi.mocked(consumer.native.poll).mockResolvedValue(snapshot("cancelled", 4));

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 4));

    expect(outcome).toEqual({ kind: "cancelled", preparedPages: 0 });
    expect(source.requested).toEqual([]);
    expect(consumer.native.release).toHaveBeenCalledOnce();
  });

  it("reports submitted rather than claiming pages were physically printed", async () => {
    const source = fakeDocument(1);
    const consumer = fakeNative(1);
    const progress: PdfPrintProgress[] = [];

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 1, {
      onProgress: (value) => progress.push(value),
    }));

    expect(outcome).toEqual({ kind: "submitted", pageCount: 1 });
    expect(progress.map(({ phase }) => phase)).toEqual([
      "opening-dialog", "preparing", "preparing", "submitted",
    ]);
    expect(progress.at(-1)).toMatchObject({ preparedPages: 1, totalPages: 1, fraction: 1 });
    expect(JSON.stringify(outcome)).not.toContain("printed");
  });

  it("turns release failure into a failed outcome", async () => {
    const source = fakeDocument(1);
    const consumer = fakeNative(1);
    vi.mocked(consumer.native.release).mockRejectedValue(new Error("PRINT_RELEASE_FAILED"));
    let ownership!: Promise<void>;

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 1, {
      onOwnershipSettlement: (settlement) => { ownership = settlement; },
    }));

    expect(outcome).toEqual({ kind: "failed", reason: "PRINT_RELEASE_FAILED", preparedPages: 1 });
    let ownershipSettled = false;
    void ownership.then(() => { ownershipSettled = true; }, () => { ownershipSettled = true; });
    await Promise.resolve();
    expect(ownershipSettled).toBe(false);
  });
});

describe("cancellation and late raw ownership", () => {
  it("accepts zero acknowledged pages while the first native submission is being cancelled", async () => {
    const source = fakeDocument(1);
    const consumer = fakeNative(1);
    const abort = new AbortController();
    const resources = new ResourceReservationManager();
    const submit = deferred<PdfPrintSnapshot>();
    const ranges = [{ from: 1, to: 1 }];
    let ownership!: Promise<void>;
    vi.mocked(consumer.native.submit).mockReturnValue(submit.promise);
    vi.mocked(consumer.native.cancel).mockResolvedValue(snapshot("printing", 1, ranges, 0));
    vi.mocked(consumer.native.poll)
      .mockResolvedValueOnce(snapshot("ready", 1, ranges))
      .mockResolvedValue(snapshot("cancelled", 1, ranges, 0));
    const operation = printPdfDocument(baseOptions(source.document, consumer.native, 1, {
      signal: abort.signal, resources, onOwnershipSettlement: (raw) => { ownership = raw; },
    }));
    await vi.waitFor(() => expect(consumer.native.submit).toHaveBeenCalledOnce());
    abort.abort();
    await expect(operation).resolves.toEqual({ kind: "cancelled", preparedPages: 1 });
    expect(consumer.native.release).toHaveBeenCalledOnce();
    expect(resources.snapshot().reservationCount).toBe(1);
    submit.reject(new Error("PRINT_CANCELLED"));
    await ownership;
    resources.assertEmpty();
  });
  it("does not start native printing for an already-aborted signal", async () => {
    const abort = new AbortController();
    abort.abort();
    const source = fakeDocument(1);
    const consumer = fakeNative(1);

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 1, { signal: abort.signal }));

    expect(outcome).toEqual({ kind: "cancelled", preparedPages: 0 });
    expect(consumer.native.start).not.toHaveBeenCalled();
  });

  it("cancels a job returned after start was pending and never begins preparation", async () => {
    const abort = new AbortController();
    const start = deferred<PdfPrintSnapshot>();
    const source = fakeDocument(1);
    const consumer = fakeNative(1);
    vi.mocked(consumer.native.start).mockReturnValue(start.promise);

    const operation = printPdfDocument(baseOptions(source.document, consumer.native, 1, { signal: abort.signal }));
    await vi.waitFor(() => expect(consumer.native.start).toHaveBeenCalledOnce());
    abort.abort();
    start.resolve(snapshot("dialog", 1));

    await expect(operation).resolves.toEqual({ kind: "cancelled", preparedPages: 0 });
    expect(source.requested).toEqual([]);
    expect(consumer.native.cancel).toHaveBeenCalledWith(JOB_ID);
    expect(consumer.native.release).toHaveBeenCalledWith(JOB_ID);
  });

  it("keeps ownership for a late dialog poll without reopening preparation", async () => {
    const abort = new AbortController();
    const poll = deferred<PdfPrintSnapshot>();
    const source = fakeDocument(1);
    const consumer = fakeNative(1);
    vi.mocked(consumer.native.poll).mockReturnValueOnce(poll.promise);
    let ownership!: Promise<void>;

    const operation = printPdfDocument(baseOptions(source.document, consumer.native, 1, {
      signal: abort.signal,
      onOwnershipSettlement: (settlement) => { ownership = settlement; },
    }));
    await vi.waitFor(() => expect(consumer.native.poll).toHaveBeenCalledOnce());
    abort.abort();
    await expect(operation).resolves.toEqual({ kind: "cancelled", preparedPages: 0 });
    let owned = true;
    void ownership.then(() => { owned = false; });
    await Promise.resolve();
    expect(owned).toBe(true);
    expect(source.requested).toEqual([]);

    poll.resolve(snapshot("dialog", 1));
    await ownership;
    expect(source.requested).toEqual([]);
  });

  it("cancels rendering and retains its reservation until the raw task settles", async () => {
    const abort = new AbortController();
    const render = deferred<void>();
    const cancelRender = vi.fn();
    const resources = new ResourceReservationManager();
    const source = fakeDocument(1, { 1: { render: () => ({ promise: render.promise, cancel: cancelRender }) } });
    const consumer = fakeNative(1);
    vi.mocked(consumer.native.poll)
      .mockResolvedValueOnce(snapshot("ready", 1, [{ from: 1, to: 1 }]))
      .mockResolvedValueOnce(snapshot("cancelled", 1, [{ from: 1, to: 1 }], 0));
    vi.mocked(consumer.native.cancel)
      .mockResolvedValue(snapshot("printing", 1, [{ from: 1, to: 1 }], 0));
    let ownership!: Promise<void>;

    const operation = printPdfDocument(baseOptions(source.document, consumer.native, 1, {
      resources,
      signal: abort.signal,
      onOwnershipSettlement: (settlement) => { ownership = settlement; },
    }));
    await vi.waitFor(() => expect(source.renderCalls).toHaveLength(1));
    abort.abort();
    await expect(operation).resolves.toEqual({ kind: "cancelled", preparedPages: 0 });
    expect(cancelRender).toHaveBeenCalled();
    expect(resources.snapshot().totals.render).toBe(1);
    expect(resources.snapshot().totals["canvas-bytes"]).toBeGreaterThan(0);

    render.resolve();
    await ownership;
    resources.assertEmpty();
  });

  it("retains the page payload while a cancelled native submit settles late", async () => {
    const abort = new AbortController();
    const submit = deferred<PdfPrintSnapshot>();
    const resources = new ResourceReservationManager();
    const source = fakeDocument(1);
    const consumer = fakeNative(1);
    vi.mocked(consumer.native.submit).mockReturnValue(submit.promise);
    let ownership!: Promise<void>;

    const operation = printPdfDocument(baseOptions(source.document, consumer.native, 1, {
      resources,
      signal: abort.signal,
      onOwnershipSettlement: (settlement) => { ownership = settlement; },
    }));
    await vi.waitFor(() => expect(consumer.native.submit).toHaveBeenCalledOnce());
    abort.abort();
    await expect(operation).resolves.toEqual({ kind: "cancelled", preparedPages: 1 });
    expect(resources.snapshot().totals["canvas-bytes"]).toBeGreaterThan(0);
    expect(consumer.native.release).toHaveBeenCalled();

    submit.resolve(snapshot("printing", 1, [{ from: 1, to: 1 }], 1));
    await ownership;
    resources.assertEmpty();
  });

  it("keeps ownership when native finish settles after cancellation", async () => {
    const abort = new AbortController();
    const finish = deferred<PdfPrintSnapshot>();
    const source = fakeDocument(1);
    const consumer = fakeNative(1);
    vi.mocked(consumer.native.finish).mockReturnValue(finish.promise);
    let ownership!: Promise<void>;

    const operation = printPdfDocument(baseOptions(source.document, consumer.native, 1, {
      signal: abort.signal,
      onOwnershipSettlement: (settlement) => { ownership = settlement; },
    }));
    await vi.waitFor(() => expect(consumer.native.finish).toHaveBeenCalledOnce());
    abort.abort();
    await expect(operation).resolves.toEqual({ kind: "cancelled", preparedPages: 1 });
    let settled = false;
    void ownership.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    finish.resolve(snapshot("submitted", 1, [{ from: 1, to: 1 }], 1));
    await ownership;
  });
  it("waits for native cancellation itself before reporting cancellation", async () => {
    const abort = new AbortController();
    const cancel = deferred<PdfPrintSnapshot>();
    const poll = deferred<PdfPrintSnapshot>();
    const source = fakeDocument(1);
    const consumer = fakeNative(1);
    vi.mocked(consumer.native.poll).mockReturnValueOnce(poll.promise);
    vi.mocked(consumer.native.cancel).mockReturnValue(cancel.promise);
    let settled = false;

    const operation = printPdfDocument(baseOptions(source.document, consumer.native, 1, { signal: abort.signal }));
    void operation.then(() => { settled = true; });
    await vi.waitFor(() => expect(consumer.native.poll).toHaveBeenCalledOnce());
    abort.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    cancel.resolve(snapshot("cancelled", 1));

    await expect(operation).resolves.toEqual({ kind: "cancelled", preparedPages: 0 });
    poll.resolve(snapshot("dialog", 1));
  });

  it("times out and cancels a PDF.js render but retains memory until raw settlement", async () => {
    const render = deferred<void>();
    const cancelRender = vi.fn();
    const resources = new ResourceReservationManager();
    const source = fakeDocument(1, { 1: { render: () => ({ promise: render.promise, cancel: cancelRender }) } });
    const consumer = fakeNative(1);
    let ownership!: Promise<void>;

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 1, {
      resources,
      stageTimeoutMs: 1,
      onOwnershipSettlement: (settlement) => { ownership = settlement; },
    }));
    expect(outcome).toEqual({ kind: "failed", reason: "PRINT_RENDER_TIMEOUT", preparedPages: 0 });
    expect(cancelRender).toHaveBeenCalled();
    expect(resources.snapshot().totals["canvas-bytes"]).toBeGreaterThan(0);

    render.reject(Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" }));
    await ownership;
    resources.assertEmpty();
  });
  it("keeps timed-out metadata ownership until the raw page load settles", async () => {
    const load = deferred<void>();
    const source = fakeDocument(1, { 1: { load: () => load.promise } });
    const consumer = fakeNative(1);
    let ownership!: Promise<void>;

    const outcome = await printPdfDocument(baseOptions(source.document, consumer.native, 1, {
      stageTimeoutMs: 1,
      onOwnershipSettlement: (settlement) => { ownership = settlement; },
    }));
    expect(outcome).toEqual({ kind: "failed", reason: "PRINT_METADATA_TIMEOUT", preparedPages: 0 });
    let settled = false;
    void ownership.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    load.resolve();
    await ownership;
  });
});

describe("TauriPdfPrintBoundary", () => {
  it("uses only owner/session control args and binary submit headers", async () => {
    const pageCount = 2;
    const dialog = snapshot("dialog", pageCount);
    const ready = snapshot("ready", pageCount, [{ from: 1, to: 2 }]);
    const printing = snapshot("printing", pageCount, [{ from: 1, to: 2 }], 1);
    const submitted = snapshot("submitted", pageCount, [{ from: 1, to: 2 }], 2);
    const cancelled = snapshot("cancelled", pageCount, [{ from: 1, to: 2 }], 1);
    vi.mocked(invoke).mockImplementation(async <T>(command: string): Promise<T> => {
      if (command === "start_pdf_print") return dialog as T;
      if (command === "poll_pdf_print") return ready as T;
      if (command === "submit_pdf_print_page") return printing as T;
      if (command === "finish_pdf_print") return submitted as T;
      if (command === "cancel_pdf_print") return cancelled as T;
      return undefined as T;
    });
    const boundary = new TauriPdfPrintBoundary({ sessionId: "opaque-session", documentGeneration: 7 }, 11);
    const payload = new Uint8Array([1, 2, 3]);

    await boundary.start({ pageCount, currentPage: 2, title: "fixture.pdf" });
    await boundary.poll(JOB_ID);
    await boundary.submit(JOB_ID, payload);
    await boundary.finish(JOB_ID);
    await boundary.cancel(JOB_ID);
    await boundary.release(JOB_ID);

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["start_pdf_print", {
        ownerGeneration: 11,
        sessionId: "opaque-session",
        documentGeneration: 7,
        pageCount: 2,
        currentPage: 2,
        title: "fixture.pdf",
      }],
      ["poll_pdf_print", { ownerGeneration: 11, jobId: JOB_ID }],
      ["submit_pdf_print_page", payload, { headers: {
        "x-print-job": JOB_ID,
        "x-print-owner-generation": "11",
      } }],
      ["finish_pdf_print", { ownerGeneration: 11, jobId: JOB_ID }],
      ["cancel_pdf_print", { ownerGeneration: 11, jobId: JOB_ID }],
      ["release_pdf_print", { ownerGeneration: 11, jobId: JOB_ID }],
    ]);
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toMatch(/path|printer|hwnd/iu);
  });
});
