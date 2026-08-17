// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindCopyContextMenu } from "../../../src/ui/reader/CopyContextMenu";

afterEach(() => { document.body.replaceChildren(); document.getSelection()?.removeAllRanges(); });
function setup(): { readonly host: HTMLElement; readonly selected: HTMLElement; readonly outside: HTMLElement } {
  const host = document.createElement("main"); host.tabIndex = -1;
  const selected = document.createElement("button"); selected.textContent = "Exact selected text";
  const outside = document.createElement("p"); outside.textContent = "Outside text";
  host.append(selected); document.body.append(host, outside); return { host, selected, outside };
}
function select(node: Node, start = 0, end = node.textContent?.length ?? 0): void {
  const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end);
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
}
function contextMenu(target: HTMLElement): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }); target.dispatchEvent(event); return event;
}
const menu = (): HTMLElement | null => document.querySelector("[role='menu']");

describe("CopyContextMenu", () => {
  it("suppresses the browser menu and copies the exact in-reader selection", async () => {
    const { host, selected } = setup(); const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    const binding = bindCopyContextMenu({ readerHost: host, writeText }); select(selected.firstChild!);
    const event = contextMenu(selected); const contextMenuElement = menu(); const items = contextMenuElement?.querySelectorAll("[role='menuitem']");
    expect(event.defaultPrevented).toBe(true); expect(contextMenuElement?.getAttribute("aria-label")).toBe("Reader context menu");
    expect(items).toHaveLength(1); expect(items?.[0]?.textContent).toBe("Copy"); expect((items?.[0] as HTMLButtonElement).disabled).toBe(false);
    (items![0] as HTMLButtonElement).click(); await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("Exact selected text"); expect(menu()).toBeNull(); binding.dispose();
  });
  it("suppresses empty, text-empty, and outside selections without showing a menu", () => {
    const { host, selected, outside } = setup(); const binding = bindCopyContextMenu({ readerHost: host, writeText: vi.fn().mockResolvedValue(undefined) });
    select(selected.firstChild!, 0, 0); expect(contextMenu(selected).defaultPrevented).toBe(true); expect(menu()).toBeNull();
    const empty = document.createElement("span"); selected.append(empty); select(empty); expect(contextMenu(selected).defaultPrevented).toBe(true); expect(menu()).toBeNull();
    select(outside.firstChild!); expect(contextMenu(selected).defaultPrevented).toBe(true); expect(menu()).toBeNull(); binding.dispose();
  });
  it("closes on Escape and an outside pointer, restoring a connected invoker", () => {
    const { host, selected, outside } = setup(); const binding = bindCopyContextMenu({ readerHost: host, writeText: vi.fn().mockResolvedValue(undefined) }); select(selected.firstChild!);
    contextMenu(selected); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); expect(menu()).toBeNull(); expect(document.activeElement).toBe(selected);
    contextMenu(selected); outside.dispatchEvent(new Event("pointerdown", { bubbles: true })); expect(menu()).toBeNull(); expect(document.activeElement).toBe(selected); binding.dispose();
  });
  it("closes even when clipboard writing rejects", async () => {
    const { host, selected } = setup(); const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error("denied"));
    const binding = bindCopyContextMenu({ readerHost: host, writeText }); select(selected.firstChild!); contextMenu(selected);
    (menu()!.querySelector("[role='menuitem']") as HTMLButtonElement).click(); await Promise.resolve(); expect(writeText).toHaveBeenCalledWith("Exact selected text"); expect(menu()).toBeNull(); binding.dispose();
  });
  it("does not focus a stale invoker or fall back to the reader", () => {
    const { host, selected } = setup(); const binding = bindCopyContextMenu({ readerHost: host, writeText: vi.fn().mockResolvedValue(undefined) }); select(selected.firstChild!);
    contextMenu(selected); selected.remove(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); expect(menu()).toBeNull(); expect(document.activeElement).not.toBe(host); binding.dispose();
  });
  it("replaces an open menu and disposes idempotently", () => {
    const { host, selected } = setup(); const binding = bindCopyContextMenu({ readerHost: host, writeText: vi.fn().mockResolvedValue(undefined) }); select(selected.firstChild!);
    contextMenu(selected); const first = menu(); select(selected.firstChild!); contextMenu(selected); expect(document.querySelectorAll("[role='menu']")).toHaveLength(1); expect(first?.isConnected).toBe(false);
    binding.dispose(); binding.dispose(); expect(menu()).toBeNull();
  });
});
