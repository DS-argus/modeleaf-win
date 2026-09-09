import { getDocument, GlobalWorkerOptions, AnnotationMode } from "pdfjs-dist";
import { type PdfLoadingTask } from "../../src/pdf/PdfReaderController";
import { PdfTabSession } from "../../src/pdf/PdfTabSession";
import { ResourceReservationManager } from "../../src/pdf/ResourceBudget";
import "../../src/styles/app.css";

// Real PDF.js/DOM/session QA with in-memory native authority. No Tauri calls,
// user PDF paths, persistent state, native windows, or external URL activation.
GlobalWorkerOptions.workerSrc = "/node_modules/pdfjs-dist/build/pdf.worker.mjs";
const host = document.querySelector<HTMLElement>("#host")!;
const fixture = "fixture-L-text-300.pdf";
const response = await fetch(`/fixtures/pdf/${fixture}`);
if (!response.ok) throw new Error(`Fixture load failed: ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
const resources = new ResourceReservationManager();
const statuses: string[] = [];
const opened = { sessionId: "headless-layout", documentGeneration: 1, length: bytes.length, displayName: fixture };
const session = new PdfTabSession({
  native: {
    openPdfDialog: async () => opened,
    cancelSession: async () => ({ barrierId: 1 }),
    closeSession: async () => undefined,
  },
  pdf: {
    annotationMode: AnnotationMode.DISABLE,
    getDocument: (options) => getDocument({ ...options, url: undefined, range: undefined, data: bytes.slice() }) as unknown as PdfLoadingTask,
  },
  resources,
  canvasHost: host,
  createContentOptions: () => ({
    onSearchResults: () => undefined,
    requestSearchLanding: async (request) => {
      const result = await session.navigateSearchLanding(request);
      if (result.kind === "verifiedLanding") return "displayedDistinct";
      if (result.kind === "noOp" || result.kind === "search-epoch-recorded") return "displayedSame";
      if (result.kind === "stale") return "stale";
      return "failedWithoutMovement";
    },
    navigateToPage: (page) => { void session.navigatePagePrompt(page); },
    navigateToDestination: (page, destination, cause, guard) => session.navigateToDestination(page, destination, cause, guard),
    resolveDestinationPage: (reference) => session.resolveDestinationPage(reference),
    prepareExternalLinks: async () => undefined,
    commitExternalLinks: async () => undefined,
    finalizeExternalLinks: async () => undefined,
    abortExternalLinks: async () => undefined,
    openExternal: async () => { throw new Error("QA does not activate external URLs"); },
  }),
  onStatus: (status) => { if (statuses.at(-1) !== status) statuses.push(status); },
});
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const synchronize = () => session.synchronizeViewport(host.scrollTop, host.clientHeight);
const snapshot = () => ({
  top: host.scrollTop, height: host.scrollHeight, page: session.snapshot.reader.page,
  scale: session.snapshot.reader.customScale, mode: session.snapshot.reader.zoomMode,
  frames: host.querySelectorAll(":scope > .pdf-page-frame").length,
  canvases: host.querySelectorAll("canvas").length,
});
const requireInvariant = (value: boolean, message: string) => { if (!value) throw new Error(message); };
await session.activate();
await session.adopt(opened, 1);
await frame();
const opening = snapshot();
requireInvariant(opening.top <= 1, `Opening page not at top: ${opening.top}`);
const finish = async () => { await session.close(); resources.assertEmpty(); };

Object.assign(window, { readerHarness: {
  session, statuses, resources, host, snapshot,
  async run() {
    const samples = [opening];
    for (let index = 0; index < 12; index += 1) {
      session.apply({ type: "scroll.byViewport", factor: 0.8 });
      const intent = session.reader.consumePendingScroll();
      host.scrollBy({ top: intent.viewportFactor * host.clientHeight, behavior: "instant" });
      const before = host.scrollTop;
      await synchronize();
      await frame();
      const after = snapshot();
      requireInvariant(after.top >= before - 1, `Forward scroll snapped backwards: ${before} -> ${after.top}`);
      samples.push(after);
    }
    host.scrollTop = host.scrollHeight;
    await synchronize(); await frame();
    const end = snapshot();
    for (let index = 0; index < 8; index += 1) {
      session.apply({ type: "scroll.byViewport", factor: 0.8 });
      session.reader.consumePendingScroll();
      host.scrollBy({ top: host.clientHeight, behavior: "instant" });
      await synchronize(); await frame();
      const now = snapshot();
      requireInvariant(Math.abs(now.top - end.top) <= 1, `Document edge oscillation: ${end.top} -> ${now.top}`);
      requireInvariant(Math.abs(now.height - end.height) <= 1, `Document height changed at rest: ${end.height} -> ${now.height}`);
    }
    for (let index = 0; index < 12; index += 1) {
      host.scrollBy({ top: -host.clientHeight * 0.8, behavior: "instant" });
      const before = host.scrollTop;
      await synchronize(); await frame();
      requireInvariant(host.scrollTop <= before + 1, `Reverse scroll snapped forward: ${before} -> ${host.scrollTop}`);
    }
    const final = snapshot();
    requireInvariant(final.canvases > 0, "No raster after navigation");
    await finish();
    return { fixture, opening, forwardSamples: samples, end, final, statuses, disposed: true };
  },
  async runSearch() {
    const waitFor = async (condition: () => boolean) => {
      const deadline = performance.now() + 30_000;
      while (!condition()) {
        requireInvariant(performance.now() < deadline, "Search scenario timed out");
        await frame();
      }
    };
    const started = performance.now();
    session.startSearch("needle");
    await waitFor(() => session.snapshot.content.currentResult >= 0);
    const firstMilliseconds = performance.now() - started;
    const firstPending = session.snapshot.content.searchPending;
    requireInvariant(firstPending, "No navigable result was published before full extraction completed");
    await waitFor(() => session.snapshot.content.results.length >= 4);
    const landings = [];
    for (let index = 0; index < 3; index += 1) {
      const previous = session.snapshot.content.currentResult;
      session.cycleSearch(false);
      await waitFor(() => session.snapshot.content.currentResult !== previous);
      const state = session.snapshot;
      requireInvariant(state.reader.page === state.content.results[state.content.currentResult]!.pageNumber, "Search result and displayed page disagree");
      landings.push({ result: state.content.currentResult, page: state.reader.page, top: host.scrollTop });
    }
    await waitFor(() => !session.snapshot.content.searchPending);
    const content = session.snapshot.content;
    requireInvariant(!content.searchIncomplete && content.results.length === 300, "Search did not complete the fixed 300-page fixture");
    requireInvariant(content.currentResult === 3, "Final extraction reset the user's selected match");
    await finish();
    return { firstMilliseconds, firstPending, landings, results: content.results.length, selected: content.currentResult, disposed: true };
  },
  async runNavigation() {
    const first = await session.navigateFirstPage();
    requireInvariant(first.kind === "verifiedLanding" || first.kind === "noOp", `First: ${first.kind}`);
    const repeated = await Promise.all(Array.from({ length: 30 }, () => session.navigateAdjacentPage(1)));
    const afterRepeats = snapshot();
    requireInvariant(afterRepeats.page > 1 && afterRepeats.page <= 3, `Unbounded repeats: ${afterRepeats.page}`);
    const mixed = await Promise.all([session.navigateLastPage(), session.navigateAdjacentPage(-1), session.navigateFirstPage()]);
    requireInvariant(session.snapshot.reader.page === 1, `Mixed commands did not end at first page: ${session.snapshot.reader.page}`);
    session.apply({ type: "view.fitPage" });
    requireInvariant(await session.renderCurrentView(), "Fit Page failed");
    const fitted = snapshot();
    requireInvariant(fitted.frames === 1, `Fit Page has ${fitted.frames} frames`);
    const zooms = [];
    for (let index = 0; index < 8; index += 1) {
      const before = session.snapshot.reader.customScale;
      session.apply({ type: "view.zoom", factor: index % 2 === 0 ? 1.1 : 1 / 1.1 });
      requireInvariant(await session.renderCurrentView(), `Zoom ${index} did not commit`);
      const after = snapshot();
      requireInvariant(Math.abs(after.scale - before) > 0.0001, `Zoom ${index} stalled`);
      zooms.push(after);
    }
    await finish();
    return { repeated: repeated.map(result => result.kind), afterRepeats, mixed, fitted, zooms, statuses, disposed: true };
  },
} });
