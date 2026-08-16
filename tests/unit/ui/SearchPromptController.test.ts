/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { bindSearchPrompt } from "../../../src/ui/SearchPromptController";
function setup() {
  const dialog = document.createElement("dialog"); dialog.showModal = vi.fn(); dialog.close = vi.fn();
  const form = document.createElement("form"); const input = document.createElement("input"); form.append(input); dialog.append(form); document.body.append(dialog);
  const session = { invalidateSearch: vi.fn(), submitSearch: vi.fn() }; const render = vi.fn();
  const dispose = bindSearchPrompt({ dialog, form, input }, () => session, render);
  return { dialog, form, input, session, render, dispose };
}
describe("SearchPromptController", () => {
  it("submits forward and reverse searches but leaves composition native-owned", () => {
    const value = setup(); value.input.value = "needle";
    value.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    value.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    value.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    expect(value.session.submitSearch.mock.calls).toEqual([["needle", false], ["needle", true]]);
    value.dispose(); value.dialog.remove();
  });
  it("closes on unmodified Escape and ignores Ctrl or AltGraph ownership", () => {
    const value = setup(); value.input.value = "query";
    value.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", ctrlKey: true, bubbles: true, cancelable: true }));
    value.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(value.session.invalidateSearch).toHaveBeenCalledTimes(1); expect(value.input.value).toBe(""); expect(value.dialog.close).toHaveBeenCalledTimes(1); expect(value.render).toHaveBeenCalledTimes(1);
    value.dispose(); value.dialog.remove();
  });
});
