// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TocWidgetView } from "../../../src/ui/reader/TocWidgetView";
import type { TocViewState } from "../../../src/ui/reader/TocController";
import type { OutlineRow } from "../../../src/domain/outlines/OutlineModel";
import { TOC_CHILD_INDENT_PX } from "../../../src/ui/reader/TocWidgetModel";

const row = (id: string, selector: string | undefined, enabled: boolean, depth: 0 | 1 = 0): OutlineRow => Object.freeze({
  id,
  title: `Row ${id}`,
  depth,
  enabled,
  ...(selector === undefined ? {} : { selector }),
  ...(enabled ? { destination: { pageIndex: 0, x: 0, y: 0 } } : {}),
});

function state(rows: readonly OutlineRow[], overrides: Partial<TocViewState> = {}): TocViewState {
  return {
    open: true,
    rows: rows.map((entry, index) => ({
      row: entry,
      rowIndex: index,
      indentPx: entry.depth * TOC_CHILD_INDENT_PX,
      isCurrent: index === 0,
    })),
    geometry: { width: 300, height: 84, visibleRows: 3, offsetTop: 12, offsetRight: 12 },
    currentRowId: rows[0]?.id,
    pendingSelector: "",
    empty: rows.length === 0,
    totalRows: rows.length,
    ...overrides,
  };
}

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("section");
  document.body.append(host);
});

describe("TocWidgetView rendering", () => {
  it("stays hidden until the TOC is open", () => {
    const view = new TocWidgetView({ host, onActivateRow: () => undefined });
    view.render(state([row("1", "1", true)], { open: false }));
    expect(host.querySelector<HTMLElement>(".toc-widget")?.hidden).toBe(true);
  });

  it("applies the computed geometry without resizing its host", () => {
    const view = new TocWidgetView({ host, onActivateRow: () => undefined });
    const hostHeightBefore = host.style.height;
    view.render(state([row("1", "1", true)]));
    const widget = host.querySelector<HTMLElement>(".toc-widget");
    expect(widget?.style.width).toBe("300px");
    expect(widget?.style.top).toBe("12px");
    expect(widget?.style.right).toBe("12px");
    // The overlay floats; it must never change the reader surface box.
    expect(host.style.height).toBe(hostHeightBefore);
  });

  it("renders an enabled row as a pressable button", () => {
    const view = new TocWidgetView({ host, onActivateRow: () => undefined });
    view.render(state([row("1", "1", true)]));
    const button = host.querySelector<HTMLButtonElement>(".toc-widget-title");
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.disabled).toBe(false);
    // Narrator reads the selector with the title.
    expect(button?.getAttribute("aria-label")).toBe("1. Row 1");
  });

  it("renders an invalid-destination row visible but disabled and selector-less", () => {
    const view = new TocWidgetView({ host, onActivateRow: () => undefined });
    view.render(state([row("x", undefined, false)]));
    const button = host.querySelector<HTMLButtonElement>(".toc-widget-title");
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(host.querySelector(".toc-widget-selector")?.textContent).toBe("");
    // The row stays in the hierarchy rather than disappearing.
    expect(host.querySelectorAll(".toc-widget-row")).toHaveLength(1);
  });

  it("indents a child row by exactly six pixels", () => {
    const view = new TocWidgetView({ host, onActivateRow: () => undefined });
    view.render(state([row("1", "1", true, 0), row("2", "2", true, 1)]));
    const titles = [...host.querySelectorAll<HTMLElement>(".toc-widget-title")];
    expect(titles[0]?.style.paddingLeft).toBe("0px");
    expect(titles[1]?.style.paddingLeft).toBe("6px");
  });

  it("marks the current row for both styling and assistive technology", () => {
    const view = new TocWidgetView({ host, onActivateRow: () => undefined });
    view.render(state([row("1", "1", true), row("2", "2", true)]));
    const rows = [...host.querySelectorAll<HTMLElement>(".toc-widget-row")];
    expect(rows[0]?.dataset.current).toBe("true");
    expect(rows[0]?.querySelector(".toc-widget-title")?.getAttribute("aria-current")).toBe("true");
    expect(rows[1]?.dataset.current).toBeUndefined();
  });

  it("shows an empty state for a PDF with no embedded outline", () => {
    const view = new TocWidgetView({ host, onActivateRow: () => undefined });
    view.render(state([], { empty: true }));
    expect(host.querySelector("[data-testid='toc-widget-empty']")?.textContent).toBe("No table of contents");
  });

  it("announces the pending selector politely", () => {
    const view = new TocWidgetView({ host, onActivateRow: () => undefined });
    view.render(state([row("1", "1", true)], { pendingSelector: "12" }));
    const footer = host.querySelector<HTMLElement>("[data-testid='toc-widget-footer']");
    expect(footer?.textContent).toBe("12");
    // Polite, so it cannot interrupt the reader.
    expect(footer?.getAttribute("aria-live")).toBe("polite");
  });
});

describe("TocWidgetView interaction", () => {
  it("activates an enabled row on click", () => {
    const onActivateRow = vi.fn();
    const view = new TocWidgetView({ host, onActivateRow });
    const enabled = row("1", "1", true);
    view.render(state([enabled]));
    host.querySelector<HTMLButtonElement>(".toc-widget-title")?.click();
    expect(onActivateRow).toHaveBeenCalledWith(enabled);
  });

  it("does not activate a disabled row on click", () => {
    const onActivateRow = vi.fn();
    const view = new TocWidgetView({ host, onActivateRow });
    view.render(state([row("x", undefined, false)]));
    host.querySelector<HTMLButtonElement>(".toc-widget-title")?.click();
    expect(onActivateRow).not.toHaveBeenCalled();
  });

  it("never takes focus from the reader surface", () => {
    const view = new TocWidgetView({ host, onActivateRow: () => undefined });
    view.render(state([row("1", "1", true)]));
    // tabIndex -1 keeps the widget out of the reader's Tab order.
    expect(host.querySelector<HTMLButtonElement>(".toc-widget-title")?.tabIndex).toBe(-1);
  });
});

describe("TocWidgetView lifecycle", () => {
  it("re-raises above a canvas appended after the widget", () => {
    // The documented blocker: a tab replacement leaves the overlay under the canvas.
    const view = new TocWidgetView({ host, onActivateRow: () => undefined });
    view.render(state([row("1", "1", true)]));
    const canvas = document.createElement("canvas");
    host.append(canvas);
    expect(host.lastElementChild).toBe(canvas);

    view.raise();
    expect(host.lastElementChild).toBe(host.querySelector(".toc-widget"));
  });

  it("reuses the same element instead of recreating it", () => {
    const view = new TocWidgetView({ host, onActivateRow: () => undefined });
    view.render(state([row("1", "1", true)]));
    const first = host.querySelector(".toc-widget");
    view.render(state([row("2", "2", true)]));
    expect(host.querySelector(".toc-widget")).toBe(first);
    expect(host.querySelectorAll(".toc-widget")).toHaveLength(1);
  });

  it("removes itself on disposal and ignores later renders", () => {
    const view = new TocWidgetView({ host, onActivateRow: () => undefined });
    view.render(state([row("1", "1", true)]));
    view.dispose();
    expect(host.querySelector(".toc-widget")).toBeNull();
    view.render(state([row("1", "1", true)]));
    expect(host.querySelector(".toc-widget")).toBeNull();
  });
});
