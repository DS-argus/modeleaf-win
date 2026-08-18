import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const matrix = readFileSync(join(process.cwd(), "docs", "parity-matrix.md"), "utf8");

/**
 * Repository-relative source paths the matrix cites as evidence.
 *
 * The matrix rotted once because it kept citing `src/core/KeyToken.ts`,
 * `KeySequenceEngine.ts`, `defaultBindings.windows.ts`, and
 * `platform/keyboardAdapter.ts` long after the W03 refactor deleted them. A
 * matrix that points at files which do not exist cannot be used to judge
 * scope, so dead citations are a contract failure rather than a style problem.
 */
function citedRepositoryPaths(): readonly string[] {
  const backticked = matrix.match(/`[^`\n]+`/g) ?? [];
  return [...new Set(
    backticked
      .map((token) => token.slice(1, -1).trim())
      .filter((token) => /^(src|src-tauri|tests|tools|docs)\//u.test(token))
      // Golden macOS sources and prose references are not repository paths.
      .filter((token) => !token.endsWith(".swift"))
      // Strip a trailing section reference such as `docs/x.md` §4.
      .map((token) => token.replace(/\s+§.*$/u, "")),
  )];
}

describe("parity matrix integrity", () => {
  it("cites only source paths that exist in the repository", () => {
    const missing = citedRepositoryPaths().filter((path) => !existsSync(join(process.cwd(), path)));
    expect(missing, `parity matrix cites paths that no longer exist: ${missing.join(", ")}`).toEqual([]);
  });

  it("cites at least one real path per delivered phase so rows stay evidence-backed", () => {
    expect(citedRepositoryPaths().length).toBeGreaterThan(20);
  });

  it("uses only the declared status vocabulary", () => {
    const declared = new Set(["not-started", "partial", "parity", "intentional-delta", "blocked"]);
    const statusCells = matrix.match(/\|\s*`([a-z-]+)`\s*\|/gu) ?? [];
    const used = statusCells
      .map((cell) => cell.replace(/[|`\s]/gu, ""))
      // Status columns are the only single-token backticked cells in the tables.
      .filter((token) => /^[a-z-]+$/u.test(token));
    const undeclared = [...new Set(used)].filter((token) => !declared.has(token));
    expect(undeclared, `undeclared status values: ${undeclared.join(", ")}`).toEqual([]);
  });

  it("records the Windows action count and its relationship to the macOS baseline", () => {
    const snapshot = JSON.parse(
      readFileSync(join(process.cwd(), "tests", "contract", "snapshots", "action-ids.json"), "utf8"),
    ) as { readonly count: number; readonly ids: readonly string[] };

    // The matrix must agree with the frozen snapshot, not with stale prose.
    expect(matrix).toContain(`ships **${String(snapshot.count)}**`);
    expect(snapshot.count).toBe(snapshot.ids.length);
    // The macOS baseline count must stay documented so pr-history rows remain readable.
    expect(matrix).toMatch(/macOS[\s\S]{0,80}\*\*61\*\*/u);
    expect(matrix).not.toMatch(/v0\.10\.0 has 61 \(not 58\) actions/u);
  });

  it("does not claim parity for phases that are still unfinished", () => {
    // W10/W12/W13 have no implementation beyond pure domain or a prototype.
    for (const phase of ["W10", "W12", "W13"] as const) {
      const row = matrix.split("\n").find((line) => line.startsWith(`| ${phase} |`));
      expect(row, `${phase} phase row missing`).toBeDefined();
      expect(row).not.toContain("`parity`");
    }
  });

  it("records an audit date so staleness is visible", () => {
    expect(matrix).toMatch(/\*\*Last audited:\*\* \d{4}-\d{2}-\d{2}/u);
  });
});
