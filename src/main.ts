import "./styles/app.css";
import { KeySequenceEngine, type SequenceResult } from "./core/KeySequenceEngine";
import { ReaderState, type ReaderSnapshot } from "./core/ReaderState";
import {
  createKeyboardAdapter,
  getPromptKeyAction,
  isNativeKeyboardCompositionOrModifierEvent,
  isNativeOwnedKeyboardEvent,
  isNativeOwnedTarget,
  type KeyboardAdapter,
} from "./platform/keyboardAdapter";
import { buildHelpRows } from "./ui/HelpModel";
import { invoke } from "@tauri-apps/api/core";
import { AnnotationMode, getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { PDFJS_POLICY } from "./pdf/PdfJsPolicy";
import { PdfReaderController, type OpenPdfResult, type PdfLoadingTask, type PdfViewTransform } from "./pdf/PdfReaderController";
import { RESOURCE_LIMITS, ResourceReservationManager } from "./pdf/ResourceBudget";
import { PdfContentController, normalizePdfSearchQuery } from "./pdf/PdfContentController";
import { pdfDestinationNeedsPageSize, resolvePdfDestinationView } from "./pdf/PdfDestination";

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

const root = requireElement<HTMLElement>("#app");

const reader = new ReaderState();
const engine = new KeySequenceEngine();

root.innerHTML = `
  <section class="app-shell" aria-label="Modeleaf PDF reader">
    <header class="titlebar">
      <h1>Modeleaf</h1>
      <span class="platform-badge">Windows foundation</span>
    </header>
    <section id="reader-surface" class="reader-surface" aria-label="PDF reading surface" tabindex="-1">
      <div class="empty-state">
        <strong>Keyboard-first PDF reading for Windows</strong>
        <p>Press <kbd>Ctrl</kbd>+<kbd>O</kbd> to open a local PDF or <kbd>?</kbd> for shortcuts.</p>
      </div>
    </section>
    <section id="prompt" class="prompt" aria-live="polite" hidden></section>
    <dialog id="help-dialog" aria-labelledby="help-title">
      <header><h2 id="help-title">Keyboard shortcuts</h2></header>
      <dl id="help-rows"></dl>
      <p class="dialog-hint">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close.</p>
      <p class="dialog-hint">PDF keyboard range selection, reading-order remediation, and OCR for scanned pages are unavailable.</p>
    </dialog>
    <dialog id="password-dialog" aria-labelledby="password-title">
      <form method="dialog" autocomplete="off">
        <h2 id="password-title">PDF password required</h2>
        <label>Password <input id="password-input" type="password" autocomplete="off" data-form-type="other" spellcheck="false"></label>
        <menu><button value="cancel">Cancel</button><button value="submit">Open</button></menu>
      </form>
    </dialog>
    <dialog id="search-dialog" aria-labelledby="search-title">
      <form id="search-form" autocomplete="off">
        <h2 id="search-title">Search PDF text</h2>
        <label>Literal text <input id="search-input" type="search" spellcheck="false"></label>
        <p class="dialog-hint">Press <kbd>Enter</kbd> or <kbd>Shift</kbd>+<kbd>Enter</kbd> to cycle matches. Press <kbd>Esc</kbd> to close.</p>
      </form>
    </dialog>
    <footer id="status" class="statusbar" role="status" aria-live="polite"></footer>
  </section>
`;

const status = requireElement<HTMLElement>("#status");
const prompt = requireElement<HTMLElement>("#prompt");
const helpDialog = requireElement<HTMLDialogElement>("#help-dialog");
const helpRows = requireElement<HTMLElement>("#help-rows");
const canvasHost = requireElement<HTMLElement>("#reader-surface");
const passwordDialog = requireElement<HTMLDialogElement>("#password-dialog");
const passwordInput = requireElement<HTMLInputElement>("#password-input");
const searchDialog = requireElement<HTMLDialogElement>("#search-dialog");
const searchForm = requireElement<HTMLFormElement>("#search-form");
const searchInput = requireElement<HTMLInputElement>("#search-input");

for (const row of buildHelpRows()) {
  const term = document.createElement("dt");
  term.textContent = row.shortcut;
  const description = document.createElement("dd");
  description.textContent = row.label;
  helpRows.append(term, description);
}
GlobalWorkerOptions.workerSrc = PDFJS_POLICY.assets.workerSrc;

let ownerGeneration = 0;
const native = {
  openPdfDialog: (request: { readonly ownerGeneration: number }) =>
    invoke<OpenPdfResult | null>("open_pdf_dialog", { ownerGeneration: request.ownerGeneration }),
  readRange: async (request: { readonly sessionId: string; readonly documentGeneration: number; readonly requestId: string; readonly offset: number; readonly length: number }, _signal: AbortSignal, sessionOwnerGeneration: number) => {
    const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>("read_pdf_range", { ...request, ownerGeneration: sessionOwnerGeneration });
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  },
  cancelSession: (session: { readonly sessionId: string; readonly documentGeneration: number }, sessionOwnerGeneration: number) =>
    invoke<{ readonly barrierId: number }>("cancel_pdf_session", { ...session, ownerGeneration: sessionOwnerGeneration }),
  closeSession: (session: { readonly sessionId: string; readonly documentGeneration: number }, barrierId: number, sessionOwnerGeneration: number) =>
    invoke<void>("close_pdf_session", { ...session, ownerGeneration: sessionOwnerGeneration, barrierId }),
};

function requestPassword(reason: "need" | "incorrect"): Promise<string | null> {
  passwordInput.value = "";
  passwordInput.placeholder = reason === "incorrect" ? "Incorrect password" : "";
  passwordDialog.returnValue = "cancel";
  passwordDialog.showModal();
  passwordInput.focus();
  return new Promise((resolve) => {
    passwordDialog.addEventListener("close", () => {
      const password = passwordDialog.returnValue === "submit" ? passwordInput.value : null;
      passwordInput.value = "";
      resolve(password);
    }, { once: true });
  });
}

const resources = new ResourceReservationManager();
let content: PdfContentController;
let searchInvocation = 0;
let searchQuery = "";
let renderInvocation = 0;
let navigationInvocation = 0;
type CommittedReaderToken = {
  readonly documentGeneration: number;
  readonly page: number;
  readonly zoomMode: ReaderSnapshot["zoomMode"];
  readonly customScale: number;
  readonly rotationQuarterTurns: number;
};
let committedReaderToken: CommittedReaderToken | undefined;
type LinkSession = {
  readonly sessionId: string;
  readonly documentGeneration: number;
  readonly ownerGeneration: number;
};
let activeLinkSession: LinkSession | undefined;
let openingContent: { readonly controller: PdfContentController; readonly linkSession: LinkSession } | undefined;
type ContentTeardown = {
  readonly controller: PdfContentController;
  settlement?: Promise<void>;
};
const contentTeardowns = new Map<string, ContentTeardown>();

function beginContentTeardown(controller: PdfContentController, sessionId: string | undefined): Promise<void> {
  if (sessionId === undefined) return controller.unmount();
  let retained = contentTeardowns.get(sessionId);
  if (retained === undefined) {
    retained = { controller };
    contentTeardowns.set(sessionId, retained);
  }
  const owner = retained;
  if (owner.settlement !== undefined) return owner.settlement;
  const settlement = Promise.resolve().then(() => owner.controller.unmount());
  owner.settlement = settlement;
  void settlement.then(
    () => {
      if (contentTeardowns.get(sessionId) === owner && owner.settlement === settlement) {
        contentTeardowns.delete(sessionId);
      }
    },
    () => {
      if (contentTeardowns.get(sessionId) === owner && owner.settlement === settlement) {
        delete owner.settlement;
      }
    },
  );
  return settlement;
}
function createContentTeardown(controller: PdfContentController, linkSession: LinkSession): () => Promise<void> {
  return () => beginContentTeardown(controller, linkSession.sessionId);
}
const pdfReader = new PdfReaderController({
  native,
  pdf: { getDocument: (options) => getDocument(options as never) as unknown as PdfLoadingTask, annotationMode: AnnotationMode.DISABLE },
  resources,
  canvasHost,
  onCommitted: (pageCount, displayName, _document, openedSession) => {
    const staged = openingContent;
    if (staged === undefined || staged.linkSession.sessionId !== openedSession.sessionId) return;
    openingContent = undefined;
    const priorContent = content;
    const priorSession = activeLinkSession;
    content = staged.controller;
    activeLinkSession = staged.linkSession;
    void beginContentTeardown(priorContent, priorSession?.sessionId);
    try {
      reader.mountDocument(pageCount);
      const openedView = reader.snapshot;
      const fitIntent = tokenFromSnapshot(openedView);
      const invocation = ++renderInvocation;
      const navigationOwner = ++navigationInvocation;
      const requestCommitGuard = (): boolean => (
        invocation === renderInvocation
        && navigationOwner === navigationInvocation
        && reader.snapshot.documentGeneration === openedView.documentGeneration
      );
      void applyCurrentViewTransform(openedView, requestCommitGuard).then((rendered) => {
        if (!requestCommitGuard()) return;
        if (rendered) {
          publishCommittedReaderToken(fitIntent);
          return;
        }
        const failureStatus = reader.snapshot.status;
        restoreCommittedReaderView(openedView.documentGeneration);
        reader.setStatus(failureStatus);
        render();
      }).catch(() => undefined);
      if (searchDialog.open) searchDialog.close();
      reader.setStatus(`${displayName} — ${reader.snapshot.status}`);
      keyboard.syncContext();
      render();
    } catch {
      // The reader commit is durable even when UI reporting fails.
    }
  },
  onBeforeCommit: async ({ pageNumber, page, viewport, canvas }, commitCanvas, context) => {
    if (context.opening) {
      const linkSession: LinkSession = {
        sessionId: context.session.sessionId,
        documentGeneration: context.session.documentGeneration,
        ownerGeneration: context.ownerGeneration,
      };
      const staged = createContentController(linkSession);
      const teardown = createContentTeardown(staged, linkSession);
      context.registerStagedTeardown(teardown);
      staged.mount(context.document, reader.snapshot.documentGeneration + 1, context.session.sessionId);
      let committed = false;
      openingContent = { controller: staged, linkSession };
      const commitOpeningCanvas = (accessory?: HTMLElement): boolean => {
        committed = commitCanvas(accessory);
        return committed;
      };
      try {
        await staged.renderPage({
          pageNumber,
          page,
          viewport,
          canvas,
          commitCanvas: commitOpeningCanvas,
        });
        if (!committed) {
          if (openingContent?.controller === staged) openingContent = undefined;
          void teardown();
        }
      } catch (error) {
        if (!committed) {
          if (openingContent?.controller === staged) openingContent = undefined;
          void teardown();
        }
        throw error;
      }
      return;
    }
    await content.renderPage({ pageNumber, page, viewport, canvas, commitCanvas });
  },
  onBeforeDispose: async (session) => {
    if (activeLinkSession?.sessionId === session.sessionId) {
      await beginContentTeardown(content, activeLinkSession.sessionId);
      return;
    }
    const retained = contentTeardowns.get(session.sessionId);
    if (retained !== undefined) await beginContentTeardown(retained.controller, session.sessionId);
  },
  onPage: (page, transform) => {
    const snapshot = reader.snapshot;
    committedReaderToken = {
      ...tokenFromSnapshot(snapshot),
      page,
      customScale: transform.scale,
      rotationQuarterTurns: ((transform.rotation / 90) % 4 + 4) % 4,
    };
  },
  onStatus: (message) => {
    reader.setStatus(message);
    render();
  },
  requestPassword,
});
function createContentController(linkSession: LinkSession | undefined): PdfContentController {
  return new PdfContentController({
    host: canvasHost,
    resources,

    onStatus: (message) => {
      if (linkSession !== undefined && (activeLinkSession?.sessionId !== linkSession.sessionId
        || activeLinkSession.documentGeneration !== linkSession.documentGeneration
        || activeLinkSession.ownerGeneration !== linkSession.ownerGeneration)) return;
      reader.setStatus(message);
      render();
    },
    navigateToPage: (pageNumber) => navigateReaderPage(pageNumber),
    navigateToDestination: (pageNumber, destination) => {
      navigateReaderDestination(pageNumber, destination);
    },
    prepareExternalLinks: async (entries, registryRevision) => {
      if (linkSession === undefined) throw new Error("LINK_SESSION_MISSING");
      await invoke<void>("prepare_external_links", {
        sessionId: linkSession.sessionId,
        documentGeneration: linkSession.documentGeneration,
        ownerGeneration: linkSession.ownerGeneration,
        registryRevision,
        entries: entries.map((entry) => ({
          annotation_id: entry.annotationId,
          target: entry.target,
        })),
      });
    },
    commitExternalLinks: async (registryRevision) => {
      if (linkSession === undefined) throw new Error("LINK_SESSION_MISSING");
      await invoke<void>("commit_external_links", {
        sessionId: linkSession.sessionId,
        documentGeneration: linkSession.documentGeneration,
        ownerGeneration: linkSession.ownerGeneration,
        registryRevision,
      });
    },
    finalizeExternalLinks: async (registryRevision) => {
      if (linkSession === undefined) throw new Error("LINK_SESSION_MISSING");
      await invoke<void>("finalize_external_links", {
        sessionId: linkSession.sessionId,
        documentGeneration: linkSession.documentGeneration,
        ownerGeneration: linkSession.ownerGeneration,
        registryRevision,
      });
    },
    abortExternalLinks: async (registryRevision) => {
      if (linkSession === undefined) throw new Error("LINK_SESSION_MISSING");
      await invoke<void>("abort_external_links", {
        sessionId: linkSession.sessionId,
        documentGeneration: linkSession.documentGeneration,
        ownerGeneration: linkSession.ownerGeneration,
        registryRevision,
      });
    },
    openExternal: (annotationId, registryRevision, activationOperationId, operationSequence) => {
      if (linkSession === undefined) {
        reader.setStatus("This PDF link could not be opened.");
        render();
        return Promise.resolve();
      }
      return invoke<void>("open_external_link", {
        sessionId: linkSession.sessionId,
        documentGeneration: linkSession.documentGeneration,
        ownerGeneration: linkSession.ownerGeneration,
        annotationId,
        registryRevision,
        operationId: activationOperationId,
        operationSequence,
      });
    },
  });
}
content = createContentController(undefined);
let pendingPageRender: Promise<boolean> = Promise.resolve(true);
const clampScale = (scale: number): number => Math.max(0.1, Math.min(8, scale));

function availableReaderSize(): { readonly width: number; readonly height: number } {
  const style = getComputedStyle(canvasHost);
  const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  return {
    width: Math.max(1, canvasHost.clientWidth - horizontalPadding),
    height: Math.max(1, canvasHost.clientHeight - verticalPadding),
  };
}
function currentNaturalPageSize(snapshot: ReaderSnapshot): { readonly width: number; readonly height: number } | undefined {
  const canvas = canvasHost.querySelector<HTMLCanvasElement>("canvas.pdf-page");
  if (canvas === null) return undefined;
  const priorScale = Number.parseFloat(canvas.dataset.scale ?? "") || 1.25;
  let width = Number.parseFloat(canvas.dataset.naturalWidth ?? "");
  let height = Number.parseFloat(canvas.dataset.naturalHeight ?? "");
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    width = (Number.parseFloat(canvas.style.width) || canvas.width) / priorScale;
    height = (Number.parseFloat(canvas.style.height) || canvas.height) / priorScale;
  }
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return undefined;
  const priorRotation = Number.parseFloat(canvas.dataset.rotation ?? "") || 0;
  const requestedRotation = snapshot.rotationQuarterTurns * 90;
  if ((Math.abs(priorRotation - requestedRotation) / 90) % 2 === 1) [width, height] = [height, width];
  return { width, height };
}


