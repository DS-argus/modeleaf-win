import "./styles/app.css";
import { KeySequenceEngine, type SequenceResult } from "./core/KeySequenceEngine";
import { ReaderState } from "./core/ReaderState";
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
    reader.setStatus(`${displayName} — Page 1 of ${pageCount}`);
    keyboard.syncContext();
    render();
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
    reader.apply(action);
    keyboard.syncContext();
    render();
    if (action.type === "page.next" || action.type === "page.previous" || action.type === "page.first" || action.type === "page.last" || action.type === "page.goTo") {
      const requestedPage = reader.snapshot.page;
      void pdfReader.renderPage(requestedPage).then((rendered) => {
        if (!rendered && reader.snapshot.page === requestedPage && committedPage !== requestedPage) {
          const failureStatus = reader.snapshot.status;
          reader.apply({ type: "page.goTo", page: committedPage });
          reader.setStatus(failureStatus);
          keyboard.syncContext();
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
window.addEventListener("beforeunload", () => {
  passwordInput.value = "";
  if (passwordDialog.open) passwordDialog.close("cancel");
  keyboard.dispose();
  void pdfReader.dispose();
});
helpDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  reader.apply({ type: "prompt.cancel" });
  render();
});

render();
