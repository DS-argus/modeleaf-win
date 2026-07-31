import "./styles/app.css";
import { KeySequenceEngine, type SequenceResult } from "./core/KeySequenceEngine";
import { ReaderState } from "./core/ReaderState";
import {
  createKeyboardAdapter,
  isNativeOwnedTarget,
  type KeyboardAdapter,
} from "./platform/keyboardAdapter";
import { buildHelpRows } from "./ui/HelpModel";

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
    <section class="reader-surface" aria-label="PDF reading surface">
      <div class="empty-state">
        <strong>Keyboard-first PDF reading for Windows</strong>
        <p>The read-only PDF transport is awaiting the recorded Phase 0 gate.</p>
        <p>Press <kbd>Ctrl</kbd>+<kbd>O</kbd> to exercise the open command or <kbd>?</kbd> for shortcuts.</p>
      </div>
    </section>
    <section id="prompt" class="prompt" aria-live="polite" hidden></section>
    <dialog id="help-dialog" aria-labelledby="help-title">
      <header><h2 id="help-title">Keyboard shortcuts</h2></header>
      <dl id="help-rows"></dl>
      <p class="dialog-hint">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close.</p>
    </dialog>
    <footer id="status" class="statusbar" role="status" aria-live="polite"></footer>
  </section>
`;

const status = requireElement<HTMLElement>("#status");
const prompt = requireElement<HTMLElement>("#prompt");
const helpDialog = requireElement<HTMLDialogElement>("#help-dialog");
const helpRows = requireElement<HTMLElement>("#help-rows");

for (const row of buildHelpRows()) {
  const term = document.createElement("dt");
  term.textContent = row.shortcut;
  const description = document.createElement("dd");
  description.textContent = row.label;
  helpRows.append(term, description);
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
    reader.apply(action);
    keyboard.syncContext();
    render();
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
window.addEventListener("beforeunload", keyboard.dispose);
helpDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  reader.apply({ type: "prompt.cancel" });
  render();
});

render();