function resolveViewScale(snapshot: ReaderSnapshot): number {
  if (snapshot.zoomMode === "custom") return clampScale(snapshot.customScale);
  const natural = currentNaturalPageSize(snapshot);
  if (natural === undefined) return clampScale(snapshot.customScale);
  const { width: naturalWidth, height: naturalHeight } = natural;

  const available = availableReaderSize();
  const widthScale = available.width / naturalWidth;
  return clampScale(snapshot.zoomMode === "fit-width"
    ? widthScale
    : Math.min(widthScale, available.height / naturalHeight));
}

async function applyCurrentViewTransform(
  snapshot = reader.snapshot,
  requestCommitGuard?: () => boolean,
): Promise<boolean> {
  if (!snapshot.hasDocument) return false;
  return pdfReader.setViewTransform({
    scale: resolveViewScale(snapshot),
    rotation: snapshot.rotationQuarterTurns * 90,
    devicePixelRatio: Math.min(2, window.devicePixelRatio || 1),
  }, requestCommitGuard);
}

function applyPendingScroll(): void {
  const intent = reader.consumePendingScroll();
  canvasHost.scrollBy({
    left: intent.horizontalCssPixels,
    top: intent.verticalCssPixels + intent.viewportFactor * canvasHost.clientHeight,
    behavior: "auto",
  });
}

