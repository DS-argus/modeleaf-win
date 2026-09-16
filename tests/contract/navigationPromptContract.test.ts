import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const main = source("src/main.ts");
const styles = source("src/styles/app.css");
function mediaBlock(css: string, header: string): string {
  const start = css.indexOf(header);
  if (start < 0) throw new Error(`missing media block: ${header}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}" && --depth === 0) return css.slice(start, index + 1);
  }
  throw new Error(`unterminated media block: ${header}`);
}

describe("keyboard navigation and page prompt contract", () => {
  it("routes adjacent pages through verified session navigation and restores reader focus", () => {
    expect(main).toContain("payload.session.navigateAdjacentPage(direction)");
    expect(main).toContain('if (type === "page.next" || type === "page.previous")');
    expect(main).toContain("payload.host.focus({ preventScroll: true })");
    expect(main).toContain("queueRelativeTabActivation(direction, queueWorkspaceActivation");
    expect(main).toContain("performTabActivation(id");
    expect(main).toContain('if (type === "tab.next") { void switchAdjacentTab(1); return; }');
  });

  it("keeps the go-to-page prompt separate from the status row", () => {
    expect(main).toContain('id="prompt" class="prompt" role="group" aria-label="Go to page"');
    expect(styles).toContain("grid-template-rows: auto auto minmax(0, 1fr) 26px");
    expect(styles).not.toContain("grid-template-rows: auto 1fr auto 28px");
    expect(styles).toContain("#reader-main { grid-row: 3; min-height: 0; }");
    expect(styles).toContain(".statusbar { grid-row: 4; }");
    expect(styles).toMatch(/\.prompt \{[\s\S]*position: absolute;[\s\S]*bottom: 40px;[\s\S]*width: clamp\(360px, calc\(100vw - 48px\), 520px\);/u);
    expect(styles).toContain(".prompt[hidden] { display: none; }");
    const forcedColors = mediaBlock(styles, "@media (forced-colors: active)");
    const promptRule = ".prompt { color: CanvasText; background: Canvas; border-color: CanvasText;";
    expect(forcedColors).toContain(promptRule);
    expect(styles.split(promptRule)).toHaveLength(2);
    expect(styles.match(/@media \(forced-colors: active\)/gu)).toHaveLength(1);
  });

  it("keeps cancel and verified commit bound to the captured tab", () => {
    expect(main).toContain('if (id === "prompt.cancel" && pagePromptTransaction !== undefined)');
    expect(main).toContain("transaction.payload.session.cancelPendingNavigation()");
    expect(main).toContain("transaction.payload.session.navigatePagePrompt(start.page)");
    expect(main).toContain("settlePagePromptCommit(current, start.revision");
    expect(main).toContain("ownsPagePrompt(current)");
    expect(main).toContain("type PagePromptTransaction = PagePromptState<");
    expect(main).toContain("pagePromptTransaction.validationMessage");
  });
  it("clears page-prompt ownership before an open adoption can select another tab", () => {
    expect(main).toContain("withOpenAdoptionOwnership({");
    expect(main).toContain("cancelPagePrompt: cancelPagePromptOwnership");
  });
});
