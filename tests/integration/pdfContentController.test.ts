/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";

const textLayerSources = vi.hoisted(() => [] as { textContentSource: { items: readonly { str?: string; hasEOL?: boolean; fontName?: string }[]; styles?: Readonly<Record<string, unknown>>; lang?: string } }[]);
vi.mock("pdfjs-dist", () => ({
  TextLayer: class {
    public constructor(private readonly options: { textContentSource: { items: readonly { str?: string; hasEOL?: boolean; fontName?: string }[]; styles?: Readonly<Record<string, unknown>>; lang?: string }; container: HTMLElement }) {
      textLayerSources.push(options);
    }
    public async render(): Promise<void> {
      this.options.textContentSource.items.forEach((item) => {
        if (item.str === undefined) return;
        const span = document.createElement("span");
        span.textContent = item.str;
        this.options.container.append(span);
        if (item.hasEOL) this.options.container.append(document.createElement("br"));
      });
    }
  },
}));

import { addPdfTextUtf8Bytes, normalizePdfSearchQuery, PdfContentController, type PdfContentAnnotation, type PdfContentDocument, type PdfContentPage } from "../../src/pdf/PdfContentController";
import { RESOURCE_LIMITS, ResourceReservationManager } from "../../src/pdf/ResourceBudget";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
const page = (text: string, annotations: readonly PdfContentAnnotation[] = []): PdfContentPage => ({
  getTextContent: async () => ({ items: [{ str: text }] }),
  streamTextContent: () => new ReadableStream({
    start(controller) {
      controller.enqueue({ items: [{ str: text }] });
      controller.close();
    },
  }),
  getAnnotations: async () => annotations,
});
const streamText = (
  load: () => Promise<{ readonly items: readonly { readonly str?: string; readonly hasEOL?: boolean }[] }>,
): ReadableStream<{ readonly items: readonly { readonly str?: string; readonly hasEOL?: boolean }[] }> => {
  let cancelled = false;
  return new ReadableStream({
    start(controller) {
      void load().then((content) => {
        if (cancelled) return;
        controller.enqueue(content);
        controller.close();
      }, (error) => {
        if (!cancelled) controller.error(error);
      });
    },
    cancel() {
      cancelled = true;
    },
  });
};

const setup = (pages: PdfContentPage[]) => {
  const host = document.createElement("div");
  const canvas = document.createElement("canvas");
  host.append(canvas);
  const statuses: string[] = [];
  const navigateToPage = vi.fn();
  const openExternal = vi.fn((): Promise<void> => Promise.resolve());
  const prepareExternalLinks = vi.fn(async () => undefined);
  const commitExternalLinks = vi.fn(async () => undefined);
  const finalizeExternalLinks = vi.fn(async () => undefined);
  const abortExternalLinks = vi.fn(async () => undefined);
  const resources = new ResourceReservationManager();
  const controller = new PdfContentController({
    host,
    resources,
    onStatus: (message) => statuses.push(message),
    navigateToPage,
    navigateToDestination: (pageNumber) => navigateToPage(pageNumber),
    prepareExternalLinks,
    commitExternalLinks,
    finalizeExternalLinks,
    abortExternalLinks,
    openExternal,
  });
  const pdf: PdfContentDocument = { numPages: pages.length, getPage: async (number) => pages[number - 1]! };
  controller.mount(pdf, 1, "session-1");
  return {
    canvas,
    controller,
    host,
    statuses,
    navigateToPage,
    prepareExternalLinks,
    commitExternalLinks,
    finalizeExternalLinks,
    abortExternalLinks,
    openExternal,
    pdf,
    resources,
  };
};

const viewport = {
  width: 100,
  height: 100,
  scale: 1.25,
  rotation: 0,
  rawDims: { pageWidth: 80, pageHeight: 80 },
  convertToViewportPoint: (x: number, y: number) => [x, y] as const,
  convertToPdfPoint: (x: number, y: number) => [x, y] as const,
};