function isPageAction(type: string): boolean {
  return type === "page.next"
    || type === "page.previous"
    || type === "page.first"
    || type === "page.last"
    || type === "page.goTo";
}

function isViewAction(type: string): boolean {
  return type === "view.fitWidth"
    || type === "view.fitPage"
    || type === "view.zoom"
    || type === "view.rotate";
}
function tokenFromSnapshot(snapshot: ReaderSnapshot): CommittedReaderToken {
  return {
    documentGeneration: snapshot.documentGeneration,
    page: snapshot.page,
    zoomMode: snapshot.zoomMode,
    customScale: snapshot.customScale,
    rotationQuarterTurns: snapshot.rotationQuarterTurns,
  };
}
function publishCommittedReaderToken(token: CommittedReaderToken): void {
  committedReaderToken = token;
}
function restoreCommittedReaderView(requestedGeneration: number): boolean {
  const committed = committedReaderToken;
  if (committed === undefined || committed.documentGeneration !== requestedGeneration) return false;
  if (reader.snapshot.page !== committed.page) reader.apply({ type: "page.goTo", page: committed.page });
  reader.restoreView(committed);
  return true;
}
function startPageRender(
  requestedPage: number,
  navigationOwner: number,
  intent: CommittedReaderToken,
  transform?: PdfViewTransform,
  onFailure?: () => void,
): void {
  const requestCommitGuard = (): boolean => (
    navigationOwner === navigationInvocation
    && reader.snapshot.documentGeneration === intent.documentGeneration
  );
  const pageRender = transform === undefined
    ? pdfReader.renderPage(requestedPage, undefined, requestCommitGuard)
    : pdfReader.renderPageWithTransform(requestedPage, transform, requestCommitGuard);
  pendingPageRender = pageRender;
  void pageRender.then((rendered) => {
    if (navigationOwner !== navigationInvocation || reader.snapshot.documentGeneration !== intent.documentGeneration) return;
    if (rendered) {
      publishCommittedReaderToken(intent);
      return;
    }
    onFailure?.();
    const failureStatus = reader.snapshot.status;
    restoreCommittedReaderView(intent.documentGeneration);
    reader.setStatus(failureStatus);
    keyboard.syncContext();
    render();
  });
}
function renderRequestedPage(
  requestedPage: number,
  transform?: PdfViewTransform,
  intent = tokenFromSnapshot(reader.snapshot),
): void {
  content.cancelDestination();
  renderInvocation += 1;
  const navigationOwner = ++navigationInvocation;
  startPageRender(requestedPage, navigationOwner, intent, transform);
}
function navigateReaderDestination(pageNumber: number, destination: readonly unknown[]): void {
  const requestedGeneration = reader.snapshot.documentGeneration;
  const navigationOwner = ++navigationInvocation;
  const committed = committedReaderToken?.documentGeneration === requestedGeneration
    ? committedReaderToken
    : tokenFromSnapshot(reader.snapshot);
  const currentScale = Number.parseFloat(
    canvasHost.querySelector<HTMLCanvasElement>("canvas.pdf-page")?.dataset.scale ?? "",
  );
  const retainedScale = Number.isFinite(currentScale) && currentScale > 0
    ? clampScale(currentScale)
    : resolveViewScale({ ...reader.snapshot, ...committed });
  const rotationQuarterTurns = committed.rotationQuarterTurns;
  const rotation = rotationQuarterTurns * 90;
  const needsTargetSize = pdfDestinationNeedsPageSize(destination);
  renderInvocation += 1;
  content.cancelDestination();

  const isCurrentRequest = (): boolean => (
    navigationOwner === navigationInvocation
    && reader.snapshot.documentGeneration === requestedGeneration
  );
  const fail = (): void => {
    if (!isCurrentRequest()) return;
    const failureStatus = reader.snapshot.status;
    restoreCommittedReaderView(requestedGeneration);
    reader.setStatus("The PDF destination could not be rendered.");
    if (failureStatus !== reader.snapshot.status) render();
    keyboard.syncContext();
  };

  void (async () => {
    const targetSize = needsTargetSize
      ? await pdfReader.getPageNaturalSize(pageNumber, rotation)
      : undefined;
    if (!isCurrentRequest()) return;
    const view = resolvePdfDestinationView(
      destination,
      retainedScale,
      targetSize,
      availableReaderSize(),
      rotationQuarterTurns,
      clampScale,
    );
    if (view === undefined) {
      fail();
      return;
    }
    if (!isCurrentRequest()) return;

    const destinationIntent = content.queueDestination(pageNumber, destination);
    const { scale, zoomMode } = view;
    const intent: CommittedReaderToken = {
      documentGeneration: requestedGeneration,
      page: pageNumber,
      zoomMode,
      customScale: scale,
      rotationQuarterTurns,
    };
    reader.apply({ type: "page.goTo", page: pageNumber });
    reader.restoreView(intent);
    keyboard.syncContext();
    render();
    startPageRender(pageNumber, navigationOwner, intent, {
      scale,
      rotation,
      devicePixelRatio: Math.min(2, window.devicePixelRatio || 1),
    }, () => content.cancelDestination(destinationIntent));
  })().catch(fail);
}

