import { getDocument, GlobalWorkerOptions, AnnotationMode } from "pdfjs-dist";
import { clampReaderScale } from "../../src/domain/navigation/ZoomPolicy";
import { PDFJS_POLICY } from "../../src/pdf/PdfJsPolicy";
import type { PdfViewportAnchor } from "../../src/pdf/PdfViewportAnchor";
import { type PdfLoadingTask, type PdfPage, type PdfRenderTask } from "../../src/pdf/PdfReaderController";
import { PdfTabSession, publishActivateAndAdoptPdfTab } from "../../src/pdf/PdfTabSession";
import { ResourceReservationManager } from "../../src/pdf/ResourceBudget";
import { TabWorkspace } from "../../src/core/TabWorkspace";
import { performTabClose } from "../../src/application/TabActivationCoordinator";
import "../../src/styles/app.css";

// Real PDF.js/DOM/session QA with in-memory native authority. No Tauri calls,
// user PDF paths, persistent state, native windows, or external URL activation.
// The fit-geometry matrix may delay only the PDF.js page.render task settlement. This is a QA wrapper around real PDF.js, never product timing or a test sleep.
// These layout cases pass in-memory data, not the native range/assembly path.
const unexpectedAssemblyIo = async (): Promise<never> => { throw new Error("Data-only QA must not issue native assembly I/O"); };
const dataOnlyAssembly = () => ({ reserve: unexpectedAssemblyIo, cancel: unexpectedAssemblyIo, release: unexpectedAssemblyIo, finish: async () => undefined });
const fitDelayQuery = Number(new URLSearchParams(location.search).get("fitDelay") ?? "0");
if (![0, 120].includes(fitDelayQuery)) throw new Error(`Unsupported fit render delay: ${fitDelayQuery}`);
const fitRenderDelayMilliseconds = fitDelayQuery;
const delayedPdfPages = new WeakSet<object>();
const delayPdfRenderCompletion = (task: PdfRenderTask, milliseconds: number): PdfRenderTask => {
  if (milliseconds === 0) return task;
  const promise = new Promise<void>((resolve, reject) => {
    const settle = (callback: () => void): void => { setTimeout(callback, milliseconds); };
    void task.promise.then(() => settle(resolve), (error: unknown) => settle(() => reject(error)));
  });
  return { promise, cancel: () => task.cancel() };
};
const wrapPdfPageForQaDelay = (page: PdfPage): PdfPage => {
  if (fitRenderDelayMilliseconds === 0 || delayedPdfPages.has(page)) return page;
  delayedPdfPages.add(page);
  const originalRender = page.render.bind(page);
  const mutablePage = page as PdfPage & { render: PdfPage["render"] };
  mutablePage.render = (options) => delayPdfRenderCompletion(originalRender(options), fitRenderDelayMilliseconds);
  return mutablePage;
};
const wrapPdfLoadingTaskForQaDelay = (task: PdfLoadingTask): PdfLoadingTask => {
  if (fitRenderDelayMilliseconds === 0) return task;
  const promise = task.promise.then((document) => {
    const originalGetPage = document.getPage.bind(document);
    document.getPage = async (pageNumber) => wrapPdfPageForQaDelay(await originalGetPage(pageNumber));
    return document;
  });
  const wrapped = { promise, destroy: () => task.destroy() } as PdfLoadingTask;
  Object.defineProperty(wrapped, "onPassword", {
    configurable: true,
    get: () => task.onPassword,
    set: (value: PdfLoadingTask["onPassword"]) => { task.onPassword = value; },
  });
  Object.defineProperty(wrapped, "onProgress", {
    configurable: true,
    get: () => task.onProgress,
    set: (value: PdfLoadingTask["onProgress"]) => { task.onProgress = value; },
  });
  return wrapped;
};
GlobalWorkerOptions.workerSrc = new URL(PDFJS_POLICY.assets.workerSrc, `${location.origin}/`).href;
const host = document.querySelector<HTMLElement>("#host")!;
if (new URLSearchParams(location.search).get("tall") === "true") host.style.height = "800px";
const hiddenOpening = new URLSearchParams(location.search).get("hidden") === "true";
host.hidden = hiddenOpening;
if (hiddenOpening && (host.clientWidth !== 0 || host.clientHeight !== 0)) throw new Error("Hidden opening fixture must have zero layout size");
const fixture = new URLSearchParams(location.search).get("fixture") ?? "fixture-L-text-300.pdf";
if (!["fixture-L-text-300.pdf", "print-mixed-rotation-4.pdf", "mixed-geometry-40.pdf"].includes(fixture)) throw new Error("Unsupported reader QA fixture");
const response = await fetch(`/fixtures/pdf/${fixture}`);
if (!response.ok) throw new Error(`Fixture load failed: ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
const resources = new ResourceReservationManager();
const statuses: string[] = [];
const opened = { sessionId: "headless-layout", documentGeneration: 1, length: bytes.length, displayName: fixture };
const session = new PdfTabSession({
  native: {
    assembly: dataOnlyAssembly,
    openPdfDialog: async () => opened,
    cancelSession: async () => ({ barrierId: 1 }),
    closeSession: async () => undefined,
  },
  pdf: {
    annotationMode: AnnotationMode.DISABLE,
    getDocument: (options) => wrapPdfLoadingTaskForQaDelay(getDocument({ ...options, url: undefined, range: undefined, data: bytes.slice() }) as unknown as PdfLoadingTask),
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
Object.assign(window, { readerDiagnostics: { session, statuses, resources, host } });
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
      retiredStyleTokens = [".toc-widget", ".pdf-link-hint", ".pdf-link-hints-active", ".pdf-destination-indicator"].filter((token) => stylesheetText.includes(token));
      requireInvariant(retiredStyleTokens.length === 0, `Retired reader styling remains loaded: ${retiredStyleTokens.join(", ")}`);
      linkSession = new PdfTabSession({
        native: {
          assembly: dataOnlyAssembly,
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
      const retiredSessionApi = ["toggleHints", "cancelHints", "handleHintKey", "hintsVisible", "visibleLinkCount", "linkDecorationsVisible", "dismissLinkDecorations", "indicatorPublicationPending", "linkIndicatorVisible", "dismissLinkIndicator"].filter((name) => name in linkSession);
      const retiredSnapshotFields = ["hintsVisible", "visibleLinkCount", "indicatorPublicationPending", "linkIndicatorVisible"].filter((name) => name in linkSession.snapshot.content);
      requireInvariant(retiredSessionApi.length === 0 && retiredSnapshotFields.length === 0, `Retired reader API remains: ${[...retiredSessionApi, ...retiredSnapshotFields].join(", ")}`);
      const labels = overlays.map((overlay) => overlay.getAttribute("aria-label"));
      requireInvariant(overlays.length === 4, `Expected four supported ordinary link overlays, found ${overlays.length}`);
      requireInvariant(labels.join("|") === "PDF link 1|PDF link 2|PDF link 3|PDF link 4", `Unexpected visible link order: ${labels.join(", ")}`);
      requireInvariant(overlays.every((overlay) => overlay.type === "button" && !overlay.disabled && getComputedStyle(overlay).pointerEvents === "auto"), "Ordinary PDF link overlays are not clickable buttons");
      const retiredDom = {
        tocWidgets: linkHost.querySelectorAll(".toc-widget").length,
        linkHints: linkHost.querySelectorAll(".pdf-link-hint").length,
        hintActiveLayers: linkHost.querySelectorAll(".pdf-link-hints-active").length,
        hintDataAttributes: linkHost.querySelectorAll("[data-hint-label], [data-hint-target]").length,
        destinationIndicators: linkHost.querySelectorAll(".pdf-destination-indicator").length,
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
      await frame();
      await frame();
      const destinationIndicatorsAfterClick = linkHost.querySelectorAll(".pdf-destination-indicator").length;
      requireInvariant(destinationIndicatorsAfterClick === 0, "Retired destination indicator was published after internal navigation");

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
          destinationIndicatorsAfterClick,
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
  async runLinkLanding() {
    const landingFixture = "link-landing-3-page.pdf";
    const landingResponse = await fetch(`/fixtures/pdf/${landingFixture}`);
    requireInvariant(landingResponse.ok, `Link landing fixture load failed: ${landingResponse.status}`);
    const landingBytes = new Uint8Array(await landingResponse.arrayBuffer());
    await finish();
    host.hidden = true;

    const landingHost = document.createElement("section");
    landingHost.className = "reader-surface tab-host";
    landingHost.tabIndex = 0;
    landingHost.style.cssText = "width:800px;height:600px;box-sizing:border-box";
    document.body.append(landingHost);
    const landingResources = new ResourceReservationManager();
    const landingStatuses: string[] = [];
    const landingRegistries = new Map<number, number>();
    const landingNavigations: LandingNavigation[] = [];
    const landingOpened = { sessionId: "headless-link-landing", documentGeneration: 1, length: landingBytes.length, displayName: landingFixture };
    let landingSession: PdfTabSession | undefined;
    let activeLandingRegistry: number | undefined;
    let nativeCancelCalls = 0;
    let nativeCloseCalls = 0;
    let scenario: Record<string, unknown> | undefined;
    type LandingNavigation = {
      readonly page: number;
      readonly destination: readonly unknown[];
      readonly outcome: Awaited<ReturnType<PdfTabSession["navigateToDestination"]>>;
    };
    let pendingNavigation: {
      readonly resolve: (navigation: LandingNavigation) => void;
      readonly reject: (error: unknown) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    } | undefined;
    const waitFor = async (condition: () => boolean, message: string) => {
      const deadline = performance.now() + 30_000;
      while (!condition()) {
        requireInvariant(performance.now() < deadline, `${message}: ${JSON.stringify({ page: landingSession?.snapshot.reader.page, frames: [...landingHost.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")].map((page) => page.dataset.page), statuses: landingStatuses })}`);
        await frame();
      }
    };
    const armNavigation = (): Promise<LandingNavigation> => {
      requireInvariant(pendingNavigation === undefined, "Link landing callback waiter was already armed");
      return new Promise<LandingNavigation>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingNavigation?.resolve === resolve) pendingNavigation = undefined;
          reject(new Error("Link landing navigation callback timed out"));
        }, 30_000);
        pendingNavigation = { resolve, reject, timer };
      });
    };
    const settlePendingNavigation = (pending: NonNullable<typeof pendingNavigation>, navigation?: LandingNavigation, error?: unknown): void => {
      clearTimeout(pending.timer);
      if (pendingNavigation === pending) pendingNavigation = undefined;
      if (navigation !== undefined) pending.resolve(navigation);
      else pending.reject(error ?? new Error("Link landing navigation failed"));
    };
    const dataNumber = (canvas: HTMLCanvasElement, key: "scale" | "rotation" | "naturalHeight" | "devicePixelRatio"): number => {
      const value = Number(canvas.dataset[key]);
      requireInvariant(Number.isFinite(value), `Page ${canvas.dataset.page ?? "?"} canvas has invalid data-${key}`);
      return value;
    };
    const pointGeometry = (pageNumber: number, point: { readonly x: number; readonly y: number }) => {
      const pageFrame = landingHost.querySelector<HTMLElement>(`:scope > .pdf-page-frame[data-page='${pageNumber}']`);
      requireInvariant(pageFrame !== null, `Page ${pageNumber} frame was not materialized`);
      const canvas = pageFrame!.querySelector<HTMLCanvasElement>(`:scope > canvas[data-page='${pageNumber}']`);
      requireInvariant(canvas !== null && Number(canvas.dataset.page) === pageNumber, `Page ${pageNumber} raster canvas was not materialized`);
      const scale = dataNumber(canvas!, "scale");
      const rotation = dataNumber(canvas!, "rotation");
      const naturalHeight = dataNumber(canvas!, "naturalHeight");
      requireInvariant(scale > 0 && naturalHeight > 0 && rotation === 0, `Unexpected page ${pageNumber} canvas geometry`);
      const targetDocument = {
        x: pageFrame!.offsetLeft + canvas!.offsetLeft + point.x * scale,
        y: pageFrame!.offsetTop + canvas!.offsetTop + (naturalHeight - point.y) * scale,
      };
      const midpoint = { x: landingHost.clientWidth / 2, y: landingHost.clientHeight / 2 };
      const maximumScroll = {
        x: Math.max(0, landingHost.scrollWidth - landingHost.clientWidth),
        y: Math.max(0, landingHost.scrollHeight - landingHost.clientHeight),
      };
      const desiredScroll = { x: targetDocument.x - midpoint.x, y: targetDocument.y - midpoint.y };
      const achievableScroll = {
        x: Math.min(maximumScroll.x, Math.max(0, desiredScroll.x)),
        y: Math.min(maximumScroll.y, Math.max(0, desiredScroll.y)),
      };
      const axisClamp = (desired: number, maximum: number): "start" | "end" | "none" =>
        desired < -1 ? "start" : desired > maximum + 1 ? "end" : "none";
      const clamp = { x: axisClamp(desiredScroll.x, maximumScroll.x), y: axisClamp(desiredScroll.y, maximumScroll.y) };
      const targetViewport = { x: targetDocument.x - landingHost.scrollLeft, y: targetDocument.y - landingHost.scrollTop };
      const achievableViewport = { x: targetDocument.x - achievableScroll.x, y: targetDocument.y - achievableScroll.y };
      const error = { x: Math.abs(targetViewport.x - achievableViewport.x), y: Math.abs(targetViewport.y - achievableViewport.y) };
      requireInvariant(Math.abs(landingHost.scrollLeft - achievableScroll.x) <= 1 && Math.abs(landingHost.scrollTop - achievableScroll.y) <= 1,
        `Page ${pageNumber} target did not reach its achievable scroll position: ${JSON.stringify({ desiredScroll, achievableScroll, actual: { x: landingHost.scrollLeft, y: landingHost.scrollTop } })}`);
      requireInvariant(error.x <= 1 && error.y <= 1, `Page ${pageNumber} target missed its achievable viewport point: ${JSON.stringify(error)}`);
      if (clamp.x === "none") requireInvariant(Math.abs(targetViewport.x - midpoint.x) <= 1, `Page ${pageNumber} target was not horizontally centered`);
      if (clamp.y === "none") requireInvariant(Math.abs(targetViewport.y - midpoint.y) <= 1, `Page ${pageNumber} target was not vertically centered`);
      requireInvariant(targetViewport.x >= -1 && targetViewport.x <= landingHost.clientWidth + 1
        && targetViewport.y >= -1 && targetViewport.y <= landingHost.clientHeight + 1,
      `Page ${pageNumber} target is outside viewport bounds: ${JSON.stringify(targetViewport)}`);
      return {
        point,
        canvas: { page: Number(canvas!.dataset.page), scale, rotation, naturalHeight },
        targetDocument,
        targetViewport,
        midpoint,
        viewportBounds: { left: 0, top: 0, right: landingHost.clientWidth, bottom: landingHost.clientHeight },
        desiredScroll,
        achievableScroll,
        actualScroll: { x: landingHost.scrollLeft, y: landingHost.scrollTop },
        maximumScroll,
        clamp,
        error,
      };
    };
    const assertXyzDestination = (navigation: LandingNavigation, page: number, x: number, y: number): void => {
      const mode = navigation.destination[1];
      const name = typeof mode === "object" && mode !== null && "name" in mode
        ? String((mode as { readonly name?: unknown }).name)
        : String(mode ?? "");
      requireInvariant(navigation.page === page && name === "XYZ"
        && navigation.destination[2] === x && navigation.destination[3] === y,
      `Unexpected page ${page} XYZ callback destination: ${JSON.stringify(navigation.destination)}`);
    };
    const clickLink = (label: string): Promise<LandingNavigation> => {
      const button = landingHost.querySelector<HTMLButtonElement>(`.pdf-link-overlay[aria-label='${label}']`)!;
      requireInvariant(button.isConnected && button.type === "button" && !button.disabled, `${label} is not an active annotation button`);
      const navigation = armNavigation();
      button.click();
      return navigation;
    };

    try {
      landingSession = new PdfTabSession({
        native: {
          assembly: dataOnlyAssembly,
          openPdfDialog: async () => landingOpened,
          cancelSession: async (metadata) => {
            requireInvariant(metadata.sessionId === landingOpened.sessionId, "Link landing cancellation targeted the wrong native session");
            nativeCancelCalls += 1;
            return { barrierId: 7 };
          },
          closeSession: async (metadata, barrierId) => {
            requireInvariant(metadata.sessionId === landingOpened.sessionId && barrierId === 7, "Link landing close authority was invalid");
            nativeCloseCalls += 1;
            activeLandingRegistry = undefined;
            landingRegistries.clear();
          },
        },
        pdf: {
          annotationMode: AnnotationMode.DISABLE,
          getDocument: (options) => getDocument({ ...options, url: undefined, range: undefined, data: landingBytes.slice() }) as unknown as PdfLoadingTask,
        },
        resources: landingResources,
        canvasHost: landingHost,
        createContentOptions: () => ({
          onSearchResults: () => undefined,
          requestSearchLanding: async () => { throw new Error("Search is outside the link landing scenario"); },
          navigateToPage: () => { throw new Error("Page commands are outside the link landing scenario"); },
          navigateToDestination: async (page, destination, cause, guard) => {
            const pending = pendingNavigation;
            requireInvariant(pending !== undefined, "Internal annotation navigation bypassed the awaited callback");
            if (landingSession === undefined) {
              const outcome = { kind: "rejected" as const };
              settlePendingNavigation(pending!, { page, destination: [...destination], outcome });
              return outcome;
            }
            try {
              const outcome = await landingSession.navigateToDestination(page, destination, cause, guard);
              const navigation = { page, destination: [...destination], outcome };
              landingNavigations.push(navigation);
              settlePendingNavigation(pending!, navigation);
              return outcome;
            } catch (error) {
              settlePendingNavigation(pending!, undefined, error);
              throw error;
            }
          },
          resolveDestinationPage: async (reference) => landingSession?.resolveDestinationPage(reference) ?? null,
          prepareExternalLinks: async (entries, registryRevision) => {
            requireInvariant(entries.length === 0, "Internal-only landing fixture published external link authority");
            landingRegistries.set(registryRevision, entries.length);
          },
          commitExternalLinks: async (registryRevision) => {
            requireInvariant(landingRegistries.has(registryRevision), `Landing registry ${registryRevision} committed before preparation`);
            activeLandingRegistry = registryRevision;
          },
          finalizeExternalLinks: async (registryRevision) => {
            requireInvariant(landingRegistries.has(registryRevision), `Landing registry ${registryRevision} finalized without authority`);
          },
          abortExternalLinks: async (registryRevision) => {
            landingRegistries.delete(registryRevision);
            if (activeLandingRegistry === registryRevision) activeLandingRegistry = undefined;
          },
          openExternal: async () => { throw new Error("Internal-only landing fixture attempted external activation"); },
        }),
        onStatus: (status) => { if (landingStatuses.at(-1) !== status) landingStatuses.push(status); },
      });

      await publishActivateAndAdoptPdfTab(() => undefined, landingSession, () => landingSession!.adopt(landingOpened, 1));
      await landingSession.activate();
      await waitFor(() => landingSession!.snapshot.reader.page === 1
        && landingSession!.snapshot.reader.pageCount === 3
        && landingHost.querySelectorAll<HTMLButtonElement>('.pdf-link-overlay[aria-label^="PDF link "]').length === 3,
      "Landing annotations did not publish from page one");
      requireInvariant(landingHost.clientHeight === 600, `Link landing viewport height is ${landingHost.clientHeight}, expected 600`);
      const labels = [...landingHost.querySelectorAll<HTMLButtonElement>(".pdf-link-overlay")].map((button) => button.getAttribute("aria-label"));
      requireInvariant(labels.join("|") === "PDF link 1|PDF link 2|PDF link 3", `Unexpected landing link order: ${labels.join(", ")}`);
      const page3ResidentBeforeClick = landingHost.querySelector(":scope > .pdf-page-frame[data-page='3']") !== null;
      requireInvariant(!page3ResidentBeforeClick, "Page three was already resident before the fresh-page link click");
      const retiredIndicatorApi = ["indicatorPublicationPending", "linkIndicatorVisible", "dismissLinkIndicator"].filter((name) => name in landingSession!);
      requireInvariant(retiredIndicatorApi.length === 0 && landingHost.querySelector(".pdf-destination-indicator") === null,
        `Retired destination indicator surface remains: ${retiredIndicatorApi.join(", ")}`);

      const centeredNavigation = await clickLink("PDF link 1");
      assertXyzDestination(centeredNavigation, 2, 306, 40);
      requireInvariant(centeredNavigation.outcome.kind === "verified" && centeredNavigation.page === 2,
        `Centered annotation outcome was ${centeredNavigation.outcome.kind} on page ${centeredNavigation.page}`);
      const centered = pointGeometry(2, { x: 306, y: 40 });
      requireInvariant(centered.clamp.y === "none", `Interior page-two target was unexpectedly clamped: ${centered.clamp.y}`);
      requireInvariant(landingSession.snapshot.reader.page === 2 && landingSession.canHistoryBack && !landingSession.canHistoryForward,
        "Centered link did not commit canonical page-two history");

      const page3Frame = landingHost.querySelector<HTMLElement>(":scope > .pdf-page-frame[data-page='3']");
      requireInvariant(page3Frame !== null, "Centered landing returned before page three materialized");
      const page3Canvas = page3Frame!.querySelector<HTMLCanvasElement>(":scope > canvas[data-page='3']");
      requireInvariant(page3Canvas !== null && page3Canvas.width > 0 && page3Canvas.height > 0, "Visible page three has no committed raster canvas");
      const page3Scale = dataNumber(page3Canvas!, "scale");
      const page3Rotation = dataNumber(page3Canvas!, "rotation");
      const page3NaturalHeight = dataNumber(page3Canvas!, "naturalHeight");
      const page3Dpr = dataNumber(page3Canvas!, "devicePixelRatio");
      requireInvariant(page3Rotation === 0 && page3Scale > 0 && page3NaturalHeight > 0 && page3Dpr >= 1, "Page three raster metadata is invalid");
      const page3Top = page3Frame!.offsetTop - landingHost.scrollTop;
      const page3Bottom = page3Top + page3Frame!.offsetHeight;
      requireInvariant(page3Bottom > 0 && page3Top < landingHost.clientHeight, `Page three is not visible after centered landing: ${page3Top}-${page3Bottom}`);
      const markerViewport = {
        x: page3Frame!.offsetLeft + page3Canvas!.offsetLeft + 60 * page3Scale - landingHost.scrollLeft,
        y: page3Frame!.offsetTop + page3Canvas!.offsetTop + (page3NaturalHeight - 674) * page3Scale - landingHost.scrollTop,
      };
      requireInvariant(markerViewport.x >= 0 && markerViewport.x <= landingHost.clientWidth
        && markerViewport.y >= 0 && markerViewport.y <= landingHost.clientHeight,
      `Page three raster sentinel is not visible: ${JSON.stringify(markerViewport)}`);
      const sampleX = Math.max(0, Math.min(page3Canvas!.width - 3, Math.round(60 * page3Scale * page3Dpr) - 1));
      const sampleY = Math.max(0, Math.min(page3Canvas!.height - 3, Math.round((page3NaturalHeight - 674) * page3Scale * page3Dpr) - 1));
      const rasterSample = page3Canvas!.getContext("2d")!.getImageData(sampleX, sampleY, 3, 3).data;
      const paintedPixelOffset = Array.from({ length: 9 }, (_unused, index) => index * 4).find((offset) =>
        rasterSample[offset + 3]! > 0 && (rasterSample[offset]! < 245 || rasterSample[offset + 1]! < 245 || rasterSample[offset + 2]! < 245));
      requireInvariant(paintedPixelOffset !== undefined, "Visible page-three raster sentinel contains no painted pixels");
      const paintedPixel = [...rasterSample.slice(paintedPixelOffset!, paintedPixelOffset! + 4)];
      const page3TextLayer = page3Frame!.querySelector<HTMLElement>(".pdf-page-text-layer .textLayer");
      requireInvariant(page3TextLayer !== null && page3TextLayer.childElementCount > 0
        && page3TextLayer.textContent?.includes("Link landing visible page three") === true,
      "Visible page three text layer was not published before navigation success");
      const destinationIndicatorsAfterLanding = landingHost.querySelectorAll(".pdf-destination-indicator").length;
      requireInvariant(destinationIndicatorsAfterLanding === 0, "Retired destination indicator was published for centered landing");

      const centeredBack = await landingSession.navigateHistoryBack();
      requireInvariant(centeredBack.kind === "verifiedLanding" && landingSession.snapshot.reader.page === 1 && landingSession.canHistoryForward,
        `Centered landing history back failed: ${centeredBack.kind}`);
      const centeredForward = await landingSession.navigateHistoryForward();
      requireInvariant(centeredForward.kind === "verifiedLanding" && landingSession.snapshot.reader.page === 2 && landingSession.canHistoryBack,
        `Centered landing history forward failed: ${centeredForward.kind}`);
      const returnToSource = await landingSession.navigateHistoryBack();
      requireInvariant(returnToSource.kind === "verifiedLanding" && landingSession.snapshot.reader.page === 1,
        `Could not return to source for boundary links: ${returnToSource.kind}`);

      await waitFor(() => landingHost.querySelector<HTMLButtonElement>(".pdf-link-overlay[aria-label='PDF link 3']") !== null,
        "Last-boundary annotation was not available for click");
      const lastBoundaryNavigation = await clickLink("PDF link 3");
      assertXyzDestination(lastBoundaryNavigation, 3, 306, 12);
      requireInvariant(lastBoundaryNavigation.outcome.kind === "verified" && lastBoundaryNavigation.page === 3,
        `Last-boundary annotation outcome was ${lastBoundaryNavigation.outcome.kind}`);
      const lastBoundary = pointGeometry(3, { x: 306, y: 12 });
      requireInvariant(lastBoundary.clamp.y === "end" && landingSession.canHistoryBack,
        `Last-page boundary did not clamp at the document end: ${lastBoundary.clamp.y}`);
      const lastBoundaryBack = await landingSession.navigateHistoryBack();
      requireInvariant(lastBoundaryBack.kind === "verifiedLanding" && landingSession.snapshot.reader.page === 1,
        `Last-boundary history back failed: ${lastBoundaryBack.kind}`);

      await waitFor(() => landingHost.querySelector<HTMLButtonElement>(".pdf-link-overlay[aria-label='PDF link 2']") !== null,
        "First-boundary annotation was not available for click");
      const firstBoundaryNavigation = await clickLink("PDF link 2");
      assertXyzDestination(firstBoundaryNavigation, 1, 306, 780);
      requireInvariant((firstBoundaryNavigation.outcome.kind === "verified" || firstBoundaryNavigation.outcome.kind === "same-location")
        && firstBoundaryNavigation.page === 1,
      `First-boundary annotation outcome was ${firstBoundaryNavigation.outcome.kind}`);
      const firstBoundary = pointGeometry(1, { x: 306, y: 780 });
      requireInvariant(firstBoundary.clamp.y === "start", `First-page boundary did not clamp at the document start: ${firstBoundary.clamp.y}`);
      let firstBoundaryBack: string | undefined;
      if (firstBoundaryNavigation.outcome.kind === "verified") {
        requireInvariant(landingSession.canHistoryBack, "Verified first-boundary landing did not commit history");
        const result = await landingSession.navigateHistoryBack();
        firstBoundaryBack = result.kind;
        requireInvariant(result.kind === "verifiedLanding" && landingSession.snapshot.reader.page === 1,
          `First-boundary history back failed: ${result.kind}`);
      } else {
        requireInvariant(landingSession.snapshot.reader.page === 1, "Same-location first boundary changed the active page");
      }

      scenario = {
        fixture: landingFixture,
        fixtureBytes: landingBytes.length,
        viewport: { width: landingHost.clientWidth, height: landingHost.clientHeight },
        labels,
        page3ResidentBeforeClick,
        centeredNavigation: { page: centeredNavigation.page, kind: centeredNavigation.outcome.kind },
        centered,
        page3: {
          frameTop: page3Top,
          frameBottom: page3Bottom,
          canvas: { page: Number(page3Canvas!.dataset.page), scale: page3Scale, rotation: page3Rotation, naturalHeight: page3NaturalHeight, width: page3Canvas!.width, height: page3Canvas!.height },
          markerViewport,
          paintedPixel,
          text: page3TextLayer!.textContent,
        },
        history: { centeredBack: centeredBack.kind, centeredForward: centeredForward.kind, returnToSource: returnToSource.kind },
        boundaries: {
          first: { outcome: firstBoundaryNavigation.outcome.kind, geometry: firstBoundary, historyBack: firstBoundaryBack },
          last: { outcome: lastBoundaryNavigation.outcome.kind, geometry: lastBoundary, historyBack: lastBoundaryBack.kind },
        },
        indicator: { retiredApi: retiredIndicatorApi, domCount: destinationIndicatorsAfterLanding },
        navigationCallbacks: landingNavigations.map(({ page, outcome }) => ({ page, kind: outcome.kind })),
        statuses: [...landingStatuses],
      };
    } finally {
      if (pendingNavigation !== undefined) {
        clearTimeout(pendingNavigation.timer);
        pendingNavigation = undefined;
      }
      try { await landingSession?.close(); }
      finally { landingHost.remove(); }
    }

    const settledResources = landingResources.snapshot();
    landingResources.assertEmpty();
    requireInvariant(settledResources.reservationCount === 0, `Link landing retained ${settledResources.reservationCount} resources`);
    requireInvariant(nativeCancelCalls === 1 && nativeCloseCalls === 1, `Link landing native teardown count was ${nativeCancelCalls}/${nativeCloseCalls}`);
    requireInvariant(activeLandingRegistry === undefined && landingRegistries.size === 0, "Link landing registry authority survived teardown");
    requireInvariant(scenario !== undefined, "Link landing scenario did not produce measurements");
    return {
      ...scenario!,
      teardown: { nativeCancelCalls, nativeCloseCalls, reservationCount: settledResources.reservationCount },
      disposed: true,
    };
  },
  async runChrome() {
    const raw = (await import("../../src/main.ts?raw")).default as string;
    const chooser = await import("../../src/ui/OpenChooserModel");
    const { createRecentChooserRenderer } = await import("../../src/ui/RecentChooserRenderer");
    const { createTabStripRenderer } = await import("../../src/ui/shell/TabStripRenderer");
    const { commandPaletteKeyAction } = await import("../../src/ui/CommandPaletteModel");
    const { THEMES, THEME_TOKENS, themeContrastEndpoint } = await import("../../src/domain/theme/Theme");
    const theme = THEMES.find(value => value.id === "tokyo-night")!;
    for (const token of THEME_TOKENS) document.documentElement.style.setProperty(`--theme-${token}`, theme.palette[token]);
    document.documentElement.style.setProperty("--theme-contrast", themeContrastEndpoint(theme.palette));
    const strip = document.createElement("div"); strip.className = "tab-strip"; strip.setAttribute("role", "tablist"); document.body.prepend(strip);
    const tabRenderer = createTabStripRenderer(strip, { activate: () => undefined, close: () => undefined });
    const titles = ["a.pdf", "A considerably longer research document filename.pdf", "한글 문서 이름.pdf"];
    tabRenderer.render(titles.map((title, index) => ({ id: String(index), title, selected: index === 2 })));
    const dimensions = [...strip.querySelectorAll<HTMLElement>(".workspace-tab-item")].map(item => ({ width: item.getBoundingClientRect().width, height: item.getBoundingClientRect().height }));
    requireInvariant(dimensions.every(value => Math.abs(value.height - 26) <= 0.1 && value.width >= 40 && value.width <= 184.1), "Tab geometry outside responsive bounds");
    if (strip.clientWidth >= titles.length * 184) requireInvariant(dimensions.every(value => Math.abs(value.width - 184) <= 0.1), "Unconstrained tab widths depend on filenames");
    const tabLabels = [...strip.querySelectorAll<HTMLElement>(".workspace-tab")];
    requireInvariant(tabLabels[1]!.scrollWidth > tabLabels[1]!.clientWidth, "Long tab title did not exercise ellipsis");
    const selectedTab = strip.querySelector<HTMLElement>('[aria-selected="true"]')!.getBoundingClientRect();
    const stripBounds = strip.getBoundingClientRect();
    requireInvariant(selectedTab.left >= stripBounds.left - 1 && selectedTab.right <= stripBounds.right + 1, "Selected tab clipped outside strip");
    const markup = raw.match(/<dialog id="file-opener-dialog"[\s\S]*?<\/dialog>/u)?.[0];
    requireInvariant(markup !== undefined, "Chooser markup unavailable");
    document.body.insertAdjacentHTML("beforeend", markup!);
    const dialog = document.querySelector<HTMLDialogElement>("#file-opener-dialog")!;
    const list = dialog.querySelector<HTMLElement>("#file-opener-list")!;
    const input = dialog.querySelector<HTMLInputElement>("input")!;
    const directoryEntry = { recentId: "qa-directory", displayName: "research-report.pdf", displayPath: `C:\\Research\\${"Long directory\\".repeat(18)}research-report.pdf` };
    const longName = `${"긴보고서".repeat(30)}.pdf`;
    const filenameEntry = { recentId: "qa-filename", displayName: longName, displayPath: `\\\\qa.example.invalid\\share$\\Documents\\${longName}` };
    const resizeEntry = { recentId: "qa-resize", displayName: "moderately-long-filename-for-resize-check.pdf", displayPath: "E:\\QA\\moderately-long-filename-for-resize-check.pdf" };
    const entries = [directoryEntry, filenameEntry, resizeEntry, ...Array.from({ length: 12 }, (_, index) => ({ recentId: `qa-${index}`, displayName: `Generated-report-${index}.pdf`, displayPath: `\\\\qa.example.invalid\\share$\\${"generated-folder\\".repeat(10)}Generated-report-${index}.pdf` }))];
    const aliases = new Map([[filenameEntry.recentId, `V:\\Documents\\${longName}`]]);
    let model = chooser.createOpenChooser({ tag: "READY", snapshot: { revision: "1", entries: [] } });
    const activated: string[] = [];
    const renderer = createRecentChooserRenderer(list, index => {
      model = chooser.selectChooserIndex(model, index);
      const row = chooser.chooserRows(model)[index];
      if (row?.kind === "recent") activated.push(row.recentId);
    });
    const render = () => renderer.render(chooser.chooserRows(model), model.activeIndex, undefined, aliases);
    const onKey = (event: KeyboardEvent) => {
      const action = commandPaletteKeyAction(event);
      if (action !== "next" && action !== "previous") return;
      event.preventDefault(); model = chooser.moveChooserSelection(model, action === "next" ? 1 : -1); render();
    };
    dialog.addEventListener("keydown", onKey);
    const settle = async () => { await frame(); await frame(); await frame(); };
    const samples: unknown[] = [];
    const verify = (label: string) => {
      requireInvariant(list.scrollWidth <= list.clientWidth, `History horizontal overflow at ${label}: ${list.scrollWidth}/${list.clientWidth}`);
      for (const button of list.querySelectorAll<HTMLButtonElement>(".file-opener-recent")) {
        const path = button.querySelector<HTMLElement>(".file-opener-recent-path")!;
        const style = getComputedStyle(button);
        const available = button.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
        requireInvariant(style.fontSize === "13px" && button.style.fontSize === "", "History font was shrunk");
        requireInvariant(path.getBoundingClientRect().width <= available + 1, `Hidden clipping is not a fitting solution: ${label}`);
        requireInvariant(path.textContent!.endsWith(".pdf"), "PDF extension lost in fitted row");
      }
      samples.push({ label, width: list.clientWidth, scrollWidth: list.scrollWidth, height: list.clientHeight, selected: model.activeIndex });
    };
    try {
      render(); requireInvariant(list.querySelector(".file-opener-recents-heading") === null, "Empty history has an orphan heading");
      dialog.style.width = "270px"; dialog.showModal();
      model = chooser.createOpenChooser({ tag: "READY", snapshot: { revision: "1", entries } }); render(); await settle(); verify("narrow");
      const buttonFor = (entry: typeof entries[number]) => [...list.querySelectorAll<HTMLButtonElement>(".file-opener-recent")].find(button => button.title === entry.displayPath)!;
      const narrowText = buttonFor(resizeEntry).textContent!;
      requireInvariant(narrowText.includes("…"), "Narrow filename did not exercise truncation");
      requireInvariant(buttonFor(filenameEntry).textContent!.startsWith("V:"), "Mapped letter not displayed");
      requireInvariant(buttonFor(filenameEntry).title === filenameEntry.displayPath, "Canonical tooltip lost");
      requireInvariant(buttonFor(filenameEntry).getAttribute("aria-label") === aliases.get(filenameEntry.recentId), "Full display alias is inaccessible");
      const browse = list.querySelector<HTMLElement>(".file-opener-browse")!;
      const heading = list.querySelector<HTMLElement>(".file-opener-recents-heading")!;
      requireInvariant(browse.childElementCount === 0 && browse.textContent === "Browse...", "Browse glyph was not removed");
      const browseStyle = getComputedStyle(browse);
      requireInvariant([browseStyle.borderTopWidth, browseStyle.borderRightWidth, browseStyle.borderBottomWidth, browseStyle.borderLeftWidth].every(value => Number.parseFloat(value) === 0), "Browse retained a border");
      browse.focus(); await frame();
      requireInvariant(Number.parseFloat(getComputedStyle(browse).outlineWidth) >= 2, "Browse keyboard focus outline missing");
      requireInvariant(Number.parseFloat(getComputedStyle(heading).borderTopWidth) >= 1, "Recent divider missing");
      if (matchMedia("(forced-colors: active)").matches) requireInvariant([...dialog.querySelectorAll("kbd")].every(key => getComputedStyle(key).color === getComputedStyle(heading).color), "Forced-color hints lost CanvasText");
      const original = [...list.querySelectorAll("button")];
      const text = original.map(button => button.textContent);
      input.focus({ preventScroll: true });
      const height = list.clientHeight;
      for (let index = 0; index < 24; index += 1) {
        dialog.dispatchEvent(new KeyboardEvent("keydown", { key: index < 16 ? "j" : "k", ctrlKey: true, bubbles: true }));
        verify(`key-${index}`); await frame(); verify(`paint-${index}`);
        requireInvariant(original.every((button, position) => list.querySelectorAll("button")[position] === button && button.textContent === text[position]), "Selection rebuilt or refitted existing rows");
        requireInvariant(list.clientHeight === height, "Selection changed history viewport height");
      }
      buttonFor(filenameEntry).click();
      requireInvariant(activated.at(-1) === filenameEntry.recentId, "Display path became opening authority");
      dialog.style.removeProperty("width"); await settle(); verify("wide");
      requireInvariant(buttonFor(resizeEntry).textContent!.length >= narrowText.length, "Wider viewport did not restore text context");
      if (innerWidth >= 800) requireInvariant(buttonFor(resizeEntry).textContent === resizeEntry.displayPath, "Wider viewport failed to restore full path");
      const bounds = dialog.getBoundingClientRect();
      requireInvariant(bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.top >= 0 && bounds.bottom <= innerHeight + 1, "History exceeds viewport");
      return { dimensions, samples, dpr: devicePixelRatio, activated, mappedDisplay: buttonFor(filenameEntry).textContent, fixedFont: getComputedStyle(buttonFor(filenameEntry)).fontSize, syntheticKeyboard: true };
    } finally { dialog.removeEventListener("keydown", onKey); renderer.stop(); dialog.close(); dialog.remove(); strip.remove(); await finish(); }
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
      native: { assembly: dataOnlyAssembly, openPdfDialog: async () => opened, cancelSession: async () => ({ barrierId: 1 }), closeSession: async () => undefined },
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
  async runLazyGeometry(mode: "continuous-fit" | "custom") {
    requireInvariant(fixture === "mixed-geometry-40.pdf", "Lazy geometry needs the long mixed fixture");
    const state = session as unknown as { pendingPresentationRenders: number; presentationSettlements: number;
      pdfReader: { viewportSettlement?: unknown; current: { residentRasters: Map<number, { viewport: { convertToViewportPoint(x: number, y: number): readonly [number, number] } }> };
        capturePointerAnchor(offset: { x: number; y: number }): { pageNumber: number; pagePoint: { x: number; y: number }; viewportOffset: { x: number; y: number } } | undefined;
        captureVisibleScrollAnchor?: () => PdfViewportAnchor | undefined;
        applyWindowSpacers: (...args: unknown[]) => void;
      } };
    const controller = state.pdfReader;
    const code = await (await fetch("/src/main.ts")).text();
    const start = code.indexOf("let viewportFrameRequest"), end = code.indexOf("let readerResizeFrame", start);
    requireInvariant(start >= 0 && end > start, "Production viewport scheduler missing");
    const failures: string[] = [];
    const dispose = new Function("host", "session", "active", "reportPresentationFailure", "rootKeyboard", "render", "cancelLinkHints",
      code.slice(start, end) + ';return ()=>{viewportDisposed=true;host.removeEventListener("scroll",onReaderScroll);if(viewportFrameRequest!==undefined)cancelAnimationFrame(viewportFrameRequest);};')(
      host, session, () => ({ session }), (_session: unknown, error: unknown) => failures.push(String(error)), { syncContext() {} }, () => undefined, () => undefined,
    ) as () => void;
    const observed = new Set<number>();
    const shifts: { page: number; dx: number; dy: number; beforeWidth: number; afterWidth: number }[] = [];
    const samples: unknown[] = [];
    const originalLayout = controller.applyWindowSpacers;
    controller.applyWindowSpacers = function (...args) {
      const anchor = this.captureVisibleScrollAnchor?.() ?? this.capturePointerAnchor({ x: host.clientWidth / 2, y: host.clientHeight / 2 });
      const canvas = anchor === undefined ? null : host.querySelector<HTMLCanvasElement>(`.pdf-page-frame[data-page="${anchor.pageNumber}"] canvas`);
      const raster = anchor === undefined ? undefined : this.current.residentRasters.get(anchor.pageNumber);
      const measured = anchor !== undefined && observed.has(anchor.pageNumber) && canvas !== null && raster !== undefined
        && anchor.viewportOffset.x > 0 && anchor.viewportOffset.x < host.clientWidth && anchor.viewportOffset.y > 0 && anchor.viewportOffset.y < host.clientHeight;
      const point = measured ? raster!.viewport.convertToViewportPoint(anchor!.pagePoint.x, anchor!.pagePoint.y) : undefined;
      const before = canvas?.getBoundingClientRect();
      const beforeWidth = host.scrollWidth;
      originalLayout.apply(this, args);
      if (point !== undefined && before !== undefined && canvas !== null) queueMicrotask(() => {
        if (!canvas.isConnected) return;
        const after = canvas.getBoundingClientRect();
        shifts.push({ page: anchor!.pageNumber, dx: after.left + point[0] - (before.left + point[0]), dy: after.top + point[1] - (before.top + point[1]), beforeWidth, afterWidth: host.scrollWidth });
      });
    };
    const settle = async () => {
      let previous = "", stable = 0;
      for (let index = 0; index < 400; index += 1) {
        await frame();
        for (const canvas of host.querySelectorAll<HTMLCanvasElement>("canvas")) observed.add(Number(canvas.dataset.page));
        const key = JSON.stringify({ ...snapshot(), left: host.scrollLeft, width: host.scrollWidth, clientHeight: host.clientHeight });
        stable = !state.pendingPresentationRenders && !state.presentationSettlements && !controller.viewportSettlement && resources.snapshot().totals.render === 0 && key === previous ? stable + 1 : 0;
        previous = key;
        if (stable >= 4) return;
      }
      throw new Error("Lazy viewport did not settle");
    };
    try {
      if (mode === "custom") requireInvariant(await session.requestKeyboardView({ type: "view.zoom", factor: 1 }), "Custom-mode setup failed");
      await settle();
      const scale = session.snapshot.reader.customScale;
      const initialWidth = host.scrollWidth;
      let sawWidePage = false;
      for (let step = 0; step < 30; step += 1) {
        host.scrollTop += host.clientHeight * 0.45;
        await settle();
        const sample = { step, ...snapshot(), width: host.scrollWidth, clientHeight: host.clientHeight, left: host.scrollLeft };
        samples.push(sample);
        requireInvariant(Math.abs(sample.scale - scale) < 1e-10, `Passive geometry changed fit scale: ${JSON.stringify({ expected: scale, sample })}`);
        const jump = shifts.find(value => Math.abs(value.dx) > 1 + 1e-6 || Math.abs(value.dy) > 1 + 1e-6);
        requireInvariant(jump === undefined, `Lazy layout moved the visible PDF point: ${JSON.stringify(jump)}`);
        if (host.scrollWidth > initialWidth + 1) { sawWidePage = true; break; }
      }
      requireInvariant(sawWidePage, "Stress fixture did not discover a wider overscan page");
      requireInvariant(failures.length === 0, `Viewport failures: ${JSON.stringify(failures)}`);
      return { mode, dpr: devicePixelRatio, delayMilliseconds: fitRenderDelayMilliseconds, initialWidth, samples, shifts, failures };
    } finally { controller.applyWindowSpacers = originalLayout; dispose(); await finish(); }
  },
  async runKeyboardView() {
    const samples: { label: string; requested: number; committed: number; raster: number }[] = [];
    const sample = (label: string) => {
      const committed = session.committedPresentation;
      const canvas = host.querySelector<HTMLCanvasElement>('.pdf-page-frame[data-active-page="true"] canvas');
      requireInvariant(committed !== undefined && canvas !== null, "Keyboard view requires committed presentation");
      const value = { label, requested: session.snapshot.reader.customScale, committed: committed!.customScale, raster: Number(canvas!.dataset.scale) };
      requireInvariant(Math.abs(value.committed - value.raster) < 1e-10, `Badge projection led the raster: ${JSON.stringify(value)}`);
      samples.push(value);
      return value;
    };
    try {
      requireInvariant((await session.navigatePagePrompt(3)).kind === "verifiedLanding", "Keyboard fixture navigation failed");
      requireInvariant(await session.requestKeyboardView({ type: "view.actualSize" }), "Actual-size setup failed");
      requireInvariant(await session.requestKeyboardView({ type: "view.zoom", factor: 2 }), "200% setup failed");
      const padding = getComputedStyle(host);
      const availableWidth = host.clientWidth - Number.parseFloat(padding.paddingLeft) - Number.parseFloat(padding.paddingRight);
      const naturalWidth = Number(host.querySelector<HTMLCanvasElement>('.pdf-page-frame[data-active-page="true"] canvas')?.dataset.naturalWidth);
      requireInvariant(Number.isFinite(naturalWidth) && naturalWidth > 0, "Missing fitted reference width");
      const expectedFit = clampReaderScale(availableWidth / naturalWidth);
      const fitting = session.requestKeyboardView({ type: "view.fitWidth" });
      const zooming = session.requestKeyboardView({ type: "view.zoom", factor: 1 / 1.1 });
      requireInvariant(fitting === zooming, "Queued relative zoom must share one owner settlement");
      sample("fit-minus-requested");
      requireInvariant(await zooming, "Fit-minus composition failed");
      const composed = sample("fit-minus-committed");
      requireInvariant(Math.abs(composed.committed - clampReaderScale(expectedFit / 1.1)) < 1e-10,
        `Minus used pre-fit scale: ${JSON.stringify({ expectedFit, composed })}`);
      requireInvariant(await session.requestKeyboardView({ type: "view.fitWidth" }), "Burst fit setup failed");
      const before = sample("burst-start").committed;
      let expected = before;
      let pending: Promise<boolean> | undefined;
      let progressedDuringInput = false;
      for (let index = 0; index < 12; index += 1) {
        expected = clampReaderScale(expected / 1.1);
        pending = session.requestKeyboardView({ type: "view.zoom", factor: 1 / 1.1 });
        const observed = sample(`minus-${index}`);
        if (index < 11 && observed.committed < before) progressedDuringInput = true;
        await new Promise<void>(resolve => setTimeout(resolve, 120));
      }
      requireInvariant(pending !== undefined && await pending, "Keyboard burst did not settle successfully");
      const after = sample("burst-settled");
      requireInvariant(progressedDuringInput, "Keyboard producer starved all intermediate commits");
      requireInvariant(Math.abs(after.committed - expected) < 1e-10, `Queued steps lost intent: ${JSON.stringify({ after, expected })}`);
      return { delayMilliseconds: fitRenderDelayMilliseconds, dpr: devicePixelRatio, samples, progressedDuringInput, expected, statuses: [...statuses] };
    } finally { await finish(); }
  },
  async runFitPageEdge() {
    try {
      requireInvariant(fixture === "print-mixed-rotation-4.pdf" && host.clientHeight === 800, "Edge fixture requires an 800px-tall host");
      const initialLanding = await session.navigatePagePrompt(3);
      requireInvariant(initialLanding.kind === "verifiedLanding", `Could not establish narrow reference page: ${JSON.stringify({ initialLanding, snapshot: snapshot(), statuses })}`);
      session.apply({ type: "view.fitPage" });
      requireInvariant(await session.renderCurrentView(), "Fit Page setup failed");
      const before = snapshot();
      const reference = session.snapshot.reader.fitPageReference;
      const outcome = await session.navigateAdjacentPage(1);
      const after = snapshot();
      requireInvariant(outcome.kind === "verifiedLanding", `Wide target must land at its browser-reachable edge: ${JSON.stringify({ outcome, before, after, width: host.clientWidth, scrollWidth: host.scrollWidth, left: host.scrollLeft })}`);
      requireInvariant(after.page === 4 && after.mode === "fit-page" && after.scale === before.scale && session.snapshot.reader.fitPageReference === reference,
        `Edge navigation changed fixed fit reference: ${JSON.stringify({ before, after, reference })}`);
      requireInvariant((await session.navigateAdjacentPage(-1)).kind === "verifiedLanding", "Reverse edge navigation failed");
      requireInvariant(session.snapshot.reader.page === 3, "Reverse edge navigation missed the reference page");
      return { before, after, outcome, reference, dpr: devicePixelRatio, statuses: [...statuses] };
    } finally { await finish(); }
  },
  async runFitGeometry(mode: "fit-width" | "fit-page") {
    const state = session as unknown as {
      pendingPresentationRenders: number; presentationSettlements: number; wheelSettlement?: unknown;
      activityGeneration: number; renderIntent: number; viewportIntent: number;
      pdfReader: { presentationTopology: string; viewportSettlement?: unknown;
        getPageNaturalSize(page: number, rotation: number): Promise<{ width: number; height: number } | undefined> };
    };
    const controller = state.pdfReader;
    const code = await (await fetch("/src/main.ts")).text();
    const start = code.indexOf("let viewportFrameRequest"), end = code.indexOf("let readerResizeFrame", start);
    requireInvariant(start >= 0 && end > start, "Production scroll scheduler missing");
    const failures: string[] = [];
    const dispose = new Function("host", "session", "active", "reportPresentationFailure", "rootKeyboard", "render", "cancelLinkHints",
      code.slice(start, end) + ';return ()=>{viewportDisposed=true;host.removeEventListener("scroll",onReaderScroll);if(viewportFrameRequest!==undefined)cancelAnimationFrame(viewportFrameRequest);};')(
      host, session, () => ({ session }), (_session: unknown, error: unknown) => failures.push(String(error)), { syncContext() {} }, () => undefined, () => undefined,
    ) as () => void;
    const samples: unknown[] = [];
    const take = () => {
      const reader = session.snapshot.reader;
      const canvas = host.querySelector<HTMLCanvasElement>('.pdf-page-frame[data-active-page="true"] canvas');
      return { page: reader.page, mode: reader.zoomMode, scale: reader.customScale, reference: reader.fitPageReference,
        documentGeneration: reader.documentGeneration, activityGeneration: state.activityGeneration, renderIntent: state.renderIntent, viewportIntent: state.viewportIntent,
        topology: controller.presentationTopology, renderedScale: canvas === null ? null : Number(canvas.dataset.scale),
        width: host.clientWidth, height: host.clientHeight, scrollWidth: host.scrollWidth, scrollHeight: host.scrollHeight, top: host.scrollTop,
        pending: state.pendingPresentationRenders + state.presentationSettlements + Number(state.wheelSettlement !== undefined) + Number(controller.viewportSettlement !== undefined),
        renders: resources.snapshot().totals.render };
    };
    const settle = async (label: string, expectedScale?: number) => {
      let previous = "", stable = 0;
      const trace: ReturnType<typeof take>[] = [];
      for (let index = 0; index < 300; index += 1) {
        await frame();
        const value = take();
        trace.push(value);
        if (expectedScale !== undefined && Math.abs(value.scale - expectedScale) > 1e-10) {
          throw new Error(`First passive fit-width divergence: ${JSON.stringify({ label, expectedScale, trace })}`);
        }
        const key = JSON.stringify(value);
        stable = value.pending === 0 && value.renders === 0 && key === previous ? stable + 1 : 0;
        previous = key;
        if (stable >= 3) { samples.push({ label, frames: trace.length, settled: value }); return value; }
      }
      throw new Error(`Fit geometry did not settle: ${JSON.stringify({ label, trace, failures })}`);
    };
    const apply = async (action: Parameters<typeof session.apply>[0], label: string) => {
      session.apply(action);
      requireInvariant(await session.renderCurrentView(), `${label} render failed`);
      return settle(label);
    };
    const assertFinalFit = async (label: string) => {
      const fitted = await apply({ type: "view.fitPage" }, label);
      const reader = session.snapshot.reader;
      const natural = await controller.getPageNaturalSize(reader.fitPageReference!, reader.rotationQuarterTurns * 90);
      requireInvariant(natural !== undefined, "Missing fit reference natural size");
      const style = getComputedStyle(host), pad = (value: string) => Number.parseFloat(value) || 0;
      const width = host.clientWidth - pad(style.paddingLeft) - pad(style.paddingRight);
      const height = host.clientHeight - pad(style.paddingTop) - pad(style.paddingBottom);
      const expected = clampReaderScale(Math.min(width / natural!.width, height / natural!.height));
      requireInvariant(fitted.mode === "fit-page" && fitted.topology === "single-page" && host.querySelectorAll("canvas").length === 1,
        `Fit mode/topology mismatch: ${JSON.stringify(fitted)}`);
      requireInvariant(Math.abs(fitted.scale - expected) < 1e-10 && fitted.renderedScale !== null && Math.abs(fitted.renderedScale - expected) < 1e-10,
        `First final fit-page divergence: ${JSON.stringify({ fitted, natural, expected })}`);
      samples.push({ label: `${label}-verified`, expected, fitted });
    };
    try {
      const target = fixture === "print-mixed-rotation-4.pdf" ? 3 : 26;
      requireInvariant((await session.navigatePagePrompt(target)).kind === "verifiedLanding", "Fit fixture navigation failed");
      await settle("navigation");
      const fittedWidth = await apply({ type: "view.fitWidth" }, "fit-width");
      requireInvariant(fittedWidth.mode === "fit-width" && fittedWidth.topology === "continuous", "Fit Width mode/topology mismatch");
      if (mode === "fit-width") {
        const top = host.scrollTop;
        for (const offset of [-0.4, -0.8, 0.4, 0]) {
          host.scrollTop = top + offset * host.clientHeight;
          await settle(`boundary-${offset}`, fittedWidth.scale);
        }
        await new Promise<void>(resolve => setTimeout(resolve, 1500));
        await settle("idle-boundary", fittedWidth.scale);
      } else {
        if (fixture === "print-mixed-rotation-4.pdf") requireInvariant(host.scrollWidth > host.clientWidth, "Mixed fixture did not produce the pre-F horizontal scrollbar");
        await assertFinalFit("initial-final-fit");
        for (let repeat = 0; repeat < 2; repeat += 1) {
          await apply({ type: "view.fitWidth" }, `repeat-width-${repeat}`);
          await assertFinalFit(`repeat-page-${repeat}`);
        }
      }
      await apply({ type: "view.zoom", factor: 1.1 }, "zoom");
      await apply({ type: "view.rotate", quarterTurns: 1 }, "rotation");
      host.style.height = "480px";
      session.invalidateViewportSynchronization();
      requireInvariant(await session.renderCurrentView(), "Resize render failed");
      await settle("resize");
      await apply({ type: "view.fitWidth" }, "resized-width");
      if (mode === "fit-page") await assertFinalFit("resized-page");
      await session.deactivate();
      session.evictInactiveHeavyResources();
      await session.activate();
      await settle("reactivated");
      requireInvariant(session.snapshot.active, "Tab did not reactivate");
      requireInvariant(failures.length === 0, `Scheduler failures: ${JSON.stringify(failures)}`);
      return { fixture, mode, delayMilliseconds: fitRenderDelayMilliseconds, dpr: devicePixelRatio, samples, failures, statuses: [...statuses] };
    } finally { dispose(); await finish(); }
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
