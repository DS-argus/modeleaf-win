/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { bindSearchPrompt } from "../../../src/ui/SearchPromptController";
function setup() {
  const dialog = document.createElement("dialog"); dialog.showModal = vi.fn(); dialog.close = vi.fn();
  const form = document.createElement("form"); const input = document.createElement("input"); form.append(input); dialog.append(form); document.body.append(dialog);
  const session = { startSearch: vi.fn<(query: string) => { readonly kind: "search" | "ignore" | "cycle" }>(() => ({ kind: "search" })) }; const render = vi.fn();
  const close = vi.fn(); const dispose = bindSearchPrompt({ dialog, form, input }, () => session, close, render);
  return { dialog, form, input, session, close, render, dispose };
}
describe("SearchPromptController", () => {
  it("commits one prompt search, closes, and leaves composition native-owned", () => {
    const value = setup(); value.input.value = "needle";
    value.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    value.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    expect(value.session.startSearch).toHaveBeenCalledOnce();
    expect(value.session.startSearch).toHaveBeenCalledWith("needle");
    expect(value.close).toHaveBeenCalledOnce();
    expect(value.render).toHaveBeenCalledOnce();
    value.dispose(); value.dialog.remove();
  });
  it("keeps the prompt open when validation rejects an empty query", () => {
    const value = setup(); value.session.startSearch.mockReturnValue({ kind: "ignore" });
    value.input.value = "   ";
    value.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(value.close).not.toHaveBeenCalled();
    expect(value.render).toHaveBeenCalledOnce();
    value.dispose(); value.dialog.remove();
  });
  it("cancels only the prompt and preserves active search text", () => {
    const value = setup(); value.input.value = "query";
    value.input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    value.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", ctrlKey: true, bubbles: true, cancelable: true }));
    value.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(value.session.startSearch).not.toHaveBeenCalled();
    expect(value.input.value).toBe("query");
    expect(value.close).toHaveBeenCalledOnce();
    expect(value.render).toHaveBeenCalledOnce();
    value.dispose(); value.dialog.remove();
  });
});