function navigateReaderPage(pageNumber: number): void {
  restoreCommittedReaderView(reader.snapshot.documentGeneration);
  reader.apply({ type: "page.goTo", page: pageNumber });
  keyboard.syncContext();
  render();
  renderRequestedPage(reader.snapshot.page);
}

function openSearchDialog(): void {
  if (helpDialog.open) {
    reader.apply({ type: "prompt.cancel" });
    render();
  }
  searchInput.value = content.snapshot.query;
  searchQuery = content.snapshot.query;
  if (!searchDialog.open) searchDialog.showModal();
  searchInput.focus();
  searchInput.select();
}

function render(result?: SequenceResult): void {
  if (result?.error) {
    reader.setStatus(result.error);
  }

  const snapshot = reader.snapshot;
  status.textContent = snapshot.status;

  if (engine.state.kind === "pagePrompt") {
    prompt.hidden = false;
    prompt.textContent = `Go to page: ${engine.state.digits || "_"}`;
  } else {
    prompt.hidden = true;
    prompt.textContent = "";
  }

  if (snapshot.helpVisible && !helpDialog.open) {
    helpDialog.showModal();
  } else if (!snapshot.helpVisible && helpDialog.open) {
    helpDialog.close();
  }
}

let keyboard: KeyboardAdapter;
keyboard = createKeyboardAdapter({
  engine,
  getContext: () => ({
    hasDocument: reader.snapshot.hasDocument,
    pageCount: reader.snapshot.pageCount,
    documentGeneration: reader.snapshot.documentGeneration,
  }),
  onDispatch: ({ action }) => {
    if (action.type === "document.open") {
      searchInvocation += 1;
      searchQuery = "";
      renderInvocation += 1;
      navigationInvocation += 1;
      content.cancelDestination();
      ownerGeneration = reader.snapshot.documentGeneration;
      void pdfReader.open(ownerGeneration);
      return;
    }
    if (isPageAction(action.type) || isViewAction(action.type)
      || action.type === "scroll.byCssPixels" || action.type === "scroll.byViewport") {
      restoreCommittedReaderView(reader.snapshot.documentGeneration);
    }
    const prior = reader.snapshot;
    if (action.type === "view.zoom" && prior.zoomMode !== "custom") {
      const renderedScale = Number.parseFloat(
        canvasHost.querySelector<HTMLCanvasElement>("canvas.pdf-page")?.dataset.scale ?? "",
      );
      if (Number.isFinite(renderedScale) && renderedScale > 0) {
        reader.restoreView({ ...prior, customScale: renderedScale });
      }
    }
    reader.apply(action);
    keyboard.syncContext();
    render();
    if (isPageAction(action.type)) {
      renderRequestedPage(reader.snapshot.page);
    } else if (action.type === "scroll.byCssPixels" || action.type === "scroll.byViewport") {
      ++navigationInvocation;
      renderInvocation += 1;
      content.cancelDestination();
      applyPendingScroll();
    } else if (isViewAction(action.type)) {
      content.cancelDestination();
      const requestedView = reader.snapshot;
      const intent = tokenFromSnapshot(requestedView);
      const navigationOwner = ++navigationInvocation;
      const invocation = ++renderInvocation;
      const requestCommitGuard = (): boolean => (
        invocation === renderInvocation
        && navigationOwner === navigationInvocation
        && reader.snapshot.documentGeneration === intent.documentGeneration
      );
      void applyCurrentViewTransform(requestedView, requestCommitGuard).then((rendered) => {
        if (!requestCommitGuard()) return;
        if (rendered) {
          publishCommittedReaderToken(intent);
          return;
        }
        const failureStatus = reader.snapshot.status;
        restoreCommittedReaderView(intent.documentGeneration);
        reader.setStatus(failureStatus);
        keyboard.syncContext();
        render();
      });
    } else if (action.type === "search.open") {
      openSearchDialog();
    } else if (action.type === "linkHints.toggle") {
      content.toggleHints();
    } else if (action.type === "prompt.cancel") {
      content.cancelHints();
    }
  },
  onResult: render,
});
async function runSearch(reverse: boolean): Promise<void> {
  const invocation = ++searchInvocation;
  const source = searchInput.value;
  const normalized = normalizePdfSearchQuery(source);
  if (source.length > RESOURCE_LIMITS.maxTextPageBytes) {
    reader.setStatus("Search text is too large.");
    render();
    return;
  }
  const documentGeneration = reader.snapshot.documentGeneration;
  if (normalized !== searchQuery) {
    searchQuery = normalized;
    reader.setStatus("Searching PDF text…");
    render();
    await content.search(source);
    if (content.snapshot.query !== normalized) searchQuery = content.snapshot.query;
  } else {
    content.nextMatch(reverse);
  }

  const controllerState = content.snapshot;
  if (
    invocation !== searchInvocation
    || reader.snapshot.documentGeneration !== documentGeneration
    || source !== searchInput.value
    || controllerState.query.length === 0
    || controllerState.searchPending
    || controllerState.results.length === 0
    || !searchDialog.open
  ) return;

  searchDialog.close();
  canvasHost.focus();
}

