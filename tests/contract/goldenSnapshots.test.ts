import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BASELINE_SHA = "0f7ff0b54c3674c48f6b555261f939397cfbfb88";
const PRODUCT_DEFAULTS_FINGERPRINT =
  "ea7b922dd96632e1a4a35df4e148f55f9b1ddc224dd7d61549242b60ef0f5344";
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
  "tab.select.1",
  "tab.select.2",
  "tab.select.3",
  "tab.select.4",
  "tab.select.5",
  "tab.select.6",
  "tab.select.7",
  "tab.select.8",
  "tab.select.9",
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
  "update.show"
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
const ALLOWED_PARITY_STATUSES = new Set([
  "not-started",
  "partial",
  "parity",
  "intentional-delta",
  "blocked",
]);

async function json(path: string) {
  return JSON.parse(await readFile(join(process.cwd(), path), "utf8"));
}

const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("v0.10.0 golden snapshots", () => {
  it("freezes all 49 Windows action identifiers and separates fixed bindings", async () => {
    const actions = await json("tests/contract/snapshots/action-ids.json");
    const defaults = await json(
      "tests/contract/snapshots/product-defaults.json",
    );
    expect(
      fingerprint(defaults),
      "complete product-default snapshot changed",
    ).toBe(PRODUCT_DEFAULTS_FINGERPRINT);
    expect(actions.schemaVersion).toBe(1);
    expect(actions.baseline.sha).toBe(BASELINE_SHA);
    expect(actions.count).toBe(49);
    expect(actions.ids).toEqual(ACTION_IDS);
    expect(new Set(actions.ids).size).toBe(49);

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
    expect(configurable).toHaveLength(45);
    expect(new Set([...configurable, ...fixed])).toEqual(new Set(ACTION_IDS));
    expect(defaults.configurableKeyTemplates["document.open"]).toEqual(["<C-S-o>"]);
    expect(defaults.configurableKeyTemplates["document.open"]).not.toContain("<C-o>");
    expect(defaults.configurableKeyTemplates["app.quit"]).toEqual(["<A-F4>"]);
    expect(defaults.configurableKeyTemplates["history.back"]).toEqual([
      "<A-Left>",
    ]);
    expect(defaults.configurableKeyTemplates["history.forward"]).toEqual([
      "<A-Right>",
    ]);
    expect(defaults.config.defaults.input).toEqual({
      prefixTimeoutMilliseconds: 400,
      prefix: "<C-b>",
    });
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
    expect(themes.baseline.sha).toBe(BASELINE_SHA);
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
    expect(defaults.baseline.sha).toBe(BASELINE_SHA);
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

  it("keeps every feature and delivery phase classified by the approved vocabulary", async () => {
    const matrix = await readFile(
      join(process.cwd(), "docs", "parity-matrix.md"),
      "utf8",
    );
    const featureRows = matrix.match(/^\| (?:[1-9]|1[0-5])\. /gm) ?? [];
    const phaseRows = matrix.match(/^\| W(?:0[0-9]|1[0-3]) \|/gm) ?? [];
    expect(featureRows).toHaveLength(15);
    expect(phaseRows).toHaveLength(14);
    for (const row of matrix
      .split("\n")
      .filter((line) =>
        /^\| (?:[1-9]|1[0-5])\. |^\| W(?:0[0-9]|1[0-3]) \|/.test(line),
      )) {
      const status = row.match(
        /`(not-started|partial|parity|intentional-delta|blocked)`/,
      )?.[1];
      expect(ALLOWED_PARITY_STATUSES.has(status ?? ""), row).toBe(true);
    }
    expect(matrix).toContain("historical v0.5.0 evidence only");
    expect(matrix).toContain("## Immutable supersession closure");
    for (const prRow of [
      "#1–#2",
      "#3",
      "#4–#9",
      "#10–#12",
      "#13–#17",
      "#18",
      "#19–#23",
      "#24",
      "#25–#28",
      "#29",
      "#30–#35",
      "#38",
      "#39",
      "#41",
      "#43",
      "#45",
      "#48",
    ]) {
      expect(matrix, `missing supersession audit row ${prRow}`).toContain(
        `| ${prRow} |`,
      );
    }
  });
});
