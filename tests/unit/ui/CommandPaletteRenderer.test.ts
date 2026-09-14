// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderCommandPalette } from "../../../src/ui/CommandPaletteRenderer";
import { moveCommandPaletteIndex, type CommandPaletteCommandEntry } from "../../../src/ui/CommandPaletteModel";

const entries: readonly CommandPaletteCommandEntry[] = [
  { kind: "command", id: "document.open", label: "Open PDF", shortcut: "Ctrl+Shift+o", enabled: true },
  { kind: "command", id: "palette.open", label: "Command Palette", shortcut: "Ctrl+Shift+p", enabled: true },
  { kind: "command", id: "document.print", label: "Print", shortcut: "Ctrl+p", enabled: false, disabledReason: "Open a PDF first" },
];

describe("CommandPaletteRenderer", () => {
  it("renders only command rows and preserves selection and activation indices", () => {
    const list = document.createElement("ul");
    const activate = vi.fn();
    renderCommandPalette(list, entries, 1, activate);
    expect(list.querySelector("h2")).toBeNull();
    expect(list.childElementCount).toBe(entries.length);
    const buttons = [...list.querySelectorAll("button")];
    expect(buttons).toHaveLength(entries.length);
    expect(buttons.map((button) => button.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    buttons[1]!.click();
    expect(activate).toHaveBeenCalledExactlyOnceWith(1);
    expect(moveCommandPaletteIndex(1, buttons.length, "next")).toBe(2);
    expect(moveCommandPaletteIndex(2, buttons.length, "next")).toBe(0);
  });

  it("replaces filtered rows without injecting headings and resets first-selection scrolling", () => {
    const list = document.createElement("ul");
    renderCommandPalette(list, entries, 0, vi.fn());
    renderCommandPalette(list, entries.slice(1), 0, vi.fn());
    expect(list.querySelector("h2")).toBeNull();
    expect(list.children).toHaveLength(2);
    expect(list.querySelector(".command-palette-entry-label")?.textContent).toBe("Command Palette");
    list.scrollTop = 200;
    renderCommandPalette(list, entries, 0, vi.fn());
    expect(list.querySelector("h2")).toBeNull();
    expect(list.scrollTop).toBe(0);
    renderCommandPalette(list, [], 0, vi.fn());
    expect(list.childElementCount).toBe(0);
  });

  it("preserves safe labels and disabled reasons", () => {
    const list = document.createElement("ul");
    renderCommandPalette(list, [{ ...entries[0]!, label: "<img src=x onerror=bad>" }, entries[2]!], 1, vi.fn());
    expect(list.querySelector("img")).toBeNull();
    const disabled = list.querySelector('[aria-disabled="true"]')!;
    expect(disabled.getAttribute("aria-description")).toBe("Open a PDF first");
    expect(disabled.querySelector(".command-palette-entry-reason")?.textContent).toBe("Open a PDF first");
    expect(disabled.children[0]?.className).toBe("command-palette-entry-label");
    expect(disabled.children[1]?.className).toBe("command-palette-entry-shortcut");
    expect(disabled.children[2]?.className).toBe("command-palette-entry-reason");
  });
});
