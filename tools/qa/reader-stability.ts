import { getDocument, GlobalWorkerOptions, AnnotationMode } from "pdfjs-dist";
import { type PdfLoadingTask } from "../../src/pdf/PdfReaderController";
import { PdfTabSession, publishActivateAndAdoptPdfTab } from "../../src/pdf/PdfTabSession";
import { ResourceReservationManager } from "../../src/pdf/ResourceBudget";
import { TabWorkspace } from "../../src/core/TabWorkspace";
import { performTabClose } from "../../src/application/TabActivationCoordinator";
import "../../src/styles/app.css";

// Real PDF.js/DOM/session QA with in-memory native authority. No Tauri calls,
// user PDF paths, persistent state, native windows, or external URL activation.
GlobalWorkerOptions.workerSrc = "/node_modules/pdfjs-dist/build/pdf.worker.mjs";
const host = document.querySelector<HTMLElement>("#host")!;
const hiddenOpening = new URLSearchParams(location.search).get("hidden") === "true";
host.hidden = hiddenOpening;
if (hiddenOpening && (host.clientWidth !== 0 || host.clientHeight !== 0)) throw new Error("Hidden opening fixture must have zero layout size");
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
  onStatus: (status) => { if (statuses.at(-1) !== status) statuses.push(status); publish(); },
});
function publish(): void { if (hiddenOpening) host.hidden = !session.snapshot.reader.hasDocument; }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const synchronize = () => session.synchronizeViewport(host.scrollTop, host.clientHeight);
const snapshot = () => ({
  top: host.scrollTop, height: host.scrollHeight, page: session.snapshot.reader.page,
  scale: session.snapshot.reader.customScale, mode: session.snapshot.reader.zoomMode,
  frames: host.querySelectorAll(":scope > .pdf-page-frame").length,
  canvases: host.querySelectorAll("canvas").length,
});
const requireInvariant = (value: boolean, message: string) => { if (!value) throw new Error(message); };
await publishActivateAndAdoptPdfTab(publish, session, () => session.adopt(opened, 1));
await session.activate();
publish();
await frame();
await frame();
await frame();
const opening = snapshot();
Object.assign(window, { readerOpening: { hiddenOpening, opening, statuses } });
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
  async runChrome() {
    // Execute the dev-transformed production renderer fragments, not copied UI markup.
    const code = await (await fetch("/src/main.ts")).text();
    const raw = (await import("../../src/main.ts?raw")).default as string;
    const chooser = await import("../../src/ui/OpenChooserModel");
    const accessibility = await import("../../src/ui/AccessibilityController");
    const strip = document.createElement("div");
    strip.className = "tab-strip";
    strip.setAttribute("role", "tablist");
    document.body.prepend(strip);
    const names = ["a.pdf", "A considerably longer research document filename.pdf", "한글 문서 이름.pdf"];
    const tabs = names.map((title, index) => ({ id: index + 1, payload: { session: { snapshot: { title } } } }));
    const tabStart = code.indexOf("tabStrip.replaceChildren(");
    const tabEnd = code.indexOf("function cancelPagePromptOwnership", tabStart);
    requireInvariant(tabStart >= 0 && tabEnd > tabStart, "Production tab renderer was not found");
    const tabBody = code.slice(tabStart, tabEnd).trim().replace(/\}\s*$/u, "");
    const unusedAction = () => { throw new Error("Layout QA does not dispatch native actions"); };
    new Function("documentTabs", "workspace", "tabStrip", "tabAccessibilitySemantics", "switchTab", "closeTab", tabBody)(tabs, { activeTabId: 3 }, strip, accessibility.tabAccessibilitySemantics, unusedAction, unusedAction);
    const dimensions = [...strip.querySelectorAll<HTMLElement>(".workspace-tab-item")].map(item => {
      const rect = item.getBoundingClientRect();
      const label = item.querySelector<HTMLElement>(".workspace-tab")!;
      return { width: rect.width, height: rect.height, labelWidth: label.clientWidth, labelScrollWidth: label.scrollWidth, title: label.title };
    });
    requireInvariant(dimensions.every(size => Math.abs(size.width - 184) <= 0.1 && Math.abs(size.height - 26) <= 0.1), "Tab sizes depend on filenames");
    requireInvariant(dimensions[1]!.labelScrollWidth > dimensions[1]!.labelWidth, "Long tab title did not exercise ellipsis");
    const activeBounds = strip.querySelector<HTMLElement>('[aria-selected="true"]')!.getBoundingClientRect();
    const stripBounds = strip.getBoundingClientRect();
    requireInvariant(activeBounds.left >= stripBounds.left - 1 && activeBounds.right <= stripBounds.right + 1, "Selected tab is clipped outside strip");
    const markup = raw.match(/<dialog id="file-opener-dialog"[\s\S]*?<\/dialog>/u)?.[0];
    requireInvariant(markup !== undefined, "Production chooser markup was not found");
    document.body.insertAdjacentHTML("beforeend", markup!);
    const dialog = document.querySelector<HTMLDialogElement>("#file-opener-dialog")!;
    const list = dialog.querySelector<HTMLElement>("#file-opener-list")!;
    const chooserStart = code.indexOf("function renderFileOpener()");
    const chooserEnd = code.indexOf("let clearingRecents", chooserStart);
    requireInvariant(chooserStart >= 0 && chooserEnd > chooserStart, "Production chooser renderer was not found");
    const renderChooser = (entries: { recentId: string; displayName: string }[]) => {
      const model = chooser.createOpenChooser({ tag: "READY", snapshot: { revision: "1", entries } });
      const render = new Function("fileOpenerModel", "fileOpenerList", "chooserRows", "selectChooserIndex", "dispatchFileOpenerEntry", code.slice(chooserStart, chooserEnd) + ";return renderFileOpener;")(model, list, chooser.chooserRows, chooser.selectChooserIndex, unusedAction);
      render();
    };
    renderChooser([]);
    requireInvariant(list.querySelector(".file-opener-recents-heading") === null, "Empty recents has an orphan divider");
    renderChooser(names.map((displayName, index) => ({ recentId: `qa-${index}`, displayName })));
    dialog.showModal();
    await frame();
    const browse = list.querySelector<HTMLElement>(".file-opener-browse")!;
    const heading = list.querySelector<HTMLElement>(".file-opener-recents-heading")!;
    requireInvariant(browse.childElementCount === 0 && browse.textContent === "Browse...", "Browse glyph was not removed");
    requireInvariant(parseFloat(getComputedStyle(heading).borderTopWidth) >= 1, "Recent divider is not visible");
    if (matchMedia("(forced-colors: active)").matches) requireInvariant([...dialog.querySelectorAll("kbd")].every(key => getComputedStyle(key).color === getComputedStyle(heading).color), "Forced-color shortcut hints do not use CanvasText");
    const bounds = dialog.getBoundingClientRect();
    requireInvariant(bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight, "Chooser exceeds viewport");
    await finish();
    return { dimensions, stripWidth: strip.clientWidth, stripScrollWidth: strip.scrollWidth, stripScrollLeft: strip.scrollLeft, browse: browse.textContent, divider: getComputedStyle(heading).borderTop, dialog: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, disposed: true };
  },
  async runTabClose() {
    const landing = await session.navigatePagePrompt(12);
    requireInvariant(landing.kind === "verifiedLanding", "Could not establish nonzero tab position");
    session.apply({ type: "view.zoom", factor: 1.1 });
    requireInvariant(await session.renderCurrentView(), "Could not establish custom tab zoom");
    const before = snapshot();
    const workspace = new TabWorkspace(() => ({ host, session }));
    const originalId = workspace.activeTabId;
    const pendingCloses: Promise<void>[] = [];
    const publishTabs = () => {
      for (const tab of workspace.snapshot.tabs) tab.payload.host.hidden = tab.id !== workspace.activeTabId || !tab.payload.session.snapshot.reader.hasDocument;
    };
    const secondHost = document.createElement("section");
    secondHost.className = "reader-surface tab-host";
    secondHost.style.cssText = "width:800px;height:600px;max-width:100vw;box-sizing:border-box";
    document.body.append(secondHost);
    const second = new PdfTabSession({
      native: { openPdfDialog: async () => opened, cancelSession: async () => ({ barrierId: 1 }), closeSession: async () => undefined },
      pdf: { annotationMode: AnnotationMode.DISABLE, getDocument: (options) => getDocument({ ...options, url: undefined, range: undefined, data: bytes.slice() }) as unknown as PdfLoadingTask },
      resources, canvasHost: secondHost,
      createContentOptions: () => ({
        onSearchResults: () => undefined,
        requestSearchLanding: async () => { throw new Error("Search is outside the tab-close scenario"); },
        navigateToPage: () => { throw new Error("Page commands are outside the tab-close scenario"); },
        navigateToDestination: async () => { throw new Error("Links are outside the tab-close scenario"); },
        prepareExternalLinks: async () => undefined, commitExternalLinks: async () => undefined,
        finalizeExternalLinks: async () => undefined, abortExternalLinks: async () => undefined,
        openExternal: async () => { throw new Error("QA does not activate external URLs"); },
      }),
      onStatus: publishTabs,
    });
    await session.deactivate();
    session.evictInactiveHeavyResources();
    const secondId = workspace.appendAndActivate({ host: secondHost, session: second }, { dispose: payload => {
      pendingCloses.push(payload.session.close()); payload.host.remove();
    } })!;
    await publishActivateAndAdoptPdfTab(publishTabs, second, () => second.adopt({ ...opened, sessionId: "headless-second" }, 2));
    publishTabs();
    await performTabClose(secondId, {
      activeId: () => workspace.activeTabId, cancelPending: () => second.cancelPendingNavigation(),
      closeWorkspace: id => workspace.close(id), publish: publishTabs,
      activateCurrent: async () => {
        requireInvariant(host.clientWidth > 0 && host.clientHeight > 0, "Successor must have visible geometry before activation");
        await session.activate();
      },
    });
    await Promise.all(pendingCloses);
    requireInvariant(workspace.activeTabId === originalId && session.snapshot.active, "Surviving tab was not reactivated");
    const restored = snapshot();
    Object.assign(window, { readerTabClose: { before, restored } });
    requireInvariant(restored.canvases > 0, "Surviving tab has no restored raster");
    requireInvariant(restored.page === before.page && restored.mode === before.mode && Math.abs(restored.scale - before.scale) < 0.000001 && Math.abs(restored.top - before.top) <= 1, "Tab restoration changed its page, zoom, or position");
    await finish();
    return { before, restored, active: true, disposed: true };
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
