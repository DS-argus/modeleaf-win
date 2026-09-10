import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CANONICAL_DEFAULT_CONFIG_TOML, parseAndValidateConfigToml } from "../../src/domain/config/ConfigFile";

const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("W04 native services contract", () => {
  it("uses Rust-owned fixed config and local-state paths without legacy split stores", () => {
    const lib = source("src-tauri/src/lib.rs");
    expect(lib).toContain('app.path().app_config_dir()?');
    expect(lib).toContain('app.path().app_local_data_dir()?');
    expect(lib).toContain('join("config.toml")');
    expect(lib).toContain('join("state.json")');
    expect(lib).not.toMatch(/recent\.json|theme-state\.json/);
  });

  it("keeps the persisted state field ownership exact and narrow", () => {
    const state = source("src-tauri/src/commands/state.rs");
    for (const key of ["selected_theme", "recent_files", "link_destination_indicator"]) expect(state).toContain(`"${key}"`);
    for (const forbidden of ["sessions", "windows", "tabs", "page", "zoom", "rotation", "history", "toc"]) expect(state).not.toMatch(new RegExp(`insert\\(\\"${forbidden}\\"`));
  });

  it("keeps config bytes bounded and parsing/product validation in TypeScript", () => {
    const config = source("src-tauri/src/commands/config.rs");
    expect(config).toContain("256 * 1024");
    expect(config).not.toMatch(/toml::|ConfigValidator/);
    expect(parseAndValidateConfigToml(CANONICAL_DEFAULT_CONFIG_TOML)).toMatchObject({ ok: true });
  });

  it("opens source PDFs through read-only handles and one frozen source service", () => {
    const sessions = source("src-tauri/src/pdf_session.rs");
    expect(sessions).toContain("File::open(path)");
    expect(sessions).not.toMatch(/OpenOptions::new\(\)[\s\S]{0,160}write\(true\)/);
    const main = source("src/main.ts");
    expect(main).toContain("const shellOpen = createShellOpenCoordinator");
    expect(main).toContain("adopt: adoptRequest");
    expect(main).toContain("recordRecentDocument(invoke, pending.request.sessionId, pending.request.documentGeneration, pending.request.ownerGeneration)");
    expect(source("src/platform/OpenRequestClient.ts")).toContain("MISSING_FILE");
  });

  it("keeps IPC narrow and excludes generic filesystem capabilities", () => {
    const facade = source("src/platform/tauri-commands.ts");
    expect(facade).toMatch(/read_config|write_default_config|reset_config/);
    expect(facade).not.toMatch(/read_indicator_state|commit_indicator_state/);
    expect(source("src-tauri/src/lib.rs")).not.toMatch(/read_indicator_state|commit_indicator_state/);
    expect(facade).not.toMatch(/read_file|write_file|remove_file|shell|process|open_path/);
    const capability = source("src-tauri/capabilities/default.json");
    expect(capability).not.toMatch(/fs:|shell:|process:|opener:/);
  });
});
