// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTabStripRenderer, type TabStripTab } from "../../../src/ui/shell/TabStripRenderer";

const tab = (id: string, title: string, selected = false, disabled = false): TabStripTab => ({ id, title, selected, ...(disabled ? { disabled: true } : {}) });

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("TabStripRenderer", () => {
  it("preserves long legal basenames and hashes while redacting paths", () => {
    const container = document.createElement("div");
    const renderer = createTabStripRenderer(container, { activate: vi.fn(), close: vi.fn() });
    const title = `${"긴".repeat(200)}#notes.pdf`;
    renderer.render([tab("long", title, true), tab("path", "C:\\private\\report.pdf")]);
    const button = container.querySelector<HTMLButtonElement>("#reader-tab-long")!;
    expect(button.title).toBe(title);
    expect(button.getAttribute("aria-label")).toBe(`${title}, tab 1 of 2`);
    expect(button.nextElementSibling?.getAttribute("aria-label")).toBe(`Close ${title}`);
    expect(container.querySelector("#reader-tab-path")?.getAttribute("aria-label")).toContain("PDF document");
  });
  it("keeps the full filename in semantics while hiding only a trailing PDF suffix visually", () => {
    const container = document.createElement("div");
    const renderer = createTabStripRenderer(container, { activate: vi.fn(), close: vi.fn() });
    renderer.render([tab("guide", "Guide.PDF", true), tab("literal", ".pdf")]);

    const guide = container.querySelector<HTMLButtonElement>("#reader-tab-guide")!;
    const literal = container.querySelector<HTMLButtonElement>("#reader-tab-literal")!;
    expect(container.getAttribute("role")).toBe("tablist");
    expect(guide.parentElement?.className).toBe("workspace-tab-item");
    expect(guide.parentElement?.dataset).toMatchObject({ selected: "true", index: "0" });
    expect(guide.getAttribute("role")).toBe("tab");
    expect(guide.getAttribute("aria-controls")).toBe("reader-panel-guide");
    expect(guide.getAttribute("aria-label")).toBe("Guide.PDF, tab 1 of 2");
    expect(guide.title).toBe("Guide.PDF");
    expect(guide.textContent).toBe("Guide");
    expect(guide.getAttribute("aria-selected")).toBe("true");
    expect(guide.tabIndex).toBe(0);
    expect(container.querySelector<HTMLButtonElement>("#reader-tab-guide + .workspace-tab-close")?.getAttribute("aria-label")).toBe("Close Guide.PDF");
    expect(literal.textContent).toBe(".pdf");
    expect(literal.title).toBe(".pdf");
    expect(literal.getAttribute("aria-label")).toBe(".pdf, tab 2 of 2");
  });
  it("keeps unchanged order and focused keyed nodes stable across a no-op render", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const renderer = createTabStripRenderer(container, { activate: vi.fn(), close: vi.fn() });
    renderer.render([tab("first", "first.pdf", true), tab("second", "second.pdf"), tab("third", "third.pdf")]);
    const second = container.querySelector<HTMLButtonElement>("#reader-tab-second")!;
    second.focus();

    renderer.render([tab("first", "first.pdf", true), tab("second", "second.pdf"), tab("third", "third.pdf")]);
    expect([...container.querySelectorAll(".workspace-tab")].map((button) => button.id)).toEqual([
      "reader-tab-first", "reader-tab-second", "reader-tab-third",
    ]);
    expect(document.activeElement).toBe(second);
  });

  it("projects selection and roving tabindex while preserving keyed node identity and focus", () => {
    const container = document.createElement("div");
    const renderer = createTabStripRenderer(container, { activate: vi.fn(), close: vi.fn() });
    document.body.append(container);
    renderer.render([tab("one", "one.pdf"), tab("two", "two.pdf", true)]);
    const one = container.querySelector<HTMLButtonElement>("#reader-tab-one")!;
    const two = container.querySelector<HTMLButtonElement>("#reader-tab-two")!;
    const twoClose = two.nextElementSibling!;
    two.focus();

    renderer.render([tab("two", "renamed.pdf", false), tab("one", "one.pdf", true)]);
    expect(container.querySelector<HTMLButtonElement>("#reader-tab-one")).toBe(one);
    expect(container.querySelector<HTMLButtonElement>("#reader-tab-two")).toBe(two);
    expect(two.nextElementSibling).toBe(twoClose);
    expect(document.activeElement).toBe(two);
    expect(two.tabIndex).toBe(-1);
    expect(one.tabIndex).toBe(0);
    expect(one.getAttribute("aria-selected")).toBe("true");
    expect(two.getAttribute("aria-selected")).toBe("false");
    expect([...container.children].map((item) => item.getAttribute("data-index"))).toEqual(["0", "1"]);
  });

  it("routes tab and close clicks by key and does not activate through close", () => {
    const container = document.createElement("div");
    const activate = vi.fn();
    const close = vi.fn();
    const renderer = createTabStripRenderer(container, { activate, close });
    renderer.render([tab("first", "first.pdf", true)]);

    const button = container.querySelector<HTMLButtonElement>(".workspace-tab")!;
    const closeButton = container.querySelector<HTMLButtonElement>(".workspace-tab-close")!;
    button.click();
    closeButton.click();
    expect(activate).toHaveBeenCalledExactlyOnceWith("first");
    expect(close).toHaveBeenCalledExactlyOnceWith("first");
  });

  it("uses the native disabled button behavior", () => {
    const container = document.createElement("div");
    const activate = vi.fn();
    const renderer = createTabStripRenderer(container, { activate, close: vi.fn() });
    renderer.render([tab("locked", "locked.pdf", true, true)]);
    const button = container.querySelector<HTMLButtonElement>(".workspace-tab")!;
    expect(button.disabled).toBe(true);
    button.click();
    expect(activate).not.toHaveBeenCalled();

    renderer.render([tab("locked", "locked.pdf", true)]);
    button.click();
    expect(activate).toHaveBeenCalledExactlyOnceWith("locked");
  });

  it("restores focus to the selected tab only when a focused item is removed", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const renderer = createTabStripRenderer(container, { activate: vi.fn(), close: vi.fn() });
    renderer.render([tab("first", "first.pdf", true), tab("second", "second.pdf")]);
    const first = container.querySelector<HTMLButtonElement>("#reader-tab-first")!;
    const second = container.querySelector<HTMLButtonElement>("#reader-tab-second")!;
    const secondClose = second.nextElementSibling as HTMLButtonElement;
    secondClose.focus();
    renderer.render([tab("first", "first.pdf", true)]);
    expect(document.activeElement).toBe(first);

    const outside = document.createElement("button");
    container.append(outside);
    outside.focus();
    renderer.render([tab("first", "first.pdf", true)]);
    expect(document.activeElement).toBe(outside);
  });

  it("reveals a selected item only when it is outside horizontal container bounds", () => {
    const container = document.createElement("div");
    const renderer = createTabStripRenderer(container, { activate: vi.fn(), close: vi.fn() });
    const containerRect = { left: 100, right: 300, top: 0, bottom: 40, width: 200, height: 40 } as DOMRect;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(containerRect);
    renderer.render([tab("first", "first.pdf", true)]);
    const item = container.querySelector<HTMLElement>(".workspace-tab-item")!;
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue({ left: 250, right: 340, top: 0, bottom: 26, width: 90, height: 26 } as DOMRect);
    container.scrollLeft = 0;
    renderer.render([tab("first", "first.pdf", true)]);
    expect(container.scrollLeft).toBe(40);

    vi.spyOn(item, "getBoundingClientRect").mockReturnValue({ left: 140, right: 230, top: 0, bottom: 26, width: 90, height: 26 } as DOMRect);
    container.scrollLeft = 12;
    renderer.render([tab("first", "first.pdf", true)]);
    expect(container.scrollLeft).toBe(12);
  });
});
