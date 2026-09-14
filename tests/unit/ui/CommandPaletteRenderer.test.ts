// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderCommandPalette } from "../../../src/ui/CommandPaletteRenderer";
import { moveCommandPaletteIndex, type CommandPaletteCommandEntry } from "../../../src/ui/CommandPaletteModel";

const entries: readonly CommandPaletteCommandEntry[] = [
  { kind: "command", id: "document.open", category: "document", label: "Open PDF", shortcut: "Ctrl+Shift+O", enabled: true },
  { kind: "command", id: "palette.open", category: "application", label: "Command Palette", shortcut: "Ctrl+Shift+P", enabled: true },
  { kind: "command", id: "document.print", category: "document", label: "Print", shortcut: "Ctrl+P", enabled: false, disabledReason: "Open a PDF first" },
];

describe("CommandPaletteRenderer", () => {
  it("inserts non-focusable headings without changing command indices", () => {
    const list = document.createElement("ul");
    const activate = vi.fn();
    renderCommandPalette(list, entries, 1, "", activate);
    expect([...list.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["Document", "Application", "Document — Unavailable"]);
    expect([...list.querySelectorAll("h2")].every((h) => h.tabIndex === -1)).toBe(true);
    expect([...list.querySelectorAll("h2")].every((h) => h.parentElement?.getAttribute("role") === "presentation")).toBe(true);
    list.querySelector("h2")!.click();
    expect(activate).not.toHaveBeenCalled();
    const buttons = [...list.querySelectorAll("button")];
    expect(buttons).toHaveLength(entries.length);
    expect(buttons.map((button) => button.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    buttons[1]!.click();
    expect(activate).toHaveBeenCalledExactlyOnceWith(1);
    expect(moveCommandPaletteIndex(1, buttons.length, "next")).toBe(2);
    expect(moveCommandPaletteIndex(2, buttons.length, "next")).toBe(0);
  });

  it("removes headings while searching and restores them after clearing the query", () => {
    const list = document.createElement("ul");
    renderCommandPalette(list, entries, 0, "", vi.fn());
    renderCommandPalette(list, entries.slice(1), 0, "command", vi.fn());
    expect(list.querySelector("h2")).toBeNull();
    expect(list.children).toHaveLength(2);
    expect(list.querySelector(".command-palette-entry-label")?.textContent).toBe("Command Palette");
    list.scrollTop = 200;
    renderCommandPalette(list, entries, 0, " \t", vi.fn());
    expect(list.querySelectorAll("h2")).toHaveLength(3);
    expect(list.scrollTop).toBe(0);
    renderCommandPalette(list, [], 0, "no match", vi.fn());
    expect(list.childElementCount).toBe(0);
  });

  it("renders adjacent-category headings once and preserves safe labels and disabled reasons", () => {
    const list = document.createElement("ul");
    renderCommandPalette(list, [entries[0]!, { ...entries[0]!, label: "<img src=x onerror=bad>" }, entries[2]!], 2, "", vi.fn());
    expect(list.querySelectorAll("h2")).toHaveLength(2);
    expect(list.querySelector("img")).toBeNull();
    const disabled = list.querySelector('[aria-disabled="true"]')!;
    expect(disabled.getAttribute("aria-description")).toBe("Open a PDF first");
    expect(disabled.querySelector(".command-palette-entry-reason")?.textContent).toBe("Open a PDF first");
    expect(disabled.children[0]?.className).toBe("command-palette-entry-label");
    expect(disabled.children[1]?.className).toBe("command-palette-entry-shortcut");
    expect(disabled.children[2]?.className).toBe("command-palette-entry-reason");
  });
});
