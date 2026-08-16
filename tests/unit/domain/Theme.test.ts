import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_ID,
  THEMES,
  THEME_IDS,
  THEME_TOKENS,
  adoptDurableThemeState,
  isThemeId,
  themeForId,
} from "../../../src/domain/theme/Theme";

const snapshot = JSON.parse(readFileSync(join(process.cwd(), "tests/contract/snapshots/themes.json"), "utf8")) as {
  readonly themes: readonly { readonly id: string; readonly displayName: string; readonly palette: Record<string, string> }[];
  readonly tokenOrder: readonly string[];
};

describe("Theme", () => {
  it("matches all seven exact frozen IDs, names, tokens, and palettes", () => {
    expect(THEME_IDS).toEqual(snapshot.themes.map(({ id }) => id));
    expect(THEME_TOKENS).toEqual(snapshot.tokenOrder);
    expect(THEMES).toEqual(snapshot.themes);
    expect(themeForId("nord").palette.background).toBe("#2E3440");
  });

  it("uses Tokyo Night and validates strict IDs", () => {
    expect(DEFAULT_THEME_ID).toBe("tokyo-night");
    expect(isThemeId("nord")).toBe(true);
    expect(isThemeId("Nord")).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });

  it("freezes collections, themes, and palettes", () => {
    expect(Object.isFrozen(THEMES)).toBe(true);
    expect(THEMES.every((theme) => Object.isFrozen(theme) && Object.isFrozen(theme.palette))).toBe(true);
  });

  it("adopts only strictly newer durable revisions", () => {
    const current = { themeId: "nord" as const, revision: 2 };
    expect(adoptDurableThemeState(current, { themeId: "dracula", revision: 3 })).toEqual({ themeId: "dracula", revision: 3 });
    expect(adoptDurableThemeState(current, { themeId: "dracula", revision: 2 })).toBe(current);
    expect(adoptDurableThemeState(current, { themeId: "dracula", revision: 1 })).toBe(current);
  });
});
