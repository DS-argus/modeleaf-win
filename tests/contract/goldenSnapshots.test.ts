import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PRODUCT_DEFAULTS_FINGERPRINT =
  "668b85f13dbb55655a2ba502b51c90bf5e7c8597ae8f883f2d149aea863120e4";
const ACTION_IDS = [
  "document.open",
  "document.close",
  "document.print",
  "app.quit",
  "app.new",
  "palette.open",
  "help.show",
  "tab.next",
  "tab.previous",
  "scroll.left",
  "scroll.down",
  "scroll.up",
  "scroll.right",
  "scroll.largeDown",
  "scroll.largeUp",
  "page.next",
  "page.previous",
  "page.first",
  "page.last",
  "page.prompt",
  "history.back",
  "history.forward",
  "prompt.commit",
  "prompt.cancel",
  "search.prompt",
  "search.next",
  "search.previous",
  "search.cancel",
  "links.hint",
  "view.zoomIn",
  "view.zoomOut",
  "view.zoomReset",
  "view.fitWidth",
  "view.fitPage",
  "view.rotateLeft",
  "view.rotateRight",
  "config.reload",
  "config.writeDefault",
  "config.resetDefault",
  "theme.picker",
  "update.show",
  "path.showParent",
  "path.copy"
] as const;
const THEME_IDS = [
  "tokyo-night",
  "gruvbox-dark",
  "solarized-dark",
  "dracula",
  "everforest",
  "nord",
  "catppuccin-latte",
] as const;
const THEME_FINGERPRINTS: Record<string, string> = {
  "tokyo-night":
    "37fb6e92ad4fc1366b42ee184b2c55c99df38c777bebf8a9f45a14931ddd1ed5",
  "gruvbox-dark":
    "2ed26889673fd34ac9bca4b603ab1d51fde08f0d0b5ffeaef9b7caf49b455f7d",
  "solarized-dark":
    "b255bd3e3a7fb4e00bf92d862a050c8c0433170ca2991d4e4618188ed5713879",
  dracula: "f3de6c2aaad92209c2791d262baee8460539beaaa48cebba8990649b03e46f65",
  everforest:
    "439b8e9212fe55a3f7b3a6695d9caa48258cae4d909461b958251e0af9c871eb",
  nord: "a86ecfb5084f59a8015ef0f670336c5e934d5ddbdbfe407665c852203c322181",
  "catppuccin-latte":
    "21a6039a4d7dff2d3ab4c38a873111f35080622de3c9e9ff5cba862968d00e96",
};
async function json(path: string) {
  return JSON.parse(await readFile(join(process.cwd(), path), "utf8"));
}

const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("Windows regression snapshots", () => {
  it("freezes all 43 Windows action identifiers and separates fixed bindings", async () => {
    const actions = await json("tests/contract/snapshots/action-ids.json");
    const defaults = await json(
      "tests/contract/snapshots/product-defaults.json",
    );
    expect(
      fingerprint(defaults),
      "complete product-default snapshot changed",
    ).toBe(PRODUCT_DEFAULTS_FINGERPRINT);
    expect(actions.schemaVersion).toBe(1);
    expect(actions.count).toBe(43);
    expect(actions.ids).toEqual(ACTION_IDS);
    expect(new Set(actions.ids).size).toBe(43);

    const fixed = Object.keys(defaults.fixedBindings).filter(
      (key) => key !== "reason",
    );
    const configurable = Object.keys(defaults.configurableKeyTemplates);
    expect(fixed).toEqual([
      "prompt.commit",
      "prompt.cancel",
      "search.next",
      "search.previous",
    ]);
    expect(configurable).toHaveLength(39);
    expect(new Set([...configurable, ...fixed])).toEqual(new Set(ACTION_IDS));
    expect(defaults.configurableKeyTemplates["document.open"]).toEqual(["<C-S-o>"]);
    expect(defaults.configurableKeyTemplates["document.open"]).not.toContain("<C-o>");
    expect(defaults.configurableKeyTemplates["app.quit"]).toEqual(["<A-F4>"]);
    expect(defaults.configurableKeyTemplates["history.back"]).toEqual([
      "<A-Left>",
      "<C-o>",
    ]);
    expect(defaults.configurableKeyTemplates["history.forward"]).toEqual([
      "<A-Right>",
      "<C-i>",
    ]);
    expect(defaults.config.defaults.input).toEqual({
      prefixTimeoutMilliseconds: 400,
      prefix: "<C-b>",
    });
    expect(defaults.configurableKeyTemplates["view.zoomReset"]).toEqual(["0"]);
    expect(defaults.configurableKeyTemplates["view.zoomReset"]).not.toContain("<C-1>");
    expect(defaults.keyGrammar.modifiers).toEqual({
      C: "Ctrl",
      A: "Alt",
      S: "Shift",
    });
    expect(defaults.keyGrammar.unsupportedModifier).toEqual({
      token: "D",
      result: "migration-error",
    });
  });

  it("freezes seven exact twelve-token palettes including Nord", async () => {
    const themes = await json("tests/contract/snapshots/themes.json");
    expect(themes.schemaVersion).toBe(1);
    expect(themes.themeCount).toBe(7);
    expect(themes.tokenCount).toBe(12);
    expect(themes.themes.map(({ id }: { id: string }) => id)).toEqual(
      THEME_IDS,
    );
    expect(new Set(themes.tokenOrder).size).toBe(12);
    for (const theme of themes.themes) {
      expect(Object.keys(theme.palette)).toEqual(themes.tokenOrder);
      expect(
        Object.values(theme.palette).every(
          (color) => typeof color === "string" && /^#[0-9A-F]{6}$/.test(color),
        ),
      ).toBe(true);
      expect(fingerprint(theme), `${theme.id} palette changed`).toBe(
        THEME_FINGERPRINTS[theme.id],
      );
    }
    expect(
      themes.themes.find(({ id }: { id: string }) => id === "nord")?.palette
        .background,
    ).toBe("#2E3440");
  });

  it("freezes config, caps, and current persistence defaults", async () => {
    const defaults = await json(
      "tests/contract/snapshots/product-defaults.json",
    );
    expect(defaults.config.bounds).toEqual({
      smallScrollPoints: { minimum: 1, maximum: 512 },
      largeScrollViewportFraction: { minimum: 0.1, maximum: 2 },
      zoomFactor: { minimum: 1.01, maximum: 2 },
      prefixTimeoutMilliseconds: { minimum: 100, maximum: 2000 },
    });
    expect(defaults.config.defaults.navigation).toEqual({
      smallScrollPoints: 32,
      largeScrollViewportFraction: 0.8,
      zoomFactor: 1.1,
    });
    expect(defaults.defaultReader).toEqual({
      viewMode: "vertical-continuous",
      zoomMode: "fit-width",
      initialPage: 1,
    });
    expect(defaults.caps).toEqual({
      recentFiles: 15,
      navigationHistoryPositions: 100,
    });
    expect(defaults.themeIds).toEqual(THEME_IDS);
    expect(defaults).not.toHaveProperty("linkDestinationIndicator");
    expect(defaults.persistence.stateOwnedFields).toEqual([
      "selected_theme",
      "recent_files",
    ]);
    expect(defaults.persistence.notPersisted).toContain("windows");
    expect(defaults.persistence.notPersisted).toContain("history");
  });


});
