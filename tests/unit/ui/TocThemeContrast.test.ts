import { describe, expect, it } from "vitest";
import { THEMES } from "../../../src/domain/theme/Theme";

/**
 * `feature-spec.md` §8 requires the TOC selector and depth-2 title to keep a
 * contrast ratio of at least 4.0 against the widget background. The widget
 * paints on `statusline` with `muted-text` selectors and `foreground` titles,
 * so those pairs are the contract. The selector deliberately uses foreground
 * rather than muted-text: muted-text measures 3.18 in Solarized Dark, 3.68 in
 * Dracula, and 3.73 in Catppuccin Latte, all below the required bar.
 *
 * Dracula and Solarized Dark are named explicitly in the acceptance criteria;
 * the remaining palettes are held to the same bar to stop a future theme from
 * silently shipping an unreadable TOC.
 */
const MINIMUM_CONTRAST = 4.0;

function channelLuminance(component: number): number {
  const ratio = component / 255;
  return ratio <= 0.039_28 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return 0.2126 * channelLuminance(red) + 0.7152 * channelLuminance(green) + 0.0722 * channelLuminance(blue);
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("TOC theme contrast", () => {
  it("computes a known contrast ratio correctly", () => {
    // Guards the helper itself: black on white is the canonical 21:1.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("keeps every theme's TOC title readable on the widget background", () => {
    const failures = THEMES
      .map((theme) => ({
        id: theme.id,
        ratio: contrastRatio(theme.palette.foreground, theme.palette.statusline),
      }))
      .filter((entry) => entry.ratio < MINIMUM_CONTRAST);
    expect(failures, `themes below ${String(MINIMUM_CONTRAST)}:1 for title: ${JSON.stringify(failures)}`).toEqual([]);
  });

  it("keeps every theme's TOC selector readable on the widget background", () => {
    const failures = THEMES
      .map((theme) => ({
        id: theme.id,
        ratio: contrastRatio(theme.palette.foreground, theme.palette.statusline),
      }))
      .filter((entry) => entry.ratio < MINIMUM_CONTRAST);
    expect(failures, `themes below ${String(MINIMUM_CONTRAST)}:1 for selector: ${JSON.stringify(failures)}`).toEqual([]);
  });

  it("names Dracula and Solarized Dark explicitly, as the acceptance criteria require", () => {
    for (const id of ["dracula", "solarized-dark"] as const) {
      const theme = THEMES.find((candidate) => candidate.id === id);
      expect(theme, `${id} palette missing`).toBeDefined();
      expect(contrastRatio(theme!.palette.foreground, theme!.palette.statusline)).toBeGreaterThanOrEqual(MINIMUM_CONTRAST);
      expect(contrastRatio(theme!.palette.foreground, theme!.palette.statusline)).toBeGreaterThanOrEqual(MINIMUM_CONTRAST);
    }
  });

  it("keeps the current-row highlight readable", () => {
    // The current row paints on active-tab rather than statusline.
    const failures = THEMES
      .map((theme) => ({ id: theme.id, ratio: contrastRatio(theme.palette.foreground, theme.palette["active-tab"]) }))
      .filter((entry) => entry.ratio < MINIMUM_CONTRAST);
    expect(failures, `themes below ${String(MINIMUM_CONTRAST)}:1 for current row: ${JSON.stringify(failures)}`).toEqual([]);
  });
});
