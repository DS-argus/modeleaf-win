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
  async runLinks() {
    const linksFixture = "links.pdf";
    const linksResponse = await fetch(`/fixtures/pdf/${linksFixture}`);
    requireInvariant(linksResponse.ok, `Link fixture load failed: ${linksResponse.status}`);
    const linkBytes = new Uint8Array(await linksResponse.arrayBuffer());
    await finish();
    host.hidden = true;

    const linkHost = document.createElement("section");
    linkHost.className = "reader-surface tab-host";
    linkHost.tabIndex = 0;
    linkHost.style.cssText = "width:800px;height:600px;max-width:100vw;max-height:100vh;box-sizing:border-box";
    document.body.append(linkHost);
    const linkResources = new ResourceReservationManager();
    const linkStatuses: string[] = [];
    const registryEvents: { phase: "prepare" | "commit" | "finalize" | "abort"; revision: number; entries: number }[] = [];
    const registries = new Map<number, Map<string, string>>();
    const externalActivations: { annotationId: string; registryRevision: number; operationId: string; operationSequence: number; target: string }[] = [];
    const internalNavigations: { page: number; kind: string }[] = [];
    let activeRegistryRevision: number | undefined;
    let nativeCancelCalls = 0;
    let nativeCloseCalls = 0;
    let linkSession: PdfTabSession | undefined;
    let scenario: Record<string, unknown> | undefined;
    const linkOpened = { sessionId: "headless-links", documentGeneration: 1, length: linkBytes.length, displayName: linksFixture };
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = performance.now() + 30_000;
      while (!condition()) {
        requireInvariant(performance.now() < deadline, `${message}: ${JSON.stringify({ outcomes: internalNavigations, page: linkSession?.snapshot.reader.page, historyBack: linkSession?.canHistoryBack, scrollTop: linkHost.scrollTop, statuses: linkStatuses })}`);
        await frame();
      }
    };
    let retiredStyleTokens: string[] = [];
    try {
      const stylesheetText = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n");
      retiredStyleTokens = [".toc-widget", ".pdf-link-hint", ".pdf-link-hints-active"].filter((token) => stylesheetText.includes(token));
      requireInvariant(retiredStyleTokens.length === 0, `Retired reader styling remains loaded: ${retiredStyleTokens.join(", ")}`);
      linkSession = new PdfTabSession({
        native: {
          openPdfDialog: async () => linkOpened,
          cancelSession: async (metadata) => {
            requireInvariant(metadata.sessionId === linkOpened.sessionId, "Link fixture native cancellation targeted the wrong session");
            nativeCancelCalls += 1;
            return { barrierId: 1 };
          },
          closeSession: async (metadata, barrierId) => {
            requireInvariant(metadata.sessionId === linkOpened.sessionId && barrierId === 1, "Link fixture native close authority was invalid");
            nativeCloseCalls += 1;
            activeRegistryRevision = undefined;
            registries.clear();
          },
        },
        pdf: {
          annotationMode: AnnotationMode.DISABLE,
          getDocument: (options) => getDocument({ ...options, url: undefined, range: undefined, data: linkBytes.slice() }) as unknown as PdfLoadingTask,
        },
        resources: linkResources,
        canvasHost: linkHost,
        createContentOptions: () => ({
          onSearchResults: () => undefined,
          requestSearchLanding: async () => { throw new Error("Search is outside the link scenario"); },
          navigateToPage: (page) => { void linkSession?.navigatePagePrompt(page); },
          navigateToDestination: async (page, destination, cause, guard) => {
            if (linkSession === undefined) return { kind: "rejected" };
            const outcome = await linkSession.navigateToDestination(page, destination, cause, guard);
            internalNavigations.push({ page, kind: outcome.kind });
            return outcome;
          },
          resolveDestinationPage: async (reference) => linkSession?.resolveDestinationPage(reference) ?? null,
          prepareExternalLinks: async (entries, registryRevision) => {
            const registry = new Map(entries.map((entry) => [entry.annotationId, entry.target] as const));
            registries.set(registryRevision, registry);
            registryEvents.push({ phase: "prepare", revision: registryRevision, entries: registry.size });
          },
          commitExternalLinks: async (registryRevision) => {
            const registry = registries.get(registryRevision);
            requireInvariant(registry !== undefined, `External registry ${registryRevision} committed before preparation`);
            activeRegistryRevision = registryRevision;
            registryEvents.push({ phase: "commit", revision: registryRevision, entries: registry!.size });
          },
          finalizeExternalLinks: async (registryRevision) => {
            const registry = registries.get(registryRevision);
            requireInvariant(registry !== undefined, `External registry ${registryRevision} finalized without authority`);
            registryEvents.push({ phase: "finalize", revision: registryRevision, entries: registry!.size });
          },
          abortExternalLinks: async (registryRevision) => {
            const entries = registries.get(registryRevision)?.size ?? 0;
            registries.delete(registryRevision);
            if (activeRegistryRevision === registryRevision) activeRegistryRevision = undefined;
            registryEvents.push({ phase: "abort", revision: registryRevision, entries });
          },
          openExternal: async (annotationId, registryRevision, operationId, operationSequence) => {
            const registry = registries.get(registryRevision);
            const target = registry?.get(annotationId);
            requireInvariant(activeRegistryRevision === registryRevision && target !== undefined, "External click bypassed active in-memory native authority");
            requireInvariant(target === "https://example.invalid/allowed", `Unexpected external link target: ${target}`);
            externalActivations.push({ annotationId, registryRevision, operationId, operationSequence, target: target! });
            return operationSequence;
          },
        }),
        onStatus: (status) => { if (linkStatuses.at(-1) !== status) linkStatuses.push(status); },
      });

      const started = performance.now();
      await publishActivateAndAdoptPdfTab(() => undefined, linkSession, () => linkSession!.adopt(linkOpened, 1));
      await linkSession.activate();
      await waitFor(() => linkSession!.snapshot.reader.page === 1
        && linkSession!.snapshot.reader.pageCount === 2
        && linkHost.querySelectorAll<HTMLButtonElement>('.pdf-link-overlay[aria-label^="PDF link "]').length === 4,
      "Link overlays did not publish from the two-page fixture");
      const overlayMilliseconds = performance.now() - started;
      const overlays = [...linkHost.querySelectorAll<HTMLButtonElement>(".pdf-link-overlay")];
      const retiredSessionApi = ["toggleHints", "cancelHints", "handleHintKey", "hintsVisible", "visibleLinkCount", "linkDecorationsVisible", "dismissLinkDecorations"].filter((name) => name in linkSession);
      const retiredSnapshotFields = ["hintsVisible", "visibleLinkCount"].filter((name) => name in linkSession.snapshot.content);
      requireInvariant(retiredSessionApi.length === 0 && retiredSnapshotFields.length === 0, `Retired hint API remains: ${[...retiredSessionApi, ...retiredSnapshotFields].join(", ")}`);
      const labels = overlays.map((overlay) => overlay.getAttribute("aria-label"));
      requireInvariant(overlays.length === 4, `Expected four supported ordinary link overlays, found ${overlays.length}`);
      requireInvariant(labels.join("|") === "PDF link 1|PDF link 2|PDF link 3|PDF link 4", `Unexpected visible link order: ${labels.join(", ")}`);
      requireInvariant(overlays.every((overlay) => overlay.type === "button" && !overlay.disabled && getComputedStyle(overlay).pointerEvents === "auto"), "Ordinary PDF link overlays are not clickable buttons");
      const retiredDom = {
        tocWidgets: linkHost.querySelectorAll(".toc-widget").length,
        linkHints: linkHost.querySelectorAll(".pdf-link-hint").length,
        hintActiveLayers: linkHost.querySelectorAll(".pdf-link-hints-active").length,
        hintDataAttributes: linkHost.querySelectorAll("[data-hint-label], [data-hint-target]").length,
      };
      requireInvariant(Object.values(retiredDom).every((count) => count === 0), `Retired reader UI was published: ${JSON.stringify(retiredDom)}`);

      const external = overlays.find((overlay) => overlay.getAttribute("aria-label") === "PDF link 1");
      requireInvariant(external !== undefined, "Fixture external annotation was not exposed as PDF link 1");
      external!.click();
      await waitFor(() => externalActivations.length === 1 && linkStatuses.includes("PDF link opened (dispatch 1)."), "External annotation did not reach the mocked native callback");
      requireInvariant(externalActivations.length === 1, `External annotation dispatched ${externalActivations.length} times`);

      const internal = overlays.find((overlay) => overlay.getAttribute("aria-label") === "PDF link 2");
      requireInvariant(internal !== undefined && internal.getAttribute("aria-label") === "PDF link 2", "Internal annotation lost its neutral accessible PDF link 2 name");
      internal!.click();
      await waitFor(() => internalNavigations.length === 1
        && internalNavigations[0]!.kind === "verified"
        && linkSession!.snapshot.reader.page === 2
        && linkSession!.canHistoryBack,
      "Clicking PDF link 2 did not verify page-two navigation and history");
      const pageAfterClick = linkSession.snapshot.reader.page;
      const canHistoryBackAfterClick = linkSession.canHistoryBack;
      await waitFor(() => linkSession!.linkIndicatorVisible, "Verified point-link indicator was not published");
      linkSession.dismissLinkIndicator();
      requireInvariant(!linkSession.linkIndicatorVisible, "Destination indicator did not dismiss through the retired-feature replacement API");

      const historyBack = await linkSession.navigateHistoryBack();
      const pageAfterBack = linkSession.snapshot.reader.page;
      requireInvariant(historyBack.kind === "verifiedLanding" && pageAfterBack === 1 && linkSession.canHistoryForward, `Link history back failed: ${historyBack.kind}, page ${pageAfterBack}`);
      const historyForward = await linkSession.navigateHistoryForward();
      const pageAfterForward = linkSession.snapshot.reader.page;
      requireInvariant(historyForward.kind === "verifiedLanding" && pageAfterForward === 2 && linkSession.canHistoryBack, `Link history forward failed: ${historyForward.kind}, page ${pageAfterForward}`);

      scenario = {
        fixture: linksFixture,
        fixtureBytes: linkBytes.length,
        pageCount: linkSession.snapshot.reader.pageCount,
        overlayMilliseconds,
        overlayCount: overlays.length,
        labels,
        retiredSessionApi,
        retiredSnapshotFields,
        retiredDom,
        retiredStyleTokens,
        external: { activations: [...externalActivations], callbackOnly: true },
        internal: {
          target: "PDF link 2",
          outcomes: [...internalNavigations],
          pageAfterClick,
          canHistoryBackAfterClick,
          indicatorPublishedAndDismissed: true,
          historyBack: historyBack.kind,
          pageAfterBack,
          historyForward: historyForward.kind,
          pageAfterForward,
        },
        registryEvents: [...registryEvents],
        statuses: [...linkStatuses],
      };
    } finally {
      try { await linkSession?.close(); }
      finally { linkHost.remove(); }
    }

    const settledResources = linkResources.snapshot();
    linkResources.assertEmpty();
    requireInvariant(nativeCancelCalls === 1 && nativeCloseCalls === 1, `Link native teardown count was ${nativeCancelCalls}/${nativeCloseCalls}`);
    requireInvariant(activeRegistryRevision === undefined && registries.size === 0, "In-memory external-link authority survived teardown");
    requireInvariant(scenario !== undefined, "Link scenario did not produce measurements");
    return {
      ...scenario!,
      teardown: { nativeCancelCalls, nativeCloseCalls, reservationCount: settledResources.reservationCount },
      disposed: true,
    };
  },
  async runChrome() {
    // Execute the dev-transformed production renderer fragments and pure fitter, not copied UI layout logic.
    const code = await (await fetch("/src/main.ts")).text();
    const raw = (await import("../../src/main.ts?raw")).default as string;
    const chooser = await import("../../src/ui/OpenChooserModel");
    const recentPathPresentation = await import("../../src/ui/RecentPathPresentation");
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
    const chooserRenderer = new Function(
      "fileOpenerList", "chooserRows", "selectChooserIndex", "dispatchFileOpenerEntry", "fitRecentPath",
      `let fileOpenerModel;${code.slice(chooserStart, chooserEnd)};return {render(model){fileOpenerModel=model;renderFileOpener();},dispose(){stopFileOpenerPathFitting();}};`,
    )(list, chooser.chooserRows, chooser.selectChooserIndex, unusedAction, recentPathPresentation.fitRecentPath) as {
      render(model: ReturnType<typeof chooser.createOpenChooser>): void;
      dispose(): void;
    };
    const renderChooser = (entries: { recentId: string; displayName: string; displayPath: string }[]) => {
      chooserRenderer.render(chooser.createOpenChooser({ tag: "READY", snapshot: { revision: "1", entries } }));
    };
    renderChooser([]);
    requireInvariant(list.querySelector(".file-opener-recents-heading") === null, "Empty recents has an orphan divider");
    const longDirectoryEntry = {
      recentId: "qa-directory",
      displayName: "research-report.pdf",
      displayPath: `C:\\Research\\${"Long directory\\".repeat(18)}research-report.pdf`,
    };
    const longFilenameEntry = {
      recentId: "qa-filename",
      displayName: `${"긴보고서".repeat(30)}.pdf`,
      displayPath: `D:\\Documents\\${"긴보고서".repeat(30)}.pdf`,
    };
    const resizeEntry = {
      recentId: "qa-resize",
      displayName: "moderately-long-filename-for-resize-check.pdf",
      displayPath: "E:\\QA\\moderately-long-filename-for-resize-check.pdf",
    };
    const entries = [longDirectoryEntry, longFilenameEntry, resizeEntry];
    renderChooser(entries);
    dialog.style.width = "270px";
    dialog.showModal();
    const settleLayout = async () => { await frame(); await frame(); await frame(); };
    await settleLayout();
    const buttonFor = (entry: typeof entries[number]) => {
      const button = [...list.querySelectorAll<HTMLButtonElement>(".file-opener-recent")].find(candidate => candidate.title === entry.displayPath);
      requireInvariant(button !== undefined, `Recent row was not rendered: ${entry.recentId}`);
      return button!;
    };
    const narrowResizeFont = Number.parseFloat(getComputedStyle(buttonFor(resizeEntry)).fontSize);
    requireInvariant(narrowResizeFont < 13, "Narrow recent row did not shrink from its base font");
    // 460px is the production dialog width at the 480px viewport breakpoint.
    dialog.style.width = "min(460px, calc(100vw - 20px))";
    await settleLayout();
    const browse = list.querySelector<HTMLElement>(".file-opener-browse")!;
    const heading = list.querySelector<HTMLElement>(".file-opener-recents-heading")!;
    requireInvariant(browse.childElementCount === 0 && browse.textContent === "Browse...", "Browse glyph was not removed");
    const browseStyle = getComputedStyle(browse);
    requireInvariant([browseStyle.borderTopWidth, browseStyle.borderRightWidth, browseStyle.borderBottomWidth, browseStyle.borderLeftWidth].every(width => Number.parseFloat(width) === 0), "Browse retained a visible border");
    browse.focus();
    await frame();
    requireInvariant(Number.parseFloat(getComputedStyle(browse).outlineWidth) >= 2, "Browse keyboard focus outline is missing");
    requireInvariant(Number.parseFloat(getComputedStyle(heading).borderTopWidth) >= 1, "Recent divider is not visible");
    const assertFittedRow = (entry: typeof entries[number]) => {
      const button = buttonFor(entry);
      const directory = button.querySelector<HTMLElement>(".file-opener-recent-directory")!;
      const filename = button.querySelector<HTMLElement>(".file-opener-recent-filename")!;
      const style = getComputedStyle(button);
      const contentWidth = button.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      const visibleWidth = directory.getBoundingClientRect().width + filename.getBoundingClientRect().width;
      requireInvariant(filename.textContent === entry.displayName, `Recent filename was changed: ${entry.recentId}`);
      requireInvariant(filename.getBoundingClientRect().right <= button.getBoundingClientRect().right - Number.parseFloat(style.paddingRight) + 1, `Recent filename is clipped: ${entry.recentId}`);
      requireInvariant(visibleWidth <= contentWidth + 1, `Recent path exceeds its row: ${entry.recentId}`);
      requireInvariant(button.getAttribute("aria-label") === entry.displayPath && button.title === entry.displayPath, `Recent full path is not accessible: ${entry.recentId}`);
      return { button, directory, filename, fontSize: Number.parseFloat(style.fontSize), visibleText: directory.textContent! + filename.textContent!, visibleWidth, contentWidth };
    };
    const directoryFit = assertFittedRow(longDirectoryEntry);
    requireInvariant(directoryFit.directory.textContent!.startsWith("C:\\") && directoryFit.directory.textContent!.includes("…"), "Directory was not middle-truncated with its root visible");
    const filenameFit = assertFittedRow(longFilenameEntry);
    requireInvariant(filenameFit.fontSize < 13, "Long filename was not fitted by shrinking the row font");
    const resizeFit = assertFittedRow(resizeEntry);
    requireInvariant(Math.abs(resizeFit.fontSize - 13) <= 0.01 && resizeFit.visibleText === resizeEntry.displayPath, "Wider chooser did not restore the full path and base font");
    const dispatchStart = code.indexOf("function dispatchFileOpenerEntry()");
    const dispatchEnd = code.indexOf("async function openFileOpener", dispatchStart);
    const dispatchSource = code.slice(dispatchStart, dispatchEnd);
    requireInvariant(dispatchSource.includes("openRecentDocument(invoke, row.recentId)") && !dispatchSource.includes("openRecentDocument(invoke, row.displayPath)"), "Recent display path replaced opaque ID open authority");
    if (matchMedia("(forced-colors: active)").matches) requireInvariant([...dialog.querySelectorAll("kbd")].every(key => getComputedStyle(key).color === getComputedStyle(heading).color), "Forced-color shortcut hints do not use CanvasText");
    const bounds = dialog.getBoundingClientRect();
    requireInvariant(bounds.width > 0 && bounds.width <= Math.min(460, innerWidth - 20) + 1, "Chooser exceeded its 480px-breakpoint width");
    requireInvariant(bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight, "Chooser exceeds viewport");
    const stripWidth = strip.clientWidth;
    const stripScrollWidth = strip.scrollWidth;
    const stripScrollLeft = strip.scrollLeft;
    const browseText = browse.textContent;
    const divider = getComputedStyle(heading).borderTop;
    chooserRenderer.dispose();
    dialog.close();
    dialog.remove();
    strip.remove();
    await finish();
    return {
      dimensions,
      stripWidth,
      stripScrollWidth,
      stripScrollLeft,
      browse: browseText,
      divider,
      recentPaths: {
        directory: directoryFit.visibleText,
        longFilename: filenameFit.filename.textContent,
        longFilenameFontSize: filenameFit.fontSize,
        narrowResizeFont,
        restoredResizeFont: resizeFit.fontSize,
      },
      dialog: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      disposed: true,
    };
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
