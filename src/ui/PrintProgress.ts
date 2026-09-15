import type { PdfPrintProgress } from "../pdf/PdfPrintService";

export interface PrintProgressControl {
  update(progress: PdfPrintProgress | undefined): void;
  cancel(): void;
  containsFocus(): boolean;
  dispose(): void;
}

type PrintProgressState = "hidden" | "active" | "cancelling" | "terminal";

const isTerminal = (phase: PdfPrintProgress["phase"]): boolean =>
  phase === "submitted" || phase === "cancelled" || phase === "failed";

/** Adds a retained, inline print control without taking ownership of the host's other children. */
export function createPrintProgress(host: HTMLElement, onCancel: () => void): PrintProgressControl {
  const ownerDocument = host.ownerDocument;
  const container = ownerDocument.createElement("span");
  container.className = "print-progress";
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Print progress");
  container.hidden = true;

  const text = ownerDocument.createElement("span");
  text.className = "print-progress-text";

  const meter = ownerDocument.createElement("progress");
  meter.className = "print-progress-meter";
  meter.max = 1;
  meter.setAttribute("aria-label", "Printing progress");

  const cancelButton = ownerDocument.createElement("button");
  cancelButton.className = "print-progress-cancel";
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel printing";
  cancelButton.disabled = true;

  container.append(text, meter, cancelButton);
  host.append(container);

  let state: PrintProgressState = "hidden";
  let disposed = false;

  const setText = (value: string): void => {
    if (text.textContent !== value) text.textContent = value;
  };
  const setHidden = (value: boolean): void => {
    if (container.hidden !== value) container.hidden = value;
  };
  const setDisabled = (value: boolean): void => {
    if (cancelButton.disabled !== value) cancelButton.disabled = value;
  };
  const setIndeterminate = (): void => {
    if (meter.hasAttribute("value")) meter.removeAttribute("value");
    meter.removeAttribute("aria-valuetext");
  };
  const setDeterminate = (progress: PdfPrintProgress): void => {
    if (!meter.hasAttribute("value") || meter.value !== progress.fraction) meter.value = progress.fraction;
    const valueText = `${progress.preparedPages} of ${progress.totalPages} pages prepared`;
    if (meter.getAttribute("aria-valuetext") !== valueText) meter.setAttribute("aria-valuetext", valueText);
  };
  const containsFocus = (): boolean => {
    const activeElement = ownerDocument.activeElement;
    return !disposed && activeElement !== null && container.contains(activeElement);
  };
  const requestCancellation = (): boolean => {
    if (disposed || state === "hidden" || state === "terminal") return false;
    if (state === "cancelling") return true;
    state = "cancelling";
    setText("Cancelling printing…");
    setIndeterminate();
    setDisabled(true);
    onCancel();
    return true;
  };
  const onClick = (): void => { requestCancellation(); };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229
      || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
      || !containsFocus() || !requestCancellation()) return;
    event.preventDefault();
    event.stopPropagation();
  };

  cancelButton.addEventListener("click", onClick);
  container.addEventListener("keydown", onKeyDown);

  return {
    update(progress): void {
      if (disposed) return;
      if (progress === undefined) {
        state = "hidden";
        setHidden(true);
        setText("");
        setIndeterminate();
        setDisabled(true);
        return;
      }
      if (state === "terminal") return;
      if (state === "cancelling" && !isTerminal(progress.phase)) return;

      setHidden(false);
      if (isTerminal(progress.phase)) {
        state = "terminal";
        setDisabled(true);
      } else {
        state = "active";
        setDisabled(false);
      }

      switch (progress.phase) {
        case "opening-dialog":
          setText("Opening print dialog…");
          setIndeterminate();
          break;
        case "preparing":
          setText(`Preparing ${progress.preparedPages} of ${progress.totalPages} pages…`);
          setDeterminate(progress);
          break;
        case "submitted":
          setText("Submitted to printer");
          setDeterminate(progress);
          break;
        case "cancelled":
          setText("Printing cancelled");
          setDeterminate(progress);
          break;
        case "failed":
          setText("Printing failed");
          setDeterminate(progress);
          break;
      }
    },
    cancel(): void { requestCancellation(); },
    containsFocus,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelButton.removeEventListener("click", onClick);
      container.removeEventListener("keydown", onKeyDown);
      container.remove();
      state = "hidden";
    },
  };
}
