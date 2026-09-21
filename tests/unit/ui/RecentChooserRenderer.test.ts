// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecentChooserRenderer } from "../../../src/ui/RecentChooserRenderer";
import { chooserRows, createOpenChooser } from "../../../src/ui/OpenChooserModel";

const entries = [
  { recentId: "recent-a", displayName: "report.pdf", displayPath: `C:\\QA\\${"Long-folder\\".repeat(20)}report.pdf` },
  { recentId: "recent-b", displayName: `${"긴보고서".repeat(30)}.pdf`, displayPath: `\\\\server.example.invalid\\share$\\folder\\${"긴보고서".repeat(30)}.pdf` },
];
const rows = () => chooserRows(createOpenChooser({ tag: "READY", snapshot: { revision: "1", entries } }));
function harness() {
  const style = document.createElement("style");
  style.textContent = ".file-opener-entry{font:13px sans-serif;padding:6px 9px}";
  document.head.append(style);
  const list = document.createElement("ul"); document.body.append(list);
  let width = 300;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  Object.defineProperty(list, "clientHeight", { configurable: true, value: 90 });
  const measureText = vi.fn((text: string) => ({ width: Array.from(text).length * 7 }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ font: "", measureText } as unknown as CanvasRenderingContext2D);
  const activate = vi.fn();
  const renderer = createRecentChooserRenderer(list, activate);
  return { renderer, list, activate, measureText, resize(value: number) { width = value; }, cleanup() { renderer.stop(); style.remove(); list.remove(); } };
}
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("RecentChooserRenderer", () => {
  it("moves selection without rebuilding rows, replacing text or refitting paths", () => {
    const h = harness();
    try {
      h.renderer.render(rows(), 1);
      const buttons = [...h.list.querySelectorAll<HTMLButtonElement>("button")];
      const text = buttons.map(button => button.textContent);
      const replace = vi.spyOn(h.list, "replaceChildren"); h.measureText.mockClear();
      for (let index = 0; index < 30; index += 1) h.renderer.render(rows(), index % 3);
      expect([...h.list.querySelectorAll("button")]).toEqual(buttons);
      expect(buttons.map(button => button.textContent)).toEqual(text);
      expect(replace).not.toHaveBeenCalled();
      expect(h.measureText).not.toHaveBeenCalled();
      expect(buttons[2]!.getAttribute("aria-selected")).toBe("true");
      expect(buttons.every(button => button.style.fontSize === "")).toBe(true);
    } finally { h.cleanup(); }
  });

  it("fits aliases at fixed font while preserving canonical tooltip and opaque selection", () => {
    const h = harness();
    try {
      h.renderer.render(rows(), 2, undefined, new Map([["recent-b", `V:\\${entries[1]!.displayName}`]]));
      const button = h.list.querySelectorAll<HTMLButtonElement>(".file-opener-recent")[1]!;
      expect(button.textContent).toContain("…");
      expect(button.textContent).toMatch(/\.pdf$/);
      expect(button.title).toBe(entries[1]!.displayPath);
      expect(button.getAttribute("aria-label")).toBe(`V:\\${entries[1]!.displayName}`);
      expect(getComputedStyle(button).fontSize).toBe("13px");
      button.click(); expect(h.activate).toHaveBeenLastCalledWith(2);
      h.renderer.render([rows()[0]!, rows()[2]!, rows()[1]!], 1);
      expect(h.list.querySelectorAll(".file-opener-recent")[0]).toBe(button);
      button.click(); expect(h.activate).toHaveBeenLastCalledWith(1);
    } finally { h.cleanup(); }
  });

  it("recomputes only when width/content changes and restores full text at a larger width", () => {
    const h = harness();
    try {
      h.renderer.render(rows(), 1);
      const button = h.list.querySelector<HTMLButtonElement>(".file-opener-recent")!;
      expect(button.textContent).toContain("…");
      h.measureText.mockClear(); h.resize(5_000); h.renderer.render(rows(), 1);
      expect(h.measureText).toHaveBeenCalled();
      expect(button.textContent).toBe(entries[0]!.displayPath);
      expect(getComputedStyle(button).fontSize).toBe("13px");
      h.renderer.render(rows(), 1, "Safe failure code");
      const message = h.list.querySelector(".file-opener-diagnostic")!;
      expect(message.getAttribute("aria-live")).toBe("polite");
      h.renderer.render(rows(), 2, "Safe failure code");
      expect(h.list.querySelector(".file-opener-diagnostic")).toBe(message);
      h.renderer.render([rows()[0]!], 0);
      expect(h.list.querySelector(".file-opener-recents-heading")).toBeNull();
    } finally { h.cleanup(); }
  });

  it("scrolls only the owned vertical list rather than invoking ancestor/horizontal scrolling", () => {
    const h = harness();
    try {
      h.renderer.render(rows(), 0);
      const button = h.list.querySelectorAll<HTMLButtonElement>("button")[2]!;
      vi.spyOn(h.list, "getBoundingClientRect").mockReturnValue({ top: 10 } as DOMRect);
      vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ top: 110, bottom: 140 } as DOMRect);
      h.list.scrollLeft = 7;
      h.renderer.render(rows(), 2);
      expect(h.list.scrollTop).toBe(40);
      expect(h.list.scrollLeft).toBe(7);
    } finally { h.cleanup(); }
  });
});