function handleContentKeyDown(event: KeyboardEvent): void {
  if (isNativeOwnedKeyboardEvent(event)) return;
  const interactiveTarget = event.target instanceof Element
    && event.target.closest("button, a, [role='button'], [role='link']") !== null;
  if (content.snapshot.hintsVisible) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      content.handleHintKey(event.key);
    } else if (!interactiveTarget
      && event.key.length === 1
      && !event.ctrlKey
      && !event.altKey
      && !event.metaKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      content.handleHintKey(event.key);
    }
    return;
  }
  if (!searchDialog.open
    && !interactiveTarget
    && engine.state.kind === "idle"
    && content.snapshot.query.length > 0
    && event.key === "Enter"
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey) {
    event.preventDefault();
    event.stopImmediatePropagation();
    content.nextMatch(event.shiftKey);
  }
}

window.addEventListener("keydown", handleContentKeyDown, true);
searchForm.addEventListener("submit", (event) => event.preventDefault());
searchInput.addEventListener("input", () => {
  const normalized = normalizePdfSearchQuery(searchInput.value);
  if (normalized === searchQuery) return;
  searchQuery = "";
  searchInvocation += 1;
  content.invalidateSearch();
});
searchInput.addEventListener("keydown", (event) => {
  if (isNativeKeyboardCompositionOrModifierEvent(event)) return;

  const action = getPromptKeyAction(event);
  if (action === "close") {
    event.preventDefault();
    searchDialog.close();
    canvasHost.focus();
  } else if (action === "search" || action === "searchReverse") {
    event.preventDefault();
    void runSearch(action === "searchReverse");
  }
});
searchDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  searchDialog.close();
  canvasHost.focus();
});

