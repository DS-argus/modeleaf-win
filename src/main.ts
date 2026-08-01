import "./styles/app.css";
import { KeySequenceEngine, type SequenceResult } from "./core/KeySequenceEngine";
import { ReaderState, type ReaderSnapshot } from "./core/ReaderState";
import {
  createKeyboardAdapter,
  isNativeOwnedTarget,
  type KeyboardAdapter,
} from "./platform/keyboardAdapter";
import { buildHelpRows } from "./ui/HelpModel";
import { invoke } from "@tauri-apps/api/core";
import { AnnotationMode, getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { PDFJS_POLICY } from "./pdf/PdfJsPolicy";
import { PdfReaderController, type OpenPdfResult, type PdfLoadingTask } from "./pdf/PdfReaderController";
import { ResourceReservationManager } from "./pdf/ResourceBudget";

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
    <section id="reader-surface" class="reader-surface" aria-label="PDF reading surface">
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
    </dialog>
    <dialog id="password-dialog" aria-labelledby="password-title">
      <form method="dialog" autocomplete="off">
        <h2 id="password-title">PDF password required</h2>
        <label>Password <input id="password-input" type="password" autocomplete="off" data-form-type="other" spellcheck="false"></label>
        <menu><button value="cancel">Cancel</button><button value="submit">Open</button></menu>
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

let committedPage = 1;
const resources = new ResourceReservationManager();
const pdfReader = new PdfReaderController({
  native,
  pdf: { getDocument: (options) => getDocument(options as never) as unknown as PdfLoadingTask, annotationMode: AnnotationMode.DISABLE },
  resources,
  canvasHost,
  onCommitted: (pageCount, displayName) => {
    reader.mountDocument(pageCount);
    reader.setStatus(`${displayName} — ${reader.snapshot.status}`);
    keyboard.syncContext();
    render();
    const openedView = reader.snapshot;
    void applyCurrentViewTransform().then((rendered) => {
      if (!rendered && reader.snapshot.documentGeneration === openedView.documentGeneration) {
        const failureStatus = reader.snapshot.status;
        reader.restoreView({ zoomMode: "custom", customScale: 1.25, rotationQuarterTurns: 0 });
        reader.setStatus(failureStatus);
        render();
      }
    });
  },
  onPage: (page) => {
    committedPage = page;
  },
  onStatus: (message) => {
    reader.setStatus(message);
    render();
  },
  requestPassword,
});
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

function resolveViewScale(snapshot: ReaderSnapshot): number {
  if (snapshot.zoomMode === "custom") return clampScale(snapshot.customScale);
  const canvas = canvasHost.querySelector<HTMLCanvasElement>("canvas.pdf-page");
  if (canvas === null) return clampScale(snapshot.customScale);

  const priorScale = Number.parseFloat(canvas.dataset.scale ?? "") || 1.25;
  let naturalWidth = (Number.parseFloat(canvas.style.width) || canvas.width) / priorScale;
  let naturalHeight = (Number.parseFloat(canvas.style.height) || canvas.height) / priorScale;
  const priorRotation = Number.parseFloat(canvas.dataset.rotation ?? "") || 0;
  const requestedRotation = snapshot.rotationQuarterTurns * 90;
  if ((Math.abs(priorRotation - requestedRotation) / 90) % 2 === 1) {
    [naturalWidth, naturalHeight] = [naturalHeight, naturalWidth];
  }

  const available = availableReaderSize();
  const widthScale = available.width / naturalWidth;
  return clampScale(snapshot.zoomMode === "fit-width"
    ? widthScale
    : Math.min(widthScale, available.height / naturalHeight));
}

async function applyCurrentViewTransform(): Promise<boolean> {
  const snapshot = reader.snapshot;
  if (!snapshot.hasDocument) return false;
  return pdfReader.setViewTransform({
    scale: resolveViewScale(snapshot),
    rotation: snapshot.rotationQuarterTurns * 90,
    devicePixelRatio: window.devicePixelRatio || 1,
  });
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
      ownerGeneration = reader.snapshot.documentGeneration;
      void pdfReader.open(ownerGeneration);
      return;
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
      const requestedPage = reader.snapshot.page;
      const pageRender = pdfReader.renderPage(requestedPage);
      pendingPageRender = pageRender;
      void pageRender.then((rendered) => {
        if (!rendered && reader.snapshot.page === requestedPage && committedPage !== requestedPage) {
          const failureStatus = reader.snapshot.status;
          reader.apply({ type: "page.goTo", page: committedPage });
          reader.setStatus(failureStatus);
          keyboard.syncContext();
          render();
        }
      });
    } else if (action.type === "scroll.byCssPixels" || action.type === "scroll.byViewport") {
      applyPendingScroll();
    } else if (isViewAction(action.type)) {
      const requestedGeneration = reader.snapshot.documentGeneration;
      const requestedView = reader.snapshot;
      void pendingPageRender.then(() => applyCurrentViewTransform()).then((rendered) => {
        const current = reader.snapshot;
        if (!rendered
          && current.documentGeneration === requestedGeneration
          && current.zoomMode === requestedView.zoomMode
          && current.customScale === requestedView.customScale
          && current.rotationQuarterTurns === requestedView.rotationQuarterTurns) {
          const failureStatus = current.status;
          reader.restoreView(prior);
          reader.setStatus(failureStatus);
          render();
        }
      });
    }
  },
  onResult: render,
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
let lastDevicePixelRatio = window.devicePixelRatio || 1;
let dprQuery: MediaQueryList | undefined;

function scheduleViewportRerender(): void {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    void pendingPageRender.then(() => applyCurrentViewTransform());
  });
}

function bindDprListener(): void {
  dprQuery?.removeEventListener("change", handleDprChange);
  dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  dprQuery.addEventListener("change", handleDprChange);
}

function handleDprChange(): void {
  lastDevicePixelRatio = window.devicePixelRatio || 1;
  bindDprListener();
  scheduleViewportRerender();
}

bindDprListener();
window.addEventListener("resize", scheduleViewportRerender);
const dprPoll = window.setInterval(() => {
  const current = window.devicePixelRatio || 1;
  if (current === lastDevicePixelRatio) return;
  lastDevicePixelRatio = current;
  bindDprListener();
  scheduleViewportRerender();
}, 250);
window.addEventListener("beforeunload", () => {
  passwordInput.value = "";
  if (passwordDialog.open) passwordDialog.close("cancel");
  dprQuery?.removeEventListener("change", handleDprChange);
  clearInterval(dprPoll);
  cancelAnimationFrame(resizeFrame);
  keyboard.dispose();
  void pdfReader.dispose();
});
helpDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  reader.apply({ type: "prompt.cancel" });
  render();
});

render();
