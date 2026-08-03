import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_ID,
  THEME_IDS,
  adoptDurableThemeState,
  THEME_TOKENS,
  THEMES,
  isThemeId,
  themeForId,
} from "../../../src/core/Theme";

const expectedPalettes = {
  "tokyo-night": { "background": "#1A1B26", "foreground": "#C0CAF5", "muted-text": "#9AA5CE", "border": "#3B4261", "accent": "#7AA2F7", "active-tab": "#24283B", "inactive-tab": "#16161E", "statusline": "#101014", "error": "#F7768E", "search-highlight": "#E0AF68", "active-search-highlight": "#FF9E64", "focus-indicator": "#7AA2F7" },
  "gruvbox-dark": { "background": "#282828", "foreground": "#EBDBB2", "muted-text": "#A89984", "border": "#504945", "accent": "#83A598", "active-tab": "#3C3836", "inactive-tab": "#1D2021", "statusline": "#1D2021", "error": "#FB4934", "search-highlight": "#FABD2F", "active-search-highlight": "#FE8019", "focus-indicator": "#83A598" },
  "solarized-dark": { "background": "#002B36", "foreground": "#839496", "muted-text": "#586E75", "border": "#0B4F5E", "accent": "#268BD2", "active-tab": "#073642", "inactive-tab": "#001F27", "statusline": "#001F27", "error": "#DC322F", "search-highlight": "#B58900", "active-search-highlight": "#CB4B16", "focus-indicator": "#268BD2" },
  "dracula": { "background": "#282A36", "foreground": "#F8F8F2", "muted-text": "#6272A4", "border": "#44475A", "accent": "#BD93F9", "active-tab": "#44475A", "inactive-tab": "#21222C", "statusline": "#191A21", "error": "#FF5555", "search-highlight": "#F1FA8C", "active-search-highlight": "#FFB86C", "focus-indicator": "#BD93F9" },
  "everforest": { "background": "#2D353B", "foreground": "#D3C6AA", "muted-text": "#859289", "border": "#475258", "accent": "#A7C080", "active-tab": "#343F44", "inactive-tab": "#232A2E", "statusline": "#232A2E", "error": "#E67E80", "search-highlight": "#DBBC7F", "active-search-highlight": "#E69875", "focus-indicator": "#A7C080" },
  "catppuccin-latte": { "background": "#EFF1F5", "foreground": "#4C4F69", "muted-text": "#6C6F85", "border": "#BCC0CC", "accent": "#1E66F5", "active-tab": "#DCE0E8", "inactive-tab": "#E6E9EF", "statusline": "#DCE0E8", "error": "#D20F39", "search-highlight": "#DF8E1D", "active-search-highlight": "#FE640B", "focus-indicator": "#1E66F5" },
} as const;

describe("Theme", () => {
  it("snapshots the exact upstream IDs and token schema", () => {
    expect(THEME_IDS).toMatchInlineSnapshot(`
      [
        "tokyo-night",
        "gruvbox-dark",
        "solarized-dark",
        "dracula",
        "everforest",
        "catppuccin-latte",
      ]
    `);
    expect(THEME_TOKENS).toMatchInlineSnapshot(`
      [
        "background",
        "foreground",
        "muted-text",
        "border",
        "accent",
        "active-tab",
        "inactive-tab",
        "statusline",
        "error",
        "search-highlight",
        "active-search-highlight",
        "focus-indicator",
      ]
    `);
  });

  it("freezes every exact upstream palette and display name", () => {
    expect(THEMES.map((theme) => ({ id: theme.id, displayName: theme.displayName, palette: theme.palette }))).toEqual([
      { id: "tokyo-night", displayName: "Tokyo Night", palette: expectedPalettes["tokyo-night"] },
      { id: "gruvbox-dark", displayName: "Gruvbox Dark", palette: expectedPalettes["gruvbox-dark"] },
      { id: "solarized-dark", displayName: "Solarized Dark", palette: expectedPalettes["solarized-dark"] },
      { id: "dracula", displayName: "Dracula", palette: expectedPalettes.dracula },
      { id: "everforest", displayName: "Everforest", palette: expectedPalettes.everforest },
      { id: "catppuccin-latte", displayName: "Catppuccin Latte", palette: expectedPalettes["catppuccin-latte"] },
    ]);
  });

  it("has exactly one complete immutable palette per unique ID and defaults to Tokyo Night", () => {
    expect(DEFAULT_THEME_ID).toBe("tokyo-night");
    expect(new Set(THEME_IDS).size).toBe(6);
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(6);
    expect(Object.isFrozen(THEMES)).toBe(true);
    for (const theme of THEMES) {
      expect(Object.keys(theme.palette).sort()).toEqual([...THEME_TOKENS].sort());
      expect(Object.isFrozen(theme)).toBe(true);
      expect(Object.isFrozen(theme.palette)).toBe(true);
    }
  });

  it("only accepts built-in IDs", () => {
    expect(isThemeId("dracula")).toBe(true);
    expect(isThemeId("custom")).toBe(false);
    expect(themeForId("dracula").displayName).toBe("Dracula");
  });
  it("never lets a delayed read or conflicting equal revision replace newer durable state", () => {
    const initial = { themeId: "tokyo-night", revision: 0 } as const;
    const newer = { themeId: "dracula", revision: 2 } as const;
    expect(adoptDurableThemeState(initial, newer)).toBe(newer);
    expect(adoptDurableThemeState(newer, { themeId: "everforest", revision: 1 })).toBe(newer);
    expect(adoptDurableThemeState(newer, { themeId: "everforest", revision: 2 })).toBe(newer);
    expect(adoptDurableThemeState(newer, { themeId: "dracula", revision: 2 })).toBe(newer);
  });
});