window.addEventListener("keydown", keyboard.handleKeyDown);
window.addEventListener("blur", keyboard.cancelPending);
window.addEventListener("compositionstart", keyboard.cancelPending);
window.addEventListener("focusin", (event) => {
  if (isNativeOwnedTarget(event.target)) {
    keyboard.cancelPending();
  }
});
let resizeFrame = 0;
let lastDevicePixelRatio = Math.min(2, window.devicePixelRatio || 1);
let dprQuery: MediaQueryList | undefined;

function scheduleViewportRerender(): void {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    void (async () => {
      await pendingPageRender.catch(() => false);
      const documentGeneration = reader.snapshot.documentGeneration;
      const committed = committedReaderToken?.documentGeneration === documentGeneration ? committedReaderToken : undefined;
      if (committed === undefined) return;
      const navigationOwner = navigationInvocation;
      const invocation = ++renderInvocation;
      content.cancelDestination();
      restoreCommittedReaderView(documentGeneration);
      const requestCommitGuard = (): boolean => invocation === renderInvocation && navigationOwner === navigationInvocation && reader.snapshot.documentGeneration === committed.documentGeneration && reader.snapshot.page === committed.page;
      const rendered = await applyCurrentViewTransform(reader.snapshot, requestCommitGuard);
      if (requestCommitGuard() && rendered) publishCommittedReaderToken(committed);
    })().catch(() => undefined);
  });
}

