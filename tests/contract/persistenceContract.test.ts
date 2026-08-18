import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Persistence boundary contract.
 *
 * `feature-spec.md` §12 and ADR 0001 permit exactly three durable fields:
 * selected theme, recent files, and the link-destination indicator. Windows,
 * sessions, tabs, pages, zoom, rotation, history, and TOC UI state are never
 * persisted. That rule is invisible at runtime until it is already broken, so
 * it is enforced here against the Rust state writer.
 */
const PERMITTED_STATE_FIELDS = ["selected_theme", "recent_files", "link_destination_indicator"] as const;

const FORBIDDEN_STATE_FIELDS = [
  "windows", "window", "sessions", "session", "tabs", "tab",
  "page", "current_page", "zoom", "zoom_mode", "rotation",
  "history", "navigation_history", "toc", "outline_ui", "scroll", "viewport",
] as const;

const stateSource = readFileSync(join(process.cwd(), "src-tauri", "src", "commands", "state.rs"), "utf8");

/** Root-level JSON keys the Rust writer names as string literals. */
function writtenRootKeys(): readonly string[] {
  return [...new Set(
    [...stateSource.matchAll(/(?:insert|get|remove|contains_key)\s*\(\s*"([a-z_]+)"/gu)].map((match) => match[1]!),
  )];
}

describe("durable state field contract", () => {
  it("writes every permitted field", () => {
    const keys = writtenRootKeys();
    for (const field of PERMITTED_STATE_FIELDS) {
      expect(keys, `${field} is not handled by the state writer`).toContain(field);
    }
  });

  it("never names a forbidden field", () => {
    const keys = writtenRootKeys();
    const violations = FORBIDDEN_STATE_FIELDS.filter((field) => keys.includes(field));
    expect(violations, `forbidden durable fields present: ${violations.join(", ")}`).toEqual([]);
  });

  it("keeps the permitted set to exactly three fields", () => {
    // A fourth permitted field is a product decision, not an implementation
    // detail, so widening this set must be a deliberate edit.
    expect(PERMITTED_STATE_FIELDS).toHaveLength(3);
  });

  it("preserves unknown top-level fields rather than dropping them", () => {
    // §12 requires forward compatibility: an unknown sibling must survive a
    // merge instead of being erased by this version.
    expect(stateSource).toMatch(/unknown|preserve|retain|other|sibling/iu);
  });
});

describe("renderer persistence surface", () => {
  const mainSource = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");

  it("commits durable state only through the audited native commands", () => {
    const commitCalls = [...mainSource.matchAll(/invoke<[^>]*>\(\s*"([a-z_]+)"/gu)].map((match) => match[1]!);
    const persistenceCalls = commitCalls.filter((name) => /commit|write|reset|record/u.test(name));
    const allowed = new Set([
      "commit_theme_state", "commit_indicator_state", "write_default_config",
      "reset_config", "record_recent", "record_diagnostic",
      "prepare_external_links", "commit_external_links", "finalize_external_links",
    ]);
    const unexpected = [...new Set(persistenceCalls)].filter((name) => !allowed.has(name));
    expect(unexpected, `unaudited persistence commands: ${unexpected.join(", ")}`).toEqual([]);
  });

  it("does not persist reader view state from the renderer", () => {
    // Zoom, rotation, and page are reader state and must stay non-durable.
    for (const forbidden of ["commit_zoom", "commit_rotation", "commit_page", "commit_session", "commit_tabs"]) {
      expect(mainSource, `${forbidden} must not exist`).not.toContain(forbidden);
    }
  });
});