describe("PdfContentController", () => {
  it("searches Korean literal text with trimmed case-insensitive cycling and highlights the rendered page", async () => {
    const subject = setup([page("첫 한국어 MATCH"), page("한국어 match")]);
    const originalGetClientRects = Range.prototype.getClientRects;
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [new DOMRect(0, 0, 10, 10)],
    });
    try {
      await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
      await subject.controller.search("  한국어 match ");

      expect(subject.controller.snapshot.results).toHaveLength(2);
      expect(subject.host.querySelector("[data-search-fallback][data-search-current=\"true\"]")).not.toBeNull();
      expect(subject.controller.nextMatch()).toEqual({ pageNumber: 2, index: 0, length: 9 });
      expect(subject.navigateToPage).toHaveBeenCalledWith(2);
      expect(subject.controller.nextMatch(true)?.pageNumber).toBe(1);
    } finally {
      Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: originalGetClientRects });
    }
  });
  it("uses exact custom highlight ranges and scrolls the current hit without rewriting text", async () => {
    const subject = setup([page("prefix match suffix")]);
    const highlights = new Map<string, unknown>();
    const captured: Range[][] = [];
    class TestHighlight {
      public constructor(...ranges: Range[]) { captured.push(ranges); }
    }
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    vi.stubGlobal("CSS", { highlights });
    vi.stubGlobal("Highlight", TestHighlight);
    try {
      await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
      await subject.controller.search("match");
      expect(captured.at(-1)?.[0]?.toString()).toBe("match");
      expect(highlights.has("modeleaf-pdf-search-hits")).toBe(true);
      expect(highlights.has("modeleaf-pdf-search-current")).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
      expect(subject.host.querySelector(".textLayer")?.textContent).toBe("prefix match suffix");
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
    }
  });
  it("uses exact fallback rectangles for substring and multi-span matches without Custom Highlights", async () => {
    const multiSpan: PdfContentPage = {
      getTextContent: async () => ({ items: [{ str: "pre" }, { str: "fix" }, { str: "match" }, { str: "tail" }] }),
      streamTextContent: () => streamText(async () => ({ items: [{ str: "pre" }, { str: "fix" }, { str: "match" }, { str: "tail" }] })),
      getAnnotations: async () => [],
    };
    const subject = setup([multiSpan]);
    const originalGetClientRects = Range.prototype.getClientRects;
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: vi.fn(() => [new DOMRect(11, 22, 3, 4), new DOMRect(21, 22, 5, 4), new DOMRect(31, 22, 7, 4)]),
    });
    try {
      await subject.controller.renderPage({ pageNumber: 1, page: multiSpan, viewport, canvas: subject.canvas });
      const layer = subject.host.querySelector<HTMLElement>(".pdf-content-layer")!;
      vi.spyOn(layer, "getBoundingClientRect").mockReturnValue(new DOMRect(1, 2, 100, 100));
      await subject.controller.search("refixmatch");
      const rectangles = [...subject.host.querySelectorAll<HTMLElement>("[data-search-fallback]")];
      expect(rectangles).toHaveLength(3);
      expect(rectangles.map((rectangle) => [rectangle.style.left, rectangle.style.top, rectangle.style.width, rectangle.style.height])).toEqual([["10px", "20px", "3px", "4px"], ["20px", "20px", "5px", "4px"], ["30px", "20px", "7px", "4px"]]);
      expect(subject.host.querySelector(".pdf-search-hit")).toBeNull();
      expect(subject.host.querySelector(".textLayer")?.textContent).toBe("prefixmatchtail");
      subject.controller.invalidateSearch();
      expect(subject.host.querySelectorAll(".pdf-search-hit, [data-search-fallback]")).toHaveLength(0);
    } finally {
      Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: originalGetClientRects });
    }
  });
  it("uses a constant number of text-node walks for many results", async () => {
    const subject = setup([page("x ".repeat(2_000))]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    const createTreeWalker = vi.spyOn(document, "createTreeWalker");
    const treeWalkerCallsBeforeSearch = createTreeWalker.mock.calls.length;
    await subject.controller.search("x");
    const treeWalkerCallsForSearch = createTreeWalker.mock.calls.length - treeWalkerCallsBeforeSearch;
    expect(subject.controller.snapshot.results).toHaveLength(2_000);
    expect(treeWalkerCallsForSearch).toBeGreaterThan(0);
    expect(treeWalkerCallsForSearch).toBeLessThanOrEqual(3);
    createTreeWalker.mockRestore();
  });

  it("discloses PDFs without searchable text and drops stale generation renders", async () => {
    const delayed = (() => {
      let resolve!: (value: { items: readonly { str: string }[] }) => void;
      const promise = new Promise<{ items: readonly { str: string }[] }>((done) => { resolve = done; });
      return { promise, resolve };
    })();
    const stale: PdfContentPage = { getTextContent: () => delayed.promise, getAnnotations: async () => [] };
    const subject = setup([stale]);
    const rendering = subject.controller.renderPage({ pageNumber: 1, page: stale, viewport, canvas: subject.canvas });
    subject.controller.mount({ numPages: 1, getPage: async () => page("") }, 2, "session-2");
    delayed.resolve({ items: [{ str: "stale" }] });
    await rendering;
    await subject.controller.search("missing");

    expect(subject.host.querySelector(".pdf-content-layer")).toBeNull();
    expect(subject.statuses.at(-1)).toMatch(/no searchable text.*OCR is unavailable/i);
  });
  it("cancels stale in-flight searches when a new document mounts", async () => {
    let resolveText!: (value: { items: readonly { str: string }[] }) => void;
    const text = new Promise<{ items: readonly { str: string }[] }>((resolve) => { resolveText = resolve; });
    const delayedPage: PdfContentPage = {
      getTextContent: () => text,
      streamTextContent: () => streamText(() => text),
      getAnnotations: async () => [],
    };
    const subject = setup([delayedPage]);
    const searching = subject.controller.search("stale");
    subject.controller.mount({ numPages: 1, getPage: async (_pageNumber: number) => page("fresh") }, 2, "session-2");
    resolveText({ items: [{ str: "stale" }] });
    await searching;

    expect(subject.controller.snapshot).toMatchObject({ query: "", results: [] });
    expect(subject.navigateToPage).not.toHaveBeenCalled();
  });

  it("keeps a new mount when prior asynchronous teardown settles", async () => {
    let resolveA!: (value: PdfContentPage) => void;
    const pendingA = new Promise<PdfContentPage>((resolve) => { resolveA = resolve; });
    const subject = setup([page("unused")]);
    subject.pdf.getPage = async () => pendingA;
    const searchingA = subject.controller.search("stale");
    let priorUnmount: Promise<void> | undefined;
    const unmount = subject.controller.unmount.bind(subject.controller);
    vi.spyOn(subject.controller, "unmount").mockImplementation(() => {
      priorUnmount = unmount();
      return priorUnmount!;
    });
    const fresh = page("fresh");
    const documentB: PdfContentDocument = { numPages: 1, getPage: async () => fresh };

    subject.controller.mount(documentB, 2, "session-2");
    await subject.controller.renderPage({ pageNumber: 1, page: fresh, viewport, canvas: subject.canvas });
    resolveA(page("stale"));
    await searchingA;
    await priorUnmount!;
    await subject.controller.search("fresh");

    expect(subject.host.querySelector(".textLayer")?.textContent).toBe("fresh");
    expect(subject.controller.snapshot).toMatchObject({
      pageNumber: 1,
      generation: 2,
      query: "fresh",
      results: [{ pageNumber: 1, index: 0, length: 5 }],
    });
  });
  it("enforces UTF-8 page and document text bounds and result bounds", async () => {
    const lateMatch = setup([
      ...Array.from({ length: 500 }, () => page("miss")),
      page("late hit"),
    ]);
    await lateMatch.controller.search("hit");
    expect(lateMatch.controller.snapshot.results).toEqual([{ pageNumber: 501, index: 5, length: 3 }]);

    const oversized = setup([page("x".repeat(RESOURCE_LIMITS.maxTextPageBytes + 1))]);
    await oversized.controller.search("x");
    expect(oversized.controller.snapshot.results).toHaveLength(0);
    expect(oversized.statuses.at(-1)).toBe("TEXT_LIMIT");

    const resultLimited = setup([page("x".repeat(10_001))]);
    await resultLimited.controller.search("x");
    expect(resultLimited.controller.snapshot.results).toHaveLength(10_000);
    expect(resultLimited.statuses.at(-1)).toMatch(/Match 1 of 10000.*partial/);
    expect(resultLimited.statuses.at(-1)).toMatch(/partial.*result limit/i);
  });
  it("streams bounded extraction, cancels the reader, respects EOL boundaries, and maps expanding folds", async () => {
    let cancelled = 0;
    const streamPage: PdfContentPage = {
      getTextContent: async () => { throw new Error("materialized extraction must not run"); },
      streamTextContent: () => new ReadableStream({
        start(controller) {
          controller.enqueue({ items: [{ str: "x".repeat(RESOURCE_LIMITS.maxTextPageBytes), hasEOL: true }] });
        },
        cancel() {
          cancelled += 1;
        },
      }),
      getAnnotations: async () => [],
    };
    const streamed = setup([streamPage]);
    await streamed.controller.search("x");
    expect(streamed.controller.snapshot.results).toHaveLength(0);
    expect(streamed.statuses.at(-1)).toBe("TEXT_LIMIT");
    expect(cancelled).toBe(1);

    const folded = setup([{
      getTextContent: async () => ({
        items: [{ str: "ab", hasEOL: true }, { str: "cd İX" }],
      }),
      streamTextContent: () => streamText(async () => ({
        items: [{ str: "ab", hasEOL: true }, { str: "cd İX" }],
      })),
      getAnnotations: async () => [],
    }]);
    await folded.controller.search("bc");
    expect(folded.controller.snapshot.results).toHaveLength(0);
    await folded.controller.search("i̇x");
    expect(folded.controller.snapshot.results).toEqual([{ pageNumber: 1, index: 6, length: 2 }]);
  });
  it("uses prefix-free deterministic labels beyond one alphabet width", async () => {
    const links = Array.from({ length: 27 }, (_, index): PdfContentAnnotation => ({
      subtype: "Link",
      rect: [index, index, index + 1, index + 1],
      url: `https://example.test/${index}`,
    }));
    const subject = setup([page("x", links)]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    subject.controller.toggleHints();

    expect(subject.host.querySelector(".pdf-content-layer")?.classList.contains("pdf-link-hints-active")).toBe(true);
    const labels = [...subject.host.querySelectorAll("[data-hint-label]")].map((node) => node.textContent);
    expect(labels).toHaveLength(27);
    expect(labels.every((label) => label?.length === 2)).toBe(true);
    expect(subject.controller.handleHintKey(labels[0]![0]!)).toBe(true);
    expect(subject.openExternal).not.toHaveBeenCalled();
    expect(subject.controller.handleHintKey(labels[0]![1]!)).toBe(true);
    expect(subject.host.querySelector(".pdf-content-layer")?.classList.contains("pdf-link-hints-active")).toBe(false);
    expect(subject.openExternal).toHaveBeenCalledWith("page-1-render-2-annotation-0", 1, expect.any(String), expect.any(Number));
  });
  it("keeps PDF links mouse-clickable and applies valid annotation appearance", async () => {
    const subject = setup([page("link", [{
      subtype: "Link",
      rect: [10, 10, 40, 24],
      url: "https://example.test/mouse",
      color: new Uint8ClampedArray([0, 90, 255]),
      borderStyle: { width: 3, style: 2 },
    }])]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });

    const overlay = subject.host.querySelector<HTMLButtonElement>(".pdf-link-overlay")!;
    expect(overlay.type).toBe("button");
    expect(overlay.style.pointerEvents).toBe("auto");
    expect(overlay.style.getPropertyValue("--pdf-link-color")).toBe("rgb(0 90 255)");
    expect(overlay.style.borderWidth).toBe("3px");
    expect(overlay.style.borderStyle).toBe("dashed");

    overlay.click();
    await Promise.resolve();
    expect(subject.openExternal).toHaveBeenCalledWith("page-1-render-2-annotation-0", 1, expect.any(String), expect.any(Number));
  });
  it("swallows rejected overlay work after its document generation becomes stale", async () => {
    let rejectText!: (error: Error) => void;
    const text = new Promise<{ items: readonly { str: string }[] }>((_resolve, reject) => { rejectText = reject; });
    const stale: PdfContentPage = {
      getTextContent: () => text,
      getAnnotations: async () => [],
    };
    const subject = setup([stale]);
    const rendering = subject.controller.renderPage({ pageNumber: 1, page: stale, viewport, canvas: subject.canvas });
    subject.controller.mount({ numPages: 1, getPage: async (_pageNumber: number) => page("fresh") }, 2, "session-2");
    rejectText(new Error("stale failure"));

    await expect(rendering).resolves.toBeUndefined();
    expect(subject.host.querySelector(".pdf-content-layer")).toBeNull();
  });

  it("passes merged production TextContent styles, lang, and fontName to TextLayer", async () => {
    const streamed: PdfContentPage = {
      getTextContent: async () => ({ items: [] }),
      streamTextContent: () => new ReadableStream({
        start(controller) {
          controller.enqueue({
            lang: "ko",
            styles: { first: { fontFamily: "First" } },
            items: [{ str: "첫", fontName: "first", transform: [1, 0, 0, 1, 0, 0] }],
          });
          controller.enqueue({
            styles: { second: { fontFamily: "Second" } },
            items: [{ str: "글", fontName: "second" }],
          });
          controller.close();
        },
      }),
      getAnnotations: async () => [],
    };
    const subject = setup([streamed]);
    await subject.controller.renderPage({ pageNumber: 1, page: streamed, viewport, canvas: subject.canvas });

    const source = textLayerSources.at(-1)?.textContentSource;
    expect(source).toMatchObject({ lang: "ko", styles: { first: { fontFamily: "First" }, second: { fontFamily: "Second" } } });
    expect(source?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ str: "첫", fontName: "first", transform: [1, 0, 0, 1, 0, 0] }),
      expect.objectContaining({ str: "글", fontName: "second" }),
    ]));
  });
  it("creates pointer-selectable TextLayer spans and one deterministic hint per exact link identity", async () => {
    const links: PdfContentAnnotation[] = [
      { subtype: "Link", rect: [10, 10, 30, 20], url: "https://example.test" },
      { subtype: "Link", rect: [10, 20, 30, 30], url: "https://example.test" },
      { subtype: "Link", rect: [40, 10, 60, 20], url: "mailto:test@example.test" },
    ];
    const subject = setup([page("select me", links)]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    subject.controller.toggleHints();

    expect(subject.host.querySelector(".textLayer span")?.textContent).toBe("select me");
    expect(subject.host.querySelector<HTMLElement>(".textLayer")?.style.userSelect).toBe("text");
    expect(subject.host.querySelector<HTMLElement>(".textLayer")?.style.getPropertyValue("--total-scale-factor")).toBe("1.25");
    expect(subject.host.querySelectorAll(".pdf-link-overlay")).toHaveLength(3);
    expect([...subject.host.querySelectorAll("[data-hint-label]")].map((node) => node.textContent)).toEqual(["A", "S", "D"]);
    subject.controller.handleHintKey("a");
    expect(subject.openExternal).toHaveBeenCalledWith("page-1-render-2-annotation-0", 1, expect.any(String), expect.any(Number));
    expect(subject.controller.snapshot.hintsVisible).toBe(false);
  });

  it("keeps both published content layers within the rotated canvas CSS viewport", async () => {
    const subject = setup([page("select me")]);
    const rotatedViewport = { ...viewport, width: 200, height: 100, scale: 2, rotation: 90, rawDims: { pageWidth: 50, pageHeight: 100 } };
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport: rotatedViewport, canvas: subject.canvas });

    const content = subject.host.querySelector<HTMLElement>(".pdf-content-layer")!;
    const text = content.querySelector<HTMLElement>(":scope > .textLayer")!;
    const annotations = content.querySelector<HTMLElement>(":scope > .annotationLayer")!;
    expect(content.style).toMatchObject({ width: "200px", height: "100px" });
    expect(text.style).toMatchObject({ width: "200px", height: "100px" });
    expect(annotations.style.inset).toBe("0");
  });
  it("uses only injected safe external opening, navigates internal destinations, and rejects actions", async () => {
    const annotations: PdfContentAnnotation[] = [
      { subtype: "Link", rect: [1, 1, 2, 2], url: "javascript:alert(1)" },
      { subtype: "Link", rect: [3, 1, 4, 2], dest: [1, { name: "Fit" }] },
      { subtype: "Link", rect: [5, 1, 6, 2], action: "Launch" },
      { subtype: "Link", rect: [7, 1, 8, 2], dest: [0.5, { name: "Fit" }] },
      { subtype: "Link", rect: [9, 1, 10, 2], dest: "broken" },
    ];
    const subject = setup([page("x", annotations), page("y")]);
    Object.assign(subject.pdf, {
      getDestination: async () => { throw new Error("malformed destination"); },
    });
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    const targets = subject.host.querySelectorAll<HTMLButtonElement>(".pdf-link-overlay");
    targets[1]?.click();
    await vi.waitFor(() => expect(subject.navigateToPage).toHaveBeenCalledWith(2));
    [...targets].filter((_target, index) => index !== 1).forEach((target) => target.click());
    await vi.waitFor(() => {
      expect(subject.statuses.filter((message) => /unsupported/i.test(message))).toHaveLength(3);
    });

    expect(subject.openExternal).not.toHaveBeenCalled();
    expect(subject.navigateToPage).toHaveBeenCalledWith(2);
    expect(subject.statuses.filter((message) => /unsupported/i.test(message))).toHaveLength(3);
  });
  it("reports a valid internal destination whose page resolution stalls as timed out", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let resolveIndex!: (value: number) => void;
      const subject = setup([page("x", [{ subtype: "Link", rect: [1, 1, 2, 2], dest: [{ reference: "page-1" }, { name: "Fit" }] }])]);
      Object.assign(subject.pdf, {
        getPageIndex: vi.fn(() => ++calls === 1 ? Promise.resolve(0) : new Promise<number>((resolve) => { resolveIndex = resolve; })),
      });
      await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
      subject.host.querySelector<HTMLButtonElement>(".pdf-link-overlay")?.click();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(subject.statuses).toContain("PDF link destination resolution timed out.");
      expect(subject.statuses).not.toContain("Unsupported PDF link destination.");
      resolveIndex(0);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
  it("refuses successor internal activations until the active raw destination settles", async () => {
    let resolveFirst!: (destination: readonly unknown[]) => void;
    const first = new Promise<readonly unknown[]>((resolve) => { resolveFirst = resolve; });
    const subject = setup([page("x", [
      { subtype: "Link", rect: [1, 1, 2, 2], dest: "first" },
      { subtype: "Link", rect: [1, 10, 2, 11], dest: "second" },
    ])]);
    let destinationCalls = 0;
    Object.assign(subject.pdf, {
      getDestination: vi.fn((name: string) => {
        destinationCalls += 1;
        if (destinationCalls <= 2) return Promise.resolve([0, { name: "Fit" }]);
        return name === "first" ? first : Promise.resolve([0, { name: "Fit" }]);
      }),
    });
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });

    const targets = subject.host.querySelectorAll<HTMLButtonElement>(".pdf-link-overlay");
    targets[0]?.click();
    await vi.waitFor(() => expect(destinationCalls).toBe(3));
    targets[1]?.click();
    await Promise.resolve();
    expect(destinationCalls).toBe(3);

    let unmounted = false;
    const teardown = subject.controller.unmount().then(() => { unmounted = true; });
    await Promise.resolve();
    expect(unmounted).toBe(false);
    resolveFirst([0, { name: "Fit" }]);
    await teardown;
    expect(unmounted).toBe(true);
  });
  it("retains the prior complete overlay across stale success and current failure", async () => {
    let resolveFirst!: (value: { items: readonly { str: string }[] }) => void;
    const firstText = new Promise<{ items: readonly { str: string }[] }>((resolve) => { resolveFirst = resolve; });
    let rejectSecond!: (error: Error) => void;
    const secondText = new Promise<{ items: readonly { str: string }[] }>((_resolve, reject) => { rejectSecond = reject; });
    const first: PdfContentPage = { getTextContent: () => firstText, getAnnotations: async () => [] };
    const second: PdfContentPage = { getTextContent: () => secondText, getAnnotations: async () => [] };
    const subject = setup([page("old", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test" }]), first, second]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    subject.controller.toggleHints();
    const staleRendering = subject.controller.renderPage({ pageNumber: 2, page: first, viewport, canvas: subject.canvas });
    const failingRendering = subject.controller.renderPage({ pageNumber: 3, page: second, viewport, canvas: subject.canvas });
    expect(subject.host.querySelector(".pdf-content-layer")?.textContent).toContain("old");
    expect(subject.controller.snapshot).toMatchObject({ pageNumber: 1, hintsVisible: true });
    resolveFirst({ items: [{ str: "stale" }] });
    await staleRendering;
    expect(subject.host.querySelector(".pdf-content-layer")?.textContent).toContain("old");
    rejectSecond(new Error("render failed"));
    await expect(failingRendering).rejects.toThrow("render failed");
    expect(subject.host.querySelector(".pdf-content-layer")?.textContent).toContain("old");
  });
  it("retains pending external activation settlement through teardown", async () => {
    let resolveOpen!: () => void;
    const subject = setup([page("x", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test" }])]);
    subject.openExternal.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveOpen = resolve; }));
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    subject.host.querySelector<HTMLButtonElement>(".pdf-link-overlay")?.click();
    await vi.waitFor(() => expect(subject.openExternal).toHaveBeenCalledOnce());
    let settled = false;
    const teardown = subject.controller.unmount().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveOpen();
    await teardown;
    expect(settled).toBe(true);
  });
  it("publishes the aggregate resident external-link registry after prior activation settles", async () => {
    let resolveOpen!: () => void;
    const subject = setup([
      page("old", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/old" }]),
      page("new", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/new" }]),
    ]);
    subject.openExternal.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveOpen = resolve; }));
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    subject.host.querySelector<HTMLButtonElement>(".pdf-link-overlay")?.click();
    await vi.waitFor(() => expect(subject.openExternal).toHaveBeenCalledOnce());
    const replacement = subject.controller.renderPage({ pageNumber: 2, page: await subject.pdf.getPage(2), viewport, canvas: subject.canvas });
    await Promise.resolve();
    expect(subject.prepareExternalLinks).toHaveBeenCalledTimes(1);
    resolveOpen();
    await replacement;
    expect(subject.prepareExternalLinks).toHaveBeenLastCalledWith([
      { annotationId: "page-1-render-2-annotation-0", target: "https://example.test/old" },
      { annotationId: "page-2-render-3-annotation-0", target: "https://example.test/new" },
    ], 2);
    subject.openExternal.mockClear();
    expect(subject.controller.activateResidentPage(1)).toBe(true);
    expect(subject.controller.snapshot.pageNumber).toBe(1);
    subject.controller.toggleHints();
    expect(subject.controller.handleHintKey("A")).toBe(true);
    expect(subject.openExternal).toHaveBeenCalledWith("page-1-render-2-annotation-0", 2, expect.any(String), expect.any(Number));
  });
  it("reconciles the native registry when a viewport transition only evicts residents", async () => {
    const subject = setup([
      page("old", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/old" }]),
      page("kept", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/kept" }]),
    ]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    await subject.controller.renderPage({ pageNumber: 2, page: await subject.pdf.getPage(2), viewport, canvas: subject.canvas });

    await subject.controller.synchronizeResidentPages([2]);
    expect(subject.prepareExternalLinks).toHaveBeenLastCalledWith([
      { annotationId: "page-2-render-3-annotation-0", target: "https://example.test/kept" },
    ], 3);
    subject.controller.toggleHints();
    expect(subject.controller.handleHintKey("A")).toBe(true);
    expect(subject.openExternal).toHaveBeenCalledWith("page-2-render-3-annotation-0", 3, expect.any(String), expect.any(Number));
    await subject.controller.unmount();
  });
  it("preserves local residents and their prior native revision when reconciliation fails", async () => {
    const subject = setup([
      page("kept", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/kept" }]),
    ]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    subject.prepareExternalLinks.mockRejectedValueOnce(new Error("registry unavailable"));

    await expect(subject.controller.synchronizeResidentPages([])).rejects.toThrow("registry unavailable");
    expect(subject.controller.activateResidentPage(1)).toBe(true);
    subject.openExternal.mockClear();
    subject.controller.toggleHints();
    expect(subject.controller.handleHintKey("A")).toBe(true);
    expect(subject.openExternal).toHaveBeenCalledWith("page-1-render-2-annotation-0", 1, expect.any(String), expect.any(Number));
    await subject.controller.unmount();
  });
  it("retains resident registry entries after a timed-out pre-prepare activation", async () => {
    vi.useFakeTimers();
    try {
      let resolveOpen!: () => void;
      const subject = setup([
        page("old", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/old" }]),
        page("new", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/new" }]),
      ]);
      await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
      subject.openExternal.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveOpen = resolve; }));
      subject.host.querySelector<HTMLButtonElement>(".pdf-link-overlay")?.click();
      await vi.advanceTimersByTimeAsync(0);
      const timedOut = subject.controller.renderPage({ pageNumber: 2, page: await subject.pdf.getPage(2), viewport, canvas: subject.canvas });
      const failure = expect(timedOut).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(30_001);
      await failure;
      expect(subject.prepareExternalLinks).toHaveBeenCalledTimes(1);
      expect(subject.abortExternalLinks).not.toHaveBeenCalledWith(2);
      resolveOpen();
      await Promise.resolve();
      await expect(subject.controller.renderPage({ pageNumber: 2, page: await subject.pdf.getPage(2), viewport, canvas: subject.canvas })).resolves.toBeUndefined();
      expect(subject.prepareExternalLinks).toHaveBeenLastCalledWith([
        { annotationId: "page-1-render-2-annotation-0", target: "https://example.test/old" },
        { annotationId: "page-2-render-4-annotation-0", target: "https://example.test/new" },
      ], 3);
    } finally {
      vi.useRealTimers();
    }
  });
  it("releases a staged-before-close registry without quarantining a revision that never prepared", async () => {
    let resolveOpen!: () => void;
    const subject = setup([
      page("old", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/old" }]),
      page("new", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/new" }]),
    ]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    await vi.waitFor(() => expect(subject.finalizeExternalLinks).toHaveBeenCalledWith(1));
    subject.openExternal.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveOpen = resolve; }));
    subject.host.querySelector<HTMLButtonElement>(".pdf-link-overlay")?.click();
    await vi.waitFor(() => expect(subject.openExternal).toHaveBeenCalledOnce());
    const activationSettlement = [...(subject.controller as unknown as { linkActivationSettlements: Set<Promise<void>> }).linkActivationSettlements][0]!;
    const activationWait = vi.spyOn(activationSettlement, "then");

    const replacement = subject.controller.renderPage({ pageNumber: 2, page: await subject.pdf.getPage(2), viewport, canvas: subject.canvas });
    await vi.waitFor(() => expect(activationWait).toHaveBeenCalled());
    activationWait.mockRestore();
    expect(subject.prepareExternalLinks).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(RESOURCE_LIMITS.maxTextPageBytes * 2));

    const unmounting = subject.controller.unmount();
    resolveOpen();
    await expect(unmounting).resolves.toBeUndefined();
    await replacement;
    expect(subject.prepareExternalLinks).toHaveBeenCalledTimes(1);
    expect(subject.abortExternalLinks).not.toHaveBeenCalledWith(2);
    expect(subject.resources.snapshot().totals["text-page-bytes"] ?? 0).toBe(0);

    subject.controller.mount(subject.pdf, 2, "session-2");
    await expect(subject.controller.renderPage({ pageNumber: 2, page: await subject.pdf.getPage(2), viewport, canvas: subject.canvas })).resolves.toBeUndefined();
    expect(subject.prepareExternalLinks).toHaveBeenLastCalledWith([
      { annotationId: "page-2-render-6-annotation-0", target: "https://example.test/new" },
    ], 3);
    await subject.controller.unmount();
    expect(subject.resources.snapshot().totals["text-page-bytes"] ?? 0).toBe(0);
  });
  it("settles an old-overlay activation started during replacement preparation before finalization", async () => {
    let releasePreparation!: () => void;
    let resolveOpen!: () => void;
    const subject = setup([
      page("old", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/old" }]),
      page("new", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/new" }]),
    ]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    const oldLink = subject.host.querySelector<HTMLButtonElement>(".pdf-link-overlay");
    subject.prepareExternalLinks.mockImplementationOnce(() => new Promise<undefined>((resolve) => { releasePreparation = () => resolve(undefined); }));
    subject.openExternal.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveOpen = resolve; }));

    const replacement = subject.controller.renderPage({ pageNumber: 2, page: await subject.pdf.getPage(2), viewport, canvas: subject.canvas });
    await vi.waitFor(() => expect(subject.prepareExternalLinks).toHaveBeenCalledTimes(2));
    oldLink?.click();
    await vi.waitFor(() => expect(subject.openExternal).toHaveBeenCalledWith(
      "page-1-render-2-annotation-0", 1, expect.any(String), expect.any(Number),
    ));
    releasePreparation();
    await vi.waitFor(() => expect(subject.host.querySelector(".pdf-content-layer")?.textContent).toContain("new"));
    expect(subject.finalizeExternalLinks).not.toHaveBeenCalledWith(2);

    resolveOpen();
    await replacement;
    await vi.waitFor(() => expect(subject.finalizeExternalLinks).toHaveBeenCalledWith(2));
    expect(subject.statuses).not.toContain("STALE_REGISTRATION");
  });
  it("handles rejected external activation without an unhandled settlement", async () => {
    const subject = setup([page("x", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test" }])]);
    subject.openExternal.mockRejectedValueOnce(new Error("native admission failed"));
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    subject.host.querySelector<HTMLButtonElement>(".pdf-link-overlay")?.click();
    await vi.waitFor(() => expect(subject.statuses).toContain("PDF link could not be opened."));
  });
  it("reports an expired external dispatch as definitively not opened", async () => {
    const subject = setup([page("x", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test" }])]);
    subject.openExternal.mockRejectedValueOnce({ tag: "LINK_DISPATCH_EXPIRED" });
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    subject.host.querySelector<HTMLButtonElement>(".pdf-link-overlay")?.click();
    await vi.waitFor(() => expect(subject.statuses).toContain("PDF link was not opened because dispatch expired."));
    expect(subject.statuses).not.toContain("PDF link launch outcome is unknown; it may still open later.");
  });
  it("reports an external launch timeout as outcome-unknown", async () => {
    const subject = setup([page("x", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test" }])]);
    subject.openExternal.mockRejectedValueOnce({ tag: "LINK_LAUNCH_TIMEOUT" });
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    subject.host.querySelector<HTMLButtonElement>(".pdf-link-overlay")?.click();
    await vi.waitFor(() => expect(subject.statuses).toContain("PDF link launch outcome is unknown; it may still open later."));
    expect(subject.statuses).not.toContain("PDF link could not be opened.");
  });
  it("classifies the frontend activation deadline as outcome-unknown while retaining raw ownership", async () => {
    vi.useFakeTimers();
    try {
      let resolveOpen!: () => void;
      const subject = setup([page("x", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test" }])]);
      subject.openExternal.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveOpen = resolve; }));
      await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
      subject.host.querySelector<HTMLButtonElement>(".pdf-link-overlay")?.click();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(subject.statuses).toEqual(["PDF link launch outcome is unknown; it may still open later."]);

      let unmounted = false;
      const teardown = subject.controller.unmount().then(() => { unmounted = true; });
      await Promise.resolve();
      expect(unmounted).toBe(false);
      resolveOpen();
      await teardown;
    } finally {
      vi.useRealTimers();
    }
  });
  it("deduplicates only exact link identities and keeps adjacent links separate", async () => {
    const links: PdfContentAnnotation[] = [
      { subtype: "Link", rect: [10, 10, 30, 20], url: "https://example.test/a" },
      { subtype: "Link", rect: [10, 10, 30, 20], url: "https://example.test/a" },
      { subtype: "Link", rect: [10, 20, 30, 30], url: "https://example.test/a" },
      { subtype: "Link", rect: [10, 10, 30, 20], url: "https://example.test/b" },
    ];
    const subject = setup([page("x", links)]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    subject.controller.toggleHints();

    expect(subject.host.querySelectorAll("[data-hint-label]")).toHaveLength(3);
    expect(subject.host.querySelectorAll(".pdf-link-overlay")).toHaveLength(3);
    subject.controller.handleHintKey("A");
    expect(subject.openExternal).toHaveBeenCalledWith("page-1-render-2-annotation-0", 1, expect.any(String), expect.any(Number));
  });

  it("requires the viewport transform instead of using raw annotation rectangles", async () => {
    const convertToViewportPoint = vi.fn((x: number, y: number) =>
      x === 1 && y === 2 ? [40, 30] as const : [60, 50] as const);
    const subject = setup([page("x", [{ subtype: "Link", rect: [1, 2, 3, 4], url: "https://example.test" }])]);
    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport: {
        ...viewport,
        scale: 2,
        rawDims: { pageWidth: 50, pageHeight: 50 },
        convertToViewportPoint,
      },
      canvas: subject.canvas,
    });

    expect(convertToViewportPoint).toHaveBeenNthCalledWith(1, 1, 2);
    expect(convertToViewportPoint).toHaveBeenNthCalledWith(2, 3, 4);
    expect(subject.host.querySelector<HTMLElement>(".pdf-link-overlay")?.style.left).toBe("40px");
    expect(subject.host.querySelector<HTMLElement>(".textLayer")?.style.width).toBe("100px");
    expect(subject.host.querySelector<HTMLElement>(".textLayer")?.style.height).toBe("100px");
  });

  it("quarantines a pending overlay reservation while raw PDF work never settles", async () => {
    vi.useFakeTimers();
    try {
      const subject = setup([page("unused")]);
      const never = new Promise<never>(() => undefined);
      const blocked: PdfContentPage = {
        getTextContent: () => never,
        getAnnotations: () => never,
      };
      const rendering = subject.controller.renderPage({
        pageNumber: 1,
        page: blocked,
        viewport,
        canvas: subject.canvas,
      });
      await Promise.resolve();

      expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(RESOURCE_LIMITS.maxTextPageBytes);
      const teardown = subject.controller.unmount();
      const teardownOutcome = teardown.then(() => undefined, (error: unknown) => error);

      await vi.advanceTimersByTimeAsync(30_001);
      await expect(rendering).resolves.toBeUndefined();
      expect(await teardownOutcome).toMatchObject({ message: "PDF cleanup pending." });
      expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(RESOURCE_LIMITS.maxTextPageBytes);
    } finally {
      vi.useRealTimers();
    }
  });
  it("searches every page without a page-limit disclosure", async () => {
    const zeroHit = setup(Array.from({ length: 501 }, () => page("text")));
    await zeroHit.controller.search("missing");
    expect(zeroHit.statuses.at(-1)).toBe("No text matches found in this PDF.");

    const noText = setup(Array.from({ length: 501 }, () => page("")));
    await noText.controller.search("missing");
    expect(noText.statuses.at(-1)).toBe("This PDF has no searchable text. OCR is unavailable.");
  });

  it("retains search ownership until a timed-out raw page request settles", async () => {
    vi.useFakeTimers();
    try {
      let resolvePage!: (value: PdfContentPage) => void;
      const pendingPage = new Promise<PdfContentPage>((resolve) => { resolvePage = resolve; });
      const subject = setup([page("unused")]);
      subject.pdf.getPage = () => pendingPage;

      const searching = subject.controller.search("missing");
      await vi.advanceTimersByTimeAsync(30_001);
      await searching;

      expect(subject.statuses.at(-1)).toBe("Search cleanup failed: Search timed out.");
      expect(subject.resources.snapshot().totals["search-extractor"]).toBe(1);
      expect(subject.resources.snapshot().totals["text-document-bytes"]).toBe(RESOURCE_LIMITS.maxTextDocumentBytes);

      resolvePage(page("late"));
      await vi.waitFor(() => expect(subject.resources.snapshot().totals["search-extractor"]).toBe(0));
      expect(subject.resources.snapshot().totals["text-document-bytes"]).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("quarantines visible text until both a timed-out raw read and its cancellation settle", async () => {
    vi.useFakeTimers();
    try {
      let streams = 0;
      let cancellations = 0;
      let resolveCancellation: (() => void) | undefined;
      const blocked: PdfContentPage = {
        getTextContent: async () => ({ items: [] }),
        streamTextContent: () => {
          streams += 1;
          return new ReadableStream({
            cancel: () => {
              cancellations += 1;
              return new Promise<void>((resolve) => { resolveCancellation = resolve; });
            },
          });
        },
        getAnnotations: async () => [],
      };
      const subject = setup([blocked, page("successor")]);
      const first = subject.controller.renderPage({ pageNumber: 1, page: blocked, viewport, canvas: subject.canvas });
      const firstFailure = first.then(() => undefined, (error: unknown) => error);
      while (streams === 0) await Promise.resolve();

      await vi.advanceTimersByTimeAsync(30_001);
      expect(await firstFailure).toMatchObject({ message: "Search timed out." });
      expect(cancellations).toBe(1);
      expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(RESOURCE_LIMITS.maxTextPageBytes);

      let successorSettled = false;
      const successor = subject.controller.renderPage({
        pageNumber: 2,
        page: await subject.pdf.getPage(2),
        viewport,
        canvas: subject.canvas,
      }).then(() => { successorSettled = true; });
      await Promise.resolve();
      expect(successorSettled).toBe(false);
      expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(RESOURCE_LIMITS.maxTextPageBytes);

      let unmounted = false;
      const teardown = subject.controller.unmount().then(() => { unmounted = true; });
      await Promise.resolve();
      expect(unmounted).toBe(false);
      expect(resolveCancellation).toBeTypeOf("function");
      resolveCancellation!();
      await Promise.all([successor, teardown]);
      expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("retains search ownership until timed-out raw reads and cancellation settle", async () => {
    vi.useFakeTimers();
    try {
      let resolveRead!: (result: ReadableStreamReadResult<{ readonly items: readonly { readonly str?: string }[] }>) => void;
      let resolveCancellation!: () => void;
      const read = new Promise<ReadableStreamReadResult<{ readonly items: readonly { readonly str?: string }[] }>>((resolve) => { resolveRead = resolve; });
      const cancellation = new Promise<void>((resolve) => { resolveCancellation = resolve; });
      const releaseLock = vi.fn();
      const reader = {
        read: vi.fn(() => read),
        cancel: vi.fn(() => cancellation),
        releaseLock,
      };
      const blocked: PdfContentPage = {
        getTextContent: async () => ({ items: [] }),
        streamTextContent: () => ({ getReader: () => reader } as unknown as ReadableStream<{ readonly items: readonly { readonly str?: string }[] }>),
        getAnnotations: async () => [],
      };
      const subject = setup([blocked]);
      const searching = subject.controller.search("blocked");
      while (reader.read.mock.calls.length === 0) await Promise.resolve();

      await vi.advanceTimersByTimeAsync(30_001);
      await searching;

      expect(reader.cancel).toHaveBeenCalledTimes(1);
      expect(releaseLock).not.toHaveBeenCalled();
      expect(subject.resources.snapshot().totals["search-extractor"]).toBe(1);
      expect(subject.resources.snapshot().totals["text-document-bytes"]).toBe(RESOURCE_LIMITS.maxTextDocumentBytes);
      expect(subject.statuses.at(-1)).toMatch(/Search cleanup failed/i);

      resolveRead({ done: true, value: undefined });
      await Promise.resolve();
      expect(releaseLock).not.toHaveBeenCalled();
      resolveCancellation();
      await vi.waitFor(() => expect(subject.resources.snapshot().totals["search-extractor"]).toBe(0));
      expect(subject.resources.snapshot().totals["text-document-bytes"]).toBe(0);
      expect(releaseLock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("quarantines reservations after a never-settling stream cancellation", async () => {
    vi.useFakeTimers();
    try {
      let streams = 0;
      const blocked: PdfContentPage = {
        getTextContent: async () => ({ items: [] }),
        streamTextContent: () => {
          streams += 1;
          return new ReadableStream({
            cancel: () => new Promise<void>(() => undefined),
          });
        },
        getAnnotations: async () => [],
      };
      const subject = setup([blocked]);
      const first = subject.controller.search("blocked");
      while (streams === 0) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_002);
      await first;

      expect(subject.resources.snapshot().totals["search-extractor"]).toBe(1);
      expect(subject.resources.snapshot().totals["text-document-bytes"]).toBe(RESOURCE_LIMITS.maxTextDocumentBytes);
      expect(subject.statuses.at(-1)).toMatch(/Search cleanup failed/i);
    } finally {
      vi.useRealTimers();
    }
  });
  it("releases deferred ownership after a rejected stream cancellation so a successor search can proceed", async () => {
    vi.useFakeTimers();
    try {
      let pageRequests = 0;
      let streams = 0;
      const blocked: PdfContentPage = {
        getTextContent: async () => ({ items: [] }),
        streamTextContent: () => {
          streams += 1;
          return new ReadableStream({
            cancel: () => Promise.reject(new Error("cancel rejected")),
          });
        },
        getAnnotations: async () => [],
      };
      const subject = setup([blocked]);
      subject.pdf.getPage = async () => {
        pageRequests += 1;
        return blocked;
      };

      const first = subject.controller.search("blocked");
      while (streams === 0) await Promise.resolve();
      const successor = subject.controller.search("fresh");
      await vi.advanceTimersByTimeAsync(30_001);
      await Promise.all([first, successor]);

      expect(pageRequests).toBe(2);
      expect(subject.controller.snapshot.results).toHaveLength(0);
      expect(subject.statuses.at(-1)).toMatch(/Search cleanup (failed|timed out)/);
    } finally {
      vi.useRealTimers();
    }
  });
  it("fails closed without a cancellable search stream and releases capacity for a later search", async () => {
    let materializedCalls = 0;
    const subject = setup([{
      getTextContent: () => {
        materializedCalls += 1;
        return new Promise(() => undefined);
      },
      getAnnotations: async () => [],
    }]);

    await subject.controller.search("blocked");
    expect(materializedCalls).toBe(0);
    expect(subject.statuses.at(-1)).toBe("Search streaming is unavailable.");
    expect(subject.resources.snapshot().totals["search-extractor"]).toBe(0);
    expect(subject.resources.snapshot().totals["text-document-bytes"]).toBe(0);
    expect(subject.resources.snapshot().totals["text-process-bytes"]).toBe(0);

    subject.pdf.getPage = async () => page("fresh");
    await subject.controller.search("fresh");
    expect(subject.controller.snapshot.results).toEqual([{ pageNumber: 1, index: 0, length: 5 }]);
  });
  it("allows only the latest of three overlapping searches to publish", async () => {
    let resolveText!: (value: { items: readonly { str: string }[] }) => void;
    const text = new Promise<{ items: readonly { str: string }[] }>((resolve) => { resolveText = resolve; });
    let pageRequests = 0;
    const subject = setup([page("unused")]);
    subject.pdf.getPage = async () => {
      pageRequests += 1;
      return pageRequests === 1
        ? { getTextContent: () => text, streamTextContent: () => streamText(() => text), getAnnotations: async () => [] }
        : page("latest hit");
    };

    const first = subject.controller.search("blocked");
    await Promise.resolve();
    const second = subject.controller.search("middle");
    const third = subject.controller.search("latest");
    resolveText({ items: [{ str: "blocked" }] });
    await Promise.all([first, second, third]);

    expect(pageRequests).toBe(2);
    expect(subject.controller.snapshot.query).toBe("latest");
    expect(subject.controller.snapshot.results).toEqual([{ pageNumber: 1, index: 0, length: 6 }]);
  });
  it("allows only the latest of three overlapping renders to acquire the overlay", async () => {
    let resolveText!: (value: { items: readonly { str: string }[] }) => void;
    const text = new Promise<{ items: readonly { str: string }[] }>((resolve) => { resolveText = resolve; });
    const middleText = vi.fn(async () => ({ items: [{ str: "middle" }] }));
    const latestText = vi.fn(async () => ({ items: [{ str: "latest" }] }));
    const subject = setup([page("unused")]);

    const first = subject.controller.renderPage({
      pageNumber: 1,
      page: { getTextContent: () => text, getAnnotations: async () => [] },
      viewport,
      canvas: subject.canvas,
    });
    await Promise.resolve();
    const second = subject.controller.renderPage({
      pageNumber: 2,
      page: { getTextContent: middleText, getAnnotations: async () => [] },
      viewport,
      canvas: subject.canvas,
    });
    const third = subject.controller.renderPage({
      pageNumber: 3,
      page: { getTextContent: latestText, getAnnotations: async () => [] },
      viewport,
      canvas: subject.canvas,
    });
    resolveText({ items: [{ str: "stale" }] });
    await Promise.all([first, second, third]);

    expect(middleText).not.toHaveBeenCalled();
    expect(latestText).toHaveBeenCalledOnce();
    expect(subject.controller.snapshot.pageNumber).toBe(3);
    expect(subject.host.querySelector(".textLayer")?.textContent).toBe("latest");
  });
  it("holds overlay ownership until both parallel raw operations settle", async () => {
    let resolveAnnotations!: (value: readonly PdfContentAnnotation[]) => void;
    const annotations = new Promise<readonly PdfContentAnnotation[]>((resolve) => { resolveAnnotations = resolve; });
    const subject = setup([page("unused")]);
    const rendering = subject.controller.renderPage({
      pageNumber: 1,
      page: {
        getTextContent: async () => { throw new Error("text failed"); },
        getAnnotations: () => annotations,
      },
      viewport,
      canvas: subject.canvas,
    });
    await Promise.resolve();
    expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(RESOURCE_LIMITS.maxTextPageBytes);

    resolveAnnotations([]);
    await expect(rendering).rejects.toThrow("text failed");
    expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(0);
  });
  it("rejects annotation work above the shared native link cap", async () => {
    const annotations = Array.from({ length: 257 }, (_, index): PdfContentAnnotation => ({
      subtype: "Link",
      rect: [index, index, index + 1, index + 1],
      url: `https://example.test/${index}`,
    }));
    const subject = setup([page("x", annotations)]);

    await expect(subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport,
      canvas: subject.canvas,
    })).rejects.toThrow("LINK_CAPACITY");
    expect(subject.prepareExternalLinks).not.toHaveBeenCalled();
    expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(0);
  });
  it("ignores unrelated annotations when enforcing the link fan-out cap", async () => {
    const annotations = Array.from({ length: 257 }, (): PdfContentAnnotation => ({
      subtype: "Widget",
    }));
    const subject = setup([page("selectable", annotations)]);

    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport,
      canvas: subject.canvas,
    });

    expect(subject.host.querySelector(".textLayer")?.textContent).toContain("selectable");
    expect(subject.prepareExternalLinks).toHaveBeenCalledWith([], 1);
  });
  it("clears search state and rejects late publication without moving the rendered page", async () => {
    let resolvePage!: (value: PdfContentPage) => void;
    const pendingPage = new Promise<PdfContentPage>((resolve) => { resolvePage = resolve; });
    const subject = setup([page("old old")]);
    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport,
      canvas: subject.canvas,
    });
    await subject.controller.search("old");
    expect(subject.controller.snapshot.results).toHaveLength(2);
    subject.navigateToPage.mockClear();
    subject.pdf.getPage = () => pendingPage;

    const searching = subject.controller.search("new");
    subject.controller.invalidateSearch();
    resolvePage(page("new new"));
    await searching;

    expect(subject.controller.snapshot).toMatchObject({
      pageNumber: 1,
      query: "",
      results: [],
      currentResult: -1,
      searchPending: false,
    });
    expect(subject.host.querySelectorAll(".pdf-search-hit, [data-search-fallback]")).toHaveLength(0);
    expect(subject.navigateToPage).not.toHaveBeenCalled();
    expect(subject.host.querySelector(".pdf-content-layer")).not.toBeNull();
  });
  it("registers inspected external annotations before exposing their link targets", async () => {
    const subject = setup([page("x", [
      { subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test" },
      { subtype: "Link", rect: [2, 2, 3, 3], url: "javascript:alert(1)" },
    ])]);
    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport,
      canvas: subject.canvas,
    });

    expect(subject.prepareExternalLinks).toHaveBeenCalledWith([
      { annotationId: "page-1-render-2-annotation-0", target: "https://example.test" },
    ], 1);
  });
  it("filters targets rejected by the native validator without dropping safe page content", async () => {
    const oversized = `https://example.test/${"x".repeat(8_192)}`;
    const subject = setup([page("selectable", [
      { subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/safe" },
      { subtype: "Link", rect: [2, 2, 3, 3], url: "mailto:reader%40example.test" },
      { subtype: "Link", rect: [2, 2, 3, 3], url: "https://user@example.test/private" },
      { subtype: "Link", rect: [3, 3, 4, 4], url: "mailto:" },
      { subtype: "Link", rect: [4, 4, 5, 5], url: "mailto:a@example.test?subject=x%0aBcc:y@example.test" },
      { subtype: "Link", rect: [5, 5, 6, 6], url: oversized },
      { subtype: "Link", rect: [6, 6, 7, 7], url: "mailto:////?subject=x" },
      { subtype: "Link", rect: [7, 7, 8, 8], url: "mailto:reader" },
    ])]);

    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport,
      canvas: subject.canvas,
    });

    expect(subject.prepareExternalLinks).toHaveBeenCalledWith([
      { annotationId: "page-1-render-2-annotation-0", target: "https://example.test/safe" },
    ], 1);
    expect(subject.host.querySelector(".textLayer")?.textContent).toContain("selectable");
  });

  it("rejects excessively long external URLs before UTF-8 encoding", async () => {
    const oversized = `https://example.test/${"x".repeat(100_000)}`;
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      const subject = setup([page("x", [{ subtype: "Link", rect: [1, 1, 2, 2], url: oversized }])]);
      await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
      expect(encode).not.toHaveBeenCalledWith(oversized);
      expect(subject.prepareExternalLinks).toHaveBeenLastCalledWith([], 1);
      subject.host.querySelector<HTMLButtonElement>(".pdf-link-overlay")?.click();
      expect(subject.openExternal).not.toHaveBeenCalled();
      expect(subject.statuses).toContain("Unsupported PDF link destination.");
    } finally {
      encode.mockRestore();
    }
  });
  it("keeps a published revision active when finalization rejects", async () => {
    const subject = setup([page("old", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/old" }])]);
    subject.finalizeExternalLinks.mockRejectedValueOnce(new Error("finalize failed"));
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    await vi.waitFor(() => expect(subject.statuses.at(-1)).toBe("PDF link registry cleanup failed: finalize failed"));
    expect(subject.host.querySelector(".pdf-link-overlay")).not.toBeNull();
    expect(subject.abortExternalLinks).not.toHaveBeenCalledWith(1);
    await subject.controller.unmount();
    expect(subject.resources.snapshot().totals["text-page-bytes"] ?? 0).toBe(0);
  });
  it("retains mounted ownership when a published finalizer exceeds unmount deadline", async () => {
    vi.useFakeTimers();
    try {
      let resolveFinalize!: () => void;
      const subject = setup([page("old", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/old" }])]);
      subject.finalizeExternalLinks.mockImplementationOnce(() => new Promise<undefined>((resolve) => { resolveFinalize = () => resolve(undefined); }));
      await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
      await vi.waitFor(() => expect(subject.finalizeExternalLinks).toHaveBeenCalledWith(1));
      const firstUnmount = subject.controller.unmount();
      const firstOutcome = firstUnmount.then(() => undefined, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await firstOutcome).toMatchObject({ message: "PDF cleanup pending." });
      expect(subject.controller.snapshot.pageNumber).toBe(1);
      expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(RESOURCE_LIMITS.maxTextPageBytes);
      expect(subject.abortExternalLinks).not.toHaveBeenCalledWith(1);
      resolveFinalize();
      await Promise.resolve();
      await subject.controller.unmount();
      expect(subject.resources.snapshot().totals["text-page-bytes"] ?? 0).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("restores the committed external registry when a staged canvas cannot commit", async () => {
    const subject = setup([
      page("old", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/old" }]),
      page("new", [{ subtype: "Link", rect: [2, 2, 3, 3], url: "https://example.test/new" }]),
    ]);
    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport,
      canvas: subject.canvas,
    });
    const priorDom = [...subject.host.children];

    await subject.controller.renderPage({
      pageNumber: 2,
      page: await subject.pdf.getPage(2),
      viewport,
      canvas: document.createElement("canvas"),
      commitCanvas: () => false,
    });
    expect([...subject.host.children]).toEqual(priorDom);

    expect(subject.prepareExternalLinks.mock.calls.at(-1)).toEqual([[
      { annotationId: "page-1-render-2-annotation-0", target: "https://example.test/old" },
      { annotationId: "page-2-render-3-annotation-0", target: "https://example.test/new" },
    ], 2]);
    expect(subject.commitExternalLinks).toHaveBeenCalledWith(2);
    expect(subject.abortExternalLinks).toHaveBeenCalledWith(2);
    expect(subject.controller.snapshot.pageNumber).toBe(1);
    subject.controller.toggleHints();
    expect(subject.controller.handleHintKey("A")).toBe(true);
    expect(subject.openExternal).toHaveBeenCalledWith("page-1-render-2-annotation-0", 1, expect.any(String), expect.any(Number));
  });
  it("serializes out-of-order registry publication so stale rollback cannot replace a newer entry", async () => {
    const subject = setup([
      page("old", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/old" }]),
      page("staged", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/staged" }]),
      page("new", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/new" }]),
    ]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });

    let resolveStaged!: () => void;
    subject.prepareExternalLinks.mockImplementationOnce(() => new Promise<undefined>((resolve) => { resolveStaged = () => resolve(undefined); }));
    const staged = subject.controller.renderPage({
      pageNumber: 2,
      page: await subject.pdf.getPage(2),
      viewport,
      canvas: document.createElement("canvas"),
      commitCanvas: () => false,
    });
    await vi.waitFor(() => expect(subject.prepareExternalLinks.mock.calls).toHaveLength(2));
    const newer = subject.controller.renderPage({ pageNumber: 3, page: await subject.pdf.getPage(3), viewport, canvas: subject.canvas });
    resolveStaged();
    await Promise.all([staged, newer]);
    expect(subject.prepareExternalLinks.mock.calls.at(-1)).toEqual([[
      { annotationId: "page-1-render-2-annotation-0", target: "https://example.test/old" },
      { annotationId: "page-3-render-4-annotation-0", target: "https://example.test/new" },
    ], 3]);
    expect(subject.abortExternalLinks).toHaveBeenCalledWith(2);
  });
  it("durably rolls back a registry publication that completes after the render deadline", async () => {
    const subject = setup([
      page("old", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/old" }]),
      page("late", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/late" }]),
      page("new", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test/new" }]),
    ]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    vi.useFakeTimers();
    try {
      let resolveLate!: () => void;
      subject.prepareExternalLinks.mockImplementationOnce(() => new Promise<undefined>((resolve) => { resolveLate = () => resolve(undefined); }));
      const late = subject.controller.renderPage({ pageNumber: 2, page: await subject.pdf.getPage(2), viewport, canvas: document.createElement("canvas"), commitCanvas: () => true });
      await vi.advanceTimersByTimeAsync(0);
      expect(subject.prepareExternalLinks.mock.calls).toHaveLength(2);
      const lateFailure = expect(late).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(subject.abortExternalLinks).not.toHaveBeenCalledWith(2);
      expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(RESOURCE_LIMITS.maxTextPageBytes);
      resolveLate();
      await lateFailure;
      expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(RESOURCE_LIMITS.maxTextPageBytes);
      await expect(subject.controller.renderPage({ pageNumber: 3, page: await subject.pdf.getPage(3), viewport, canvas: subject.canvas })).resolves.toBeUndefined();
      const abortedRevisions = subject.abortExternalLinks.mock.calls as unknown as Array<[number]>;
      expect(abortedRevisions.filter(([revision]) => revision === 2)).toHaveLength(1);
      expect(subject.controller.snapshot.pageNumber).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it("measures extraction limits in UTF-8 bytes including Korean, astral text, and EOLs", () => {
    expect(addPdfTextUtf8Bytes(0, "한".repeat(699_050) + "aa")).toBe(RESOURCE_LIMITS.maxTextPageBytes);
    expect(addPdfTextUtf8Bytes(0, "한".repeat(699_050) + "aaa")).toBeUndefined();
    expect(addPdfTextUtf8Bytes(0, "😀".repeat(524_288))).toBe(RESOURCE_LIMITS.maxTextPageBytes);
    expect(addPdfTextUtf8Bytes(RESOURCE_LIMITS.maxTextPageBytes - 1, "\n")).toBe(RESOURCE_LIMITS.maxTextPageBytes);
    expect(addPdfTextUtf8Bytes(RESOURCE_LIMITS.maxTextDocumentBytes - 3, "한", RESOURCE_LIMITS.maxTextDocumentBytes)).toBe(RESOURCE_LIMITS.maxTextDocumentBytes);
    expect(addPdfTextUtf8Bytes(RESOURCE_LIMITS.maxTextDocumentBytes - 2, "한", RESOURCE_LIMITS.maxTextDocumentBytes)).toBeUndefined();
  });

  it("reserves one maximum text page per resident layer until explicit eviction or unmount", async () => {
    const subject = setup([page("first"), page("second")]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    await subject.controller.renderPage({ pageNumber: 2, page: await subject.pdf.getPage(2), viewport, canvas: subject.canvas });
    expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(RESOURCE_LIMITS.maxTextPageBytes * 2);

    expect(subject.controller.evictPage(1)).toBe(true);
    expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(RESOURCE_LIMITS.maxTextPageBytes);
    expect(subject.controller.evictPage(1)).toBe(false);
    await subject.controller.unmount();
    expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(0);
  });
  it("rejects visible text larger than the page budget without leaking its reservation", async () => {
    const oversized = "x".repeat(RESOURCE_LIMITS.maxTextPageBytes + 1);
    const subject = setup([page(oversized)]);

    await expect(subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport,
      canvas: subject.canvas,
    })).rejects.toThrow("TEXT_LIMIT");
    expect(subject.host.querySelector(".pdf-content-layer")).toBeNull();
    expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(0);
  });
  it("consumes Escape only while hints are visible", async () => {
    const subject = setup([page("x", [{ subtype: "Link", rect: [1, 1, 2, 2], url: "https://example.test" }])]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    expect(subject.controller.handleHintKey("Escape")).toBe(false);
    subject.controller.toggleHints();
    expect(subject.controller.handleHintKey("Escape")).toBe(true);
    expect(subject.controller.snapshot.hintsVisible).toBe(false);
  });
  it("binds destination intent to one render and preserves null axes", async () => {
    const subject = setup([page("one"), page("two")]);
    subject.host.scrollLeft = 7;
    subject.host.scrollTop = 9;
    const transformed = vi.fn((x: number, y: number) => [x * 3, y * 3] as const);
    const destinationViewport = {
      ...viewport,
      convertToViewportPoint: transformed,
      convertToPdfPoint: (x: number, y: number) => [x / 3, y / 3] as const,
    };

    subject.controller.queueDestination(1, [0, { name: "XYZ" }, null, 20, 2]);
    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport: destinationViewport,
      canvas: subject.canvas,
    });
    expect(subject.host.scrollLeft).toBe(7);
    expect(subject.host.scrollTop).toBe(60);

    subject.controller.queueDestination(2, [1, { name: "XYZ" }, 30, 40, null]);
    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport: destinationViewport,
      canvas: subject.canvas,
    });
    subject.host.scrollLeft = 11;
    subject.host.scrollTop = 12;
    await subject.controller.renderPage({
      pageNumber: 2,
      page: await subject.pdf.getPage(2),
      viewport: destinationViewport,
      canvas: subject.canvas,
    });
    expect(subject.host.scrollLeft).toBe(90);
    expect(subject.host.scrollTop).toBe(120);
  });
  it("maps partial destinations through the inverse viewport under rotation", async () => {
    const subject = setup([page("one")]);
    const convertToPdfPoint = vi.fn(() => [70, 80] as const);
    const convertToViewportPoint = vi.fn((x: number, y: number) => [y, x] as const);
    const rotatedViewport = { ...viewport, convertToPdfPoint, convertToViewportPoint };
    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport: rotatedViewport,
      canvas: subject.canvas,
    });
    subject.host.scrollLeft = 17;
    subject.host.scrollTop = 29;
    convertToPdfPoint.mockClear();
    convertToViewportPoint.mockClear();
    subject.controller.queueDestination(1, [0, { name: "XYZ" }, null, 20, null]);

    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport: rotatedViewport,
      canvas: subject.canvas,
    });

    expect(convertToPdfPoint).toHaveBeenCalledWith(17, 29);
    expect(convertToViewportPoint).toHaveBeenCalledWith(70, 20);
    expect(subject.host.scrollLeft).toBe(20);
    expect(subject.host.scrollTop).toBe(70);
  });
  it("uses the nested page-frame origin for destination preservation and landing", async () => {
    const subject = setup([page("one")]);
    const convertToPdfPoint = vi.fn((x: number, y: number) => [x, y] as const);
    const convertToViewportPoint = vi.fn((x: number, y: number) => [y, x] as const);
    const nestedViewport = { ...viewport, convertToPdfPoint, convertToViewportPoint };
    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport: nestedViewport,
      canvas: subject.canvas,
    });
    const frame = document.createElement("div");
    subject.host.replaceChildren(frame);
    frame.append(subject.canvas);
    Object.defineProperties(subject.canvas, {
      offsetLeft: { configurable: true, value: 10 },
      offsetTop: { configurable: true, value: 20 },
      offsetParent: { configurable: true, value: frame },
    });
    Object.defineProperties(frame, {
      offsetLeft: { configurable: true, value: 120 },
      offsetTop: { configurable: true, value: 300 },
      offsetParent: { configurable: true, value: subject.host },
    });
    subject.host.scrollLeft = 200;
    subject.host.scrollTop = 400;
    subject.controller.queueDestination(1, [0, { name: "XYZ" }, null, 20, null]);

    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport: nestedViewport,
      canvas: subject.canvas,
    });

    expect(convertToPdfPoint).toHaveBeenCalledWith(70, 80);
    expect(convertToViewportPoint).toHaveBeenCalledWith(70, 20);
    expect(subject.host.scrollLeft).toBe(150);
    expect(subject.host.scrollTop).toBe(390);
  });
  it("lands FitR on the viewport-space minimum corner under rotation", async () => {
    const subject = setup([page("one")]);
    const convertToViewportPoint = vi.fn((x: number, y: number) => [y, 100 - x] as const);
    const fitViewport = { ...viewport, convertToViewportPoint };
    subject.controller.queueDestination(1, [0, { name: "FitR" }, 10, 20, 40, 80]);

    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport: fitViewport,
      canvas: subject.canvas,
    });

    expect(convertToViewportPoint).toHaveBeenNthCalledWith(1, 10, 20);
    expect(convertToViewportPoint).toHaveBeenNthCalledWith(2, 40, 80);
    expect(subject.host.scrollLeft).toBe(20);
    expect(subject.host.scrollTop).toBe(60);
  });
  it("keeps complete destination identities exact for nearby points and fit operands", async () => {
    const subject = setup([page("x", [
      { subtype: "Link", rect: [1, 1, 2, 2], dest: [0, { name: "XYZ" }, 0, 0] },
      { subtype: "Link", rect: [1, 10, 2, 11], dest: [0, { name: "XYZ" }, 100, 100] },
      { subtype: "Link", rect: [1, 2, 2, 3], dest: [0, { name: "XYZ" }, 1, 1] },
      { subtype: "Link", rect: [1, 20, 2, 21], dest: [0, { name: "FitH" }, 10] },
      { subtype: "Link", rect: [1, 30, 2, 31], dest: [0, { name: "FitH" }, 20] },
    ])]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    subject.controller.toggleHints();

    expect(subject.host.querySelectorAll("[data-hint-label]")).toHaveLength(5);
    expect(subject.host.querySelectorAll(".pdf-link-overlay")).toHaveLength(5);
    expect(normalizePdfSearchQuery("İX")).toBe("i̇x");
  });
  it("does not let cancellation of superseded destination A invalidate named destination B", async () => {
    let resolveDestination!: (destination: readonly unknown[]) => void;
    const subject = setup([page("one", [{ subtype: "Link", rect: [1, 1, 2, 2], dest: "B" }])]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    Object.assign(subject.pdf, {
      getDestination: vi.fn(() => new Promise<readonly unknown[]>((resolve) => { resolveDestination = resolve; })),
    });
    const intentA = subject.controller.queueDestination(1, [0, { name: "XYZ" }, 30, 40, null]);
    const intentB = subject.controller.queueDestination(1, [0, { name: "XYZ" }, 50, 60, null]);
    expect(intentA).toBeDefined();
    expect(intentB).toBeDefined();

    subject.host.querySelector<HTMLButtonElement>(".pdf-link-overlay")?.click();
    await vi.waitFor(() => expect(subject.pdf.getDestination).toHaveBeenCalledWith("B"));
    subject.controller.cancelDestination(intentA);
    resolveDestination([0, { name: "Fit" }]);

    await vi.waitFor(() => expect(subject.navigateToPage).toHaveBeenCalledWith(1));
  });
  it("cancels a superseded destination intent by identity or ordinary supersession", async () => {
    const subject = setup([page("one")]);
    const intent = subject.controller.queueDestination(1, [0, { name: "XYZ" }, 30, 40, null]);
    subject.controller.cancelDestination(intent);
    const replacement = subject.controller.queueDestination(1, [0, { name: "XYZ" }, 50, 60, null]);
    expect(replacement).toBeDefined();
    subject.controller.cancelDestination();

    await subject.controller.renderPage({
      pageNumber: 1,
      page: await subject.pdf.getPage(1),
      viewport: { ...viewport, convertToViewportPoint: () => [50, 60] as const },
      canvas: subject.canvas,
    });

    expect(subject.host.scrollLeft).toBe(0);
    expect(subject.host.scrollTop).toBe(0);
  });
  it("suspends foreground render/search work while retaining completed search state", async () => {
    const annotation = deferred<readonly PdfContentAnnotation[]>();
    const slowRenderPage: PdfContentPage = {
      getTextContent: async () => ({ items: [{ str: "completed match" }] }),
      getAnnotations: () => annotation.promise,
    };
    const subject = setup([page("completed match"), slowRenderPage]);
    await subject.controller.search("match");
    const completed = subject.controller.snapshot;
    expect(completed.results).toHaveLength(1);

    const rendering = subject.controller.renderPage({ pageNumber: 1, page: slowRenderPage, viewport, canvas: subject.canvas });
    await Promise.resolve();
    subject.controller.suspend();
    annotation.resolve([]);
    await rendering;

    expect(subject.controller.snapshot.results).toEqual(completed.results);
    expect(subject.controller.snapshot.searchPending).toBe(false);
    expect(subject.host.querySelector(".pdf-content-layer")).toBeNull();
  });

  it("invalidates an in-flight search when suspended", async () => {
    const text = deferred<{ readonly items: readonly { readonly str?: string }[] }>();
    const slowSearchPage: PdfContentPage = {
      getTextContent: () => text.promise,
      getAnnotations: async () => [],
    };
    const subject = setup([slowSearchPage]);
    const searching = subject.controller.search("late");
    await Promise.resolve();
    subject.controller.suspend();
    text.resolve({ items: [{ str: "late" }] });
    await searching;

    expect(subject.controller.snapshot.searchPending).toBe(false);
    expect(subject.controller.snapshot.results).toEqual([]);
  });
  it("evicts only settled presentation and recomputes released search results", async () => {
    const subject = setup([page("match one"), page("match two")]);
    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    await subject.controller.search("match");
    subject.controller.nextMatch(false);

    expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(RESOURCE_LIMITS.maxTextPageBytes);
    expect(subject.resources.snapshot().totals["search-document-results"]).toBe(2);
    expect(subject.controller.evictInactiveHeavyResources()).toBe(true);
    expect(subject.resources.snapshot().totals["text-page-bytes"]).toBe(0);
    expect(subject.resources.snapshot().totals["search-document-results"]).toBe(0);
    expect(subject.controller.snapshot).toMatchObject({ pageNumber: 1, query: "match", results: [], currentResult: -1 });

    await subject.controller.renderPage({ pageNumber: 1, page: await subject.pdf.getPage(1), viewport, canvas: subject.canvas });
    await subject.controller.restoreEvictedSearch();
    expect(subject.controller.snapshot).toMatchObject({ results: expect.any(Array), currentResult: 1 });
    expect(subject.controller.snapshot.results).toHaveLength(2);
    await subject.controller.unmount();
    subject.resources.assertEmpty();
  });
  it("preserves a selected evicted result across interrupted restoration", async () => {
    let delayRestore = false;
    const interruptedRestoreText = deferred<{ readonly items: readonly { readonly str?: string }[] }>();
    const loadText = vi.fn(() => delayRestore
      ? interruptedRestoreText.promise
      : Promise.resolve({ items: [{ str: "match one" }] }));
    const slowRestorePage: PdfContentPage = {
      getTextContent: loadText,
      streamTextContent: () => streamText(loadText),
      getAnnotations: async () => [],
    };
    const subject = setup([slowRestorePage, page("match two"), page("match three")]);
    await subject.controller.search("match");
    subject.controller.nextMatch();
    subject.controller.nextMatch();
    expect(subject.controller.snapshot.currentResult).toBe(2);
    expect(subject.controller.evictInactiveHeavyResources()).toBe(true);

    delayRestore = true;
    const interruptedRestore = subject.controller.restoreEvictedSearch();
    await vi.waitFor(() => expect(loadText).toHaveBeenCalledTimes(2));
    subject.controller.suspend();
    await interruptedRestore;

    delayRestore = false;
    await subject.controller.restoreEvictedSearch();
    expect(subject.controller.snapshot).toMatchObject({ results: expect.any(Array), currentResult: 2 });
    expect(subject.controller.snapshot.results).toHaveLength(3);
    await subject.controller.unmount();
    subject.resources.assertEmpty();
  });
});
