/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PdfPrintProgress } from "../../src/pdf/PdfPrintService";
import { createPrintProgress } from "../../src/ui/PrintProgress";

const report = (
  phase: PdfPrintProgress["phase"],
  preparedPages = 0,
  totalPages = 12,
  fraction = totalPages === 0 ? 0 : preparedPages / totalPages,
): PdfPrintProgress => ({ phase, preparedPages, totalPages, fraction });

function setup() {
  const host = document.createElement("footer");
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  const existingError = document.createElement("span");
  existingError.className = "status-message error";
  existingError.textContent = "Existing cleanup error";
  const existingText = existingError.firstChild;
  host.append(existingError);
  document.body.append(host);

  const onCancel = vi.fn();
  const control = createPrintProgress(host, onCancel);
  const container = host.querySelector<HTMLElement>(".print-progress")!;
  const text = container.querySelector<HTMLElement>(".print-progress-text")!;
  const meter = container.querySelector<HTMLProgressElement>(".print-progress-meter")!;
  const button = container.querySelector<HTMLButtonElement>(".print-progress-cancel")!;
  return { host, existingError, existingText, onCancel, control, container, text, meter, button };
}

afterEach(() => { document.body.replaceChildren(); });

describe("print progress footer control", () => {
  it("shows opening feedback synchronously without replacing an existing error or taking focus", () => {
    const subject = setup();
    expect(subject.container.tagName).toBe("SPAN");
    expect(subject.container.hidden).toBe(true);
    expect(Array.from(subject.host.children)).toEqual([subject.existingError, subject.container]);

    subject.control.update(report("opening-dialog"));

    expect(subject.container.hidden).toBe(false);
    expect(subject.text.textContent).toBe("Opening print dialog…");
    expect(subject.meter.hasAttribute("value")).toBe(false);
    expect(subject.button.textContent).toBe("Cancel printing");
    expect(subject.button.type).toBe("button");
    expect(subject.button.disabled).toBe(false);
    expect(subject.container.getAttribute("role")).toBe("group");
    expect(subject.container.getAttribute("aria-label")).toBe("Print progress");
    expect(subject.meter.getAttribute("aria-label")).toBe("Printing progress");
    expect(subject.container.querySelector("dialog, [role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(subject.existingError.textContent).toBe("Existing cleanup error");
    expect(subject.existingError.firstChild).toBe(subject.existingText);
  });

  it("renders the service's monotonic prepared-page reports without inventing a page count", () => {
    const subject = setup();
    const rendered: Array<{ readonly text: string | null; readonly value: number; readonly valueText: string | null }> = [];
    for (const progress of [
      report("preparing", 0, 8, 0.125),
      report("preparing", 2, 8, 0.25),
      report("preparing", 5, 8, 0.625),
      report("preparing", 8, 8, 1),
    ]) {
      subject.control.update(progress);
      rendered.push({
        text: subject.text.textContent,
        value: subject.meter.value,
        valueText: subject.meter.getAttribute("aria-valuetext"),
      });
    }

    expect(rendered).toEqual([
      { text: "Preparing 0 of 8 pages…", value: 0.125, valueText: "0 of 8 pages prepared" },
      { text: "Preparing 2 of 8 pages…", value: 0.25, valueText: "2 of 8 pages prepared" },
      { text: "Preparing 5 of 8 pages…", value: 0.625, valueText: "5 of 8 pages prepared" },
      { text: "Preparing 8 of 8 pages…", value: 1, valueText: "8 of 8 pages prepared" },
    ]);
  });

  it("requests cancellation once and ignores ordinary progress arriving while cancellation settles", () => {
    const subject = setup();
    subject.control.update(report("preparing", 3, 10, 0.3));
    subject.button.focus();
    subject.button.click();

    expect(subject.onCancel).toHaveBeenCalledOnce();
    expect(subject.text.textContent).toBe("Cancelling printing…");
    expect(subject.button.disabled).toBe(true);
    expect(subject.meter.hasAttribute("value")).toBe(false);

    subject.control.cancel();
    subject.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    subject.control.update(report("preparing", 4, 10, 0.4));
    subject.control.update(report("submitting", 4, 10, 0.4));

    expect(subject.onCancel).toHaveBeenCalledOnce();
    expect(subject.text.textContent).toBe("Cancelling printing…");
    expect(subject.button.disabled).toBe(true);
    expect(subject.meter.hasAttribute("value")).toBe(false);

    subject.control.update(report("cancelled", 4, 10, 0.4));
    expect(subject.text.textContent).toBe("Printing cancelled");
    expect(subject.button.disabled).toBe(true);
    expect(subject.meter.value).toBe(0.4);

    subject.control.update(report("preparing", 5, 10, 0.5));
    subject.control.cancel();
    expect(subject.text.textContent).toBe("Printing cancelled");
    expect(subject.onCancel).toHaveBeenCalledOnce();
  });

  it("uses determinate preparation and indeterminate dialog/submission states, then truthful terminals", () => {
    const subject = setup();
    subject.control.update(report("opening-dialog"));
    expect(subject.meter.hasAttribute("value")).toBe(false);
    expect(subject.button.disabled).toBe(false);

    subject.control.update(report("preparing", 6, 12, 0.5));
    expect(subject.meter.value).toBe(0.5);
    expect(subject.button.disabled).toBe(false);

    subject.control.update(report("submitting", 6, 12, 0.5));
    expect(subject.text.textContent).toBe("Submitting to printer…");
    expect(subject.meter.hasAttribute("value")).toBe(false);
    expect(subject.button.disabled).toBe(false);

    subject.control.update(report("submitted", 12, 12, 1));
    expect(subject.text.textContent).toBe("Submitted to printer");
    expect(subject.text.textContent).not.toMatch(/printed|success/iu);
    expect(subject.meter.value).toBe(1);
    expect(subject.button.disabled).toBe(true);
    subject.control.cancel();
    expect(subject.onCancel).not.toHaveBeenCalled();

    for (const [phase, expected] of [
      ["cancelled", "Printing cancelled"],
      ["failed", "Printing failed"],
    ] as const) {
      subject.control.update(undefined);
      subject.control.update(report(phase, 3, 12, 0.25));
      expect(subject.text.textContent).toBe(expected);
      expect(subject.button.disabled).toBe(true);
      subject.control.cancel();
      expect(subject.onCancel).not.toHaveBeenCalled();
    }
  });

  it("owns Escape only while focus is inside the active control", () => {
    const subject = setup();
    const outside = document.createElement("button");
    outside.textContent = "Search control";
    document.body.append(outside);
    const outsideKeyDown = vi.fn();
    document.addEventListener("keydown", outsideKeyDown);
    subject.control.update(report("opening-dialog"));

    outside.focus();
    const outsideEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    outside.dispatchEvent(outsideEscape);
    expect(subject.control.containsFocus()).toBe(false);
    expect(subject.onCancel).not.toHaveBeenCalled();
    expect(outsideEscape.defaultPrevented).toBe(false);
    expect(outsideKeyDown).toHaveBeenCalledOnce();

    subject.button.focus();
    expect(subject.control.containsFocus()).toBe(true);
    const insideEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    subject.button.dispatchEvent(insideEscape);
    expect(subject.onCancel).toHaveBeenCalledOnce();
    expect(insideEscape.defaultPrevented).toBe(true);
    expect(outsideKeyDown).toHaveBeenCalledOnce();

    document.removeEventListener("keydown", outsideKeyDown);
  });

  it("hides, resets, and reopens the same connected nodes for a later print", () => {
    const subject = setup();
    const nodes = Array.from(subject.container.children);
    subject.control.update(report("preparing", 4, 9, 4 / 9));
    subject.control.cancel();
    expect(subject.onCancel).toHaveBeenCalledOnce();

    subject.control.update(undefined);
    expect(subject.container.hidden).toBe(true);
    expect(subject.container.isConnected).toBe(true);
    expect(subject.text.textContent).toBe("");
    expect(subject.meter.hasAttribute("value")).toBe(false);
    expect(subject.meter.hasAttribute("aria-valuetext")).toBe(false);
    expect(subject.button.disabled).toBe(true);

    subject.control.update(report("preparing", 0, 2, 0));
    expect(subject.container.hidden).toBe(false);
    expect(Array.from(subject.container.children)).toEqual(nodes);
    expect(subject.text.textContent).toBe("Preparing 0 of 2 pages…");
    expect(subject.button.disabled).toBe(false);
    subject.control.cancel();
    expect(subject.onCancel).toHaveBeenCalledTimes(2);
    expect(subject.existingError.textContent).toBe("Existing cleanup error");
    expect(subject.existingError.firstChild).toBe(subject.existingText);
  });

  it("reports focus membership and disposal removes only its owned nodes and handlers", () => {
    const subject = setup();
    const outside = document.createElement("input");
    document.body.append(outside);
    subject.control.update(report("opening-dialog"));

    outside.focus();
    expect(subject.control.containsFocus()).toBe(false);
    subject.button.focus();
    expect(subject.control.containsFocus()).toBe(true);

    subject.control.dispose();
    subject.control.dispose();
    expect(subject.control.containsFocus()).toBe(false);
    expect(subject.container.isConnected).toBe(false);
    expect(Array.from(subject.host.children)).toEqual([subject.existingError]);
    expect(subject.existingError.textContent).toBe("Existing cleanup error");
    expect(subject.existingError.firstChild).toBe(subject.existingText);

    subject.control.update(report("opening-dialog"));
    subject.control.cancel();
    subject.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    subject.button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(subject.container.isConnected).toBe(false);
    expect(subject.onCancel).not.toHaveBeenCalled();
  });
});
