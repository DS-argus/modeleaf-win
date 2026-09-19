// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist", () => ({
  TextLayer: class {
    public constructor(private readonly options: { readonly textContentSource: { readonly items: readonly { readonly str?: string }[] }; readonly container: HTMLElement }) {}
    public async render(): Promise<void> {
      for (const item of this.options.textContentSource.items) {
        if (item.str === undefined) continue;
        const span = document.createElement("span");
        span.textContent = item.str;
        this.options.container.append(span);
      }
    }
    public cancel(): void {}
  },
}));

import {
  PdfContentController,
  type PdfContentAnnotation,
  type PdfContentControllerOptions,
  type PdfContentDocument,
  type PdfContentPage,
  type PdfContentViewport,
  type PdfDestinationNavigationOutcome,
} from "../../../src/pdf/PdfContentController";
import { ResourceReservationManager } from "../../../src/pdf/ResourceBudget";

const viewport: PdfContentViewport = {
  width: 200,
  height: 160,
  scale: 1,
  rotation: 0,
  rawDims: { pageWidth: 200, pageHeight: 160 },
  convertToViewportPoint: (x, y) => [x, y] as const,
  convertToPdfPoint: (x, y) => [x, y] as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function page(annotations: readonly PdfContentAnnotation[]): PdfContentPage {
  return {
    getTextContent: async () => ({ items: [{ str: "PDF link test" }] }),
    getAnnotations: async () => annotations,
  };
}

function setup(
  annotations: readonly PdfContentAnnotation[],
  navigateToDestination: PdfContentControllerOptions["navigateToDestination"] = async () => ({ kind: "verified" }),
) {
  const host = document.createElement("div");
  const canvas = document.createElement("canvas");
  const width = 100;
  const height = 80;
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
    clientLeft: { configurable: true, value: 0 },
    clientTop: { configurable: true, value: 0 },
    scrollLeft: { configurable: true, enumerable: true, value: 10, writable: true },
    scrollTop: { configurable: true, enumerable: true, value: 5, writable: true },
  });
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(0, 0, width, height),
  });
  host.append(canvas);

  const statuses: string[] = [];
  const navigateToPage = vi.fn<(pageNumber: number) => void>();
  const openExternal = vi.fn<PdfContentControllerOptions["openExternal"]>(async (_annotationId, _registryRevision, _operationId, operationSequence) => operationSequence);
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
    navigateToDestination,
    onSearchResults: () => undefined,
    requestSearchLanding: async () => "displayedDistinct",
    prepareExternalLinks,
    commitExternalLinks,
    finalizeExternalLinks,
    abortExternalLinks,
    openExternal,
  });
  const renderedPage = page(annotations);
  const pdf: PdfContentDocument = {
    numPages: 1,
    getPage: async () => renderedPage,
  };
  controller.mount(pdf, 1, "pdf-link-hints-test");
  return {
    controller,
    host,
    canvas,
    pdf,
    renderedPage,
    openExternal,
    navigateToDestination,
    statuses,
  };
}

async function render(subject: ReturnType<typeof setup>, renderViewport: PdfContentViewport = viewport): Promise<void> {
  await subject.controller.renderPage({
    pageNumber: 1,
    page: subject.renderedPage,
    viewport: renderViewport,
    canvas: subject.canvas,
  });
}

const internalDestination = [0, { name: "XYZ" }, 20, 30, null] as const;