function bindDprListener(): void {
  dprQuery?.removeEventListener("change", handleDprChange);
  dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  dprQuery.addEventListener("change", handleDprChange);
}

function handleDprChange(): void {
  lastDevicePixelRatio = Math.min(2, window.devicePixelRatio || 1);
  bindDprListener();
  scheduleViewportRerender();
}

bindDprListener();
window.addEventListener("resize", scheduleViewportRerender);
const dprPoll = window.setInterval(() => {
  const current = Math.min(2, window.devicePixelRatio || 1);
  if (current === lastDevicePixelRatio) return;
  lastDevicePixelRatio = current;
  bindDprListener();
  scheduleViewportRerender();
}, 250);
window.addEventListener("beforeunload", () => {
  passwordInput.value = "";
  if (passwordDialog.open) passwordDialog.close("cancel");
  if (searchDialog.open) searchDialog.close();
  dprQuery?.removeEventListener("change", handleDprChange);
  clearInterval(dprPoll);
  cancelAnimationFrame(resizeFrame);
  keyboard.dispose();
  window.removeEventListener("keydown", handleContentKeyDown, true);
  void beginContentTeardown(content, activeLinkSession?.sessionId);
  void pdfReader.dispose();
});
helpDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  reader.apply({ type: "prompt.cancel" });
  render();
});

render();