describe("PdfContentController visible link facade", () => {
  it("publishes clipped host-local intersections and preserves duplicate occurrences", async () => {
    const sameUrl = "https://example.test/repeated";
    const subject = setup([
      { subtype: "Link", rect: [5, 5, 25, 20], url: sameUrl },
      { subtype: "Link", rect: [40, 20, 60, 35], url: sameUrl },
      { subtype: "Link", rect: [110, 10, 120, 20], url: "https://example.test/outside" },
      { subtype: "Link", rect: [20, 20, 30, 30], action: "Launch", dest: internalDestination },
    ]);
    await render(subject);

    const visible = subject.controller.visibleLinkSnapshot;
    expect(Object.isFrozen(visible)).toBe(true);
    expect(visible.viewport).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    expect(visible.candidates).toHaveLength(2);
    expect(visible.candidates[0]?.rect).toEqual({ x: 0, y: 0, width: 15, height: 15 });
    expect(visible.candidates[1]?.rect).toEqual({ x: 30, y: 15, width: 20, height: 15 });
    expect(visible.candidates[0]?.url).toBe(sameUrl);
    expect(visible.candidates[1]?.url).toBe(sameUrl);
    expect(visible.candidates[0]?.selectionId).not.toBe(visible.candidates[1]?.selectionId);
    expect(visible.candidates.every((entry) => Object.isFrozen(entry.rect))).toBe(true);
  });

  it("rejects a stale snapshot, fences callbacks after cancellation, and allows a fresh snapshot retry", async () => {
    const destination = deferred<PdfDestinationNavigationOutcome>();
    const navigate = vi.fn<PdfContentControllerOptions["navigateToDestination"]>(async () => destination.promise);
    const subject = setup([{ subtype: "Link", rect: [20, 20, 40, 35], dest: internalDestination }], navigate);
    await render(subject);
    const captured = subject.controller.visibleLinkSnapshot;
    const selectionId = captured.candidates[0]!.selectionId;

    subject.host.scrollLeft = 11;
    expect(await subject.controller.activateVisibleLink(captured, selectionId)).toEqual({ kind: "stale" });
    subject.host.scrollLeft = 10;

    const pending = subject.controller.activateVisibleLink(captured, selectionId);
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledOnce();
    subject.controller.cancelVisibleLinkActivation();
    destination.resolve({ kind: "verified", landing: { pageIndex: 0, x: 20, y: 30 } });
    expect(await pending).toEqual({ kind: "stale" });

    const fresh = subject.controller.visibleLinkSnapshot;
    expect(fresh.revision).not.toBe(captured.revision);
    const retry = await subject.controller.activateVisibleLink(fresh, selectionId);
    expect(retry).toEqual({ kind: "activated", link: "internal", landing: { pageIndex: 0, x: 20, y: 30 } });
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("confirms external links through the facade and prevents same-snapshot replay", async () => {
    const subject = setup([{ subtype: "Link", rect: [20, 20, 40, 35], url: "https://example.test/confirmed" }]);
    await render(subject);
    const captured = subject.controller.visibleLinkSnapshot;
    const selectionId = captured.candidates[0]!.selectionId;

    expect(await subject.controller.activateVisibleLink(captured, selectionId)).toEqual({ kind: "confirmation-required", url: "https://example.test/confirmed" });
    expect(subject.openExternal).not.toHaveBeenCalled();
    expect(await subject.controller.activateVisibleLink(captured, selectionId, true)).toEqual({ kind: "activated", link: "external" });
    expect(subject.openExternal).toHaveBeenCalledOnce();
    expect(await subject.controller.activateVisibleLink(captured, selectionId, true)).toEqual({ kind: "already-activated" });

    const fresh = subject.controller.visibleLinkSnapshot;
    expect(await subject.controller.activateVisibleLink(fresh, selectionId, true)).toEqual({ kind: "activated", link: "external" });
    expect(subject.openExternal).toHaveBeenCalledTimes(2);
  });

  it("transforms an explicit near-edge PDF marker point into a transient indicator and expires it", async () => {
    vi.useFakeTimers();
    try {
      let returnLanding: boolean | undefined;
      const navigate = vi.fn<PdfContentControllerOptions["navigateToDestination"]>(async (...args) => {
        returnLanding = args[4];
        return returnLanding
          ? { kind: "verified", landing: { pageIndex: 0, x: 94, y: 74 } }
          : { kind: "verified" };
      });
      const markerViewport: PdfContentViewport = {
        ...viewport,
        rawDims: { pageWidth: 100, pageHeight: 80 },
        convertToViewportPoint: (x, y) => [x * 2, y * 2] as const,
        convertToPdfPoint: (x, y) => [x / 2, y / 2] as const,
      };
      const nearEdgeDestination = [0, { name: "XYZ" }, 94, 74, null] as const;
      const subject = setup([{ subtype: "Link", rect: [20, 20, 40, 35], dest: nearEdgeDestination }], navigate);
      await render(subject, markerViewport);
      const visible = subject.controller.visibleLinkSnapshot;
      const result = await subject.controller.activateVisibleLink(visible, visible.candidates[0]!.selectionId);
      expect(returnLanding).toBe(true);
      expect(result).toEqual({ kind: "activated", link: "internal", landing: { pageIndex: 0, x: 94, y: 74 } });
      expect(navigate).toHaveBeenCalledWith(1, nearEdgeDestination, "internal-link", expect.any(Function), true);

      const indicator = subject.host.querySelector<HTMLElement>(".pdf-destination-indicator");
      expect(indicator).not.toBeNull();
      expect(indicator?.style.left).toBe("188px");
      expect(indicator?.style.top).toBe("148px");
      expect(indicator?.style.transform).toBe("translate(-50%, -50%) scale(1)");
      expect(indicator?.style.pointerEvents).toBe("none");
      vi.advanceTimersByTime(899);
      expect(subject.host.querySelector(".pdf-destination-indicator")).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(subject.host.querySelector(".pdf-destination-indicator")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not publish an indicator for a page-only verified landing", async () => {
    const navigate = vi.fn<PdfContentControllerOptions["navigateToDestination"]>(async () => ({ kind: "verified" }));
    const pageOnlyDestination = [0, { name: "Fit" }] as const;
    const subject = setup([{ subtype: "Link", rect: [20, 20, 40, 35], dest: pageOnlyDestination }], navigate);
    await render(subject);
    const visible = subject.controller.visibleLinkSnapshot;
    expect(await subject.controller.activateVisibleLink(visible, visible.candidates[0]!.selectionId)).toEqual({ kind: "activated", link: "internal" });
    expect(subject.host.querySelector(".pdf-destination-indicator")).toBeNull();
  });
});
