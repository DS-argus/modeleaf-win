import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (path: string) => readFile(resolve(root, path), "utf8");

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await read(path)) as Record<string, unknown>;
}

function directive(csp: string, name: string): string[] {
  const entry = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return entry === undefined ? [] : entry.split(/\s+/).slice(1);
}

describe("W01 secure shell contract", () => {
  it("keeps the native main window constrained to the required accessible local shell", async () => {
    const config = await readJson("src-tauri/tauri.conf.json");
    const app = config.app as Record<string, unknown>;
    const windows = app.windows as Array<Record<string, unknown>>;
    const window = windows[0];
    const csp = (app.security as Record<string, unknown>).csp as string;

    expect(windows).toHaveLength(1);
    expect(window).toMatchObject({
      title: "Modeleaf",
      width: 1040,
      height: 760,
      minWidth: 480,
      minHeight: 360,
      decorations: true,
      visible: false,
      additionalBrowserArgs: "--force-renderer-accessibility",
    });
    expect(directive(csp, "default-src")).toEqual(["'self'"]);
    expect(directive(csp, "script-src")).toEqual([]);
    expect(directive(csp, "connect-src")).toEqual([
      "'self'",
      "ipc:",
      "http://ipc.localhost",
    ]);
    expect(directive(csp, "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(csp, "worker-src")).toEqual(["'self'", "blob:"]);
    expect(csp).not.toMatch(/https?:\/\/(?!ipc\.localhost\b)|\bcdn\b|\*/i);
  });

  it("limits the capability to quit-event listening on main and bounded reader windows", async () => {
    const capability = await readJson("src-tauri/capabilities/default.json");
    const serialized = JSON.stringify(capability);

    expect(capability.windows).toEqual(["main", "reader-*"]);
    expect(capability.permissions).toEqual([
      "core:event:allow-listen",
      "core:event:allow-unlisten",
    ]);
    expect(serialized).not.toMatch(/\b(fs|shell|process|opener)(:|\.|-|_)/i);
    expect(serialized).not.toMatch(/\*{2}|\ball\b/i);
  });

  it("keeps app-window creation ordered around workspace ownership and rollback", async () => {
    const source = await read("src-tauri/src/lib.rs");
    const commandStart = source.indexOf("#[tauri::command]\nasync fn create_app_window");
    const command = source.slice(
      commandStart,
      source.indexOf("#[derive(Clone, Default)]\npub struct SecondInstanceIngress", commandStart),
    );
    const claim = command.indexOf("claim_window");
    const environment = command.indexOf('.additional_browser_args("--force-renderer-accessibility")');
    const build = command.indexOf(".build()");
    const setup = command.indexOf("disable_browser_accelerators");
    const show = command.indexOf("window.show()");
    const retain = command.indexOf("windows.retain(window)");
    const nativeSetupStart = source.indexOf(".setup(|app|");
    const nativeSetup = source.slice(nativeSetupStart, source.indexOf(".on_window_event", nativeSetupStart));
    const mainHardening = nativeSetup.indexOf("disable_browser_accelerators(&window)");
    const mainShow = nativeSetup.indexOf("window.show()");

    expect(command).toContain("#[tauri::command]");
    expect(command).toMatch(/async fn create_app_window\s*\(/);
    expect(command).toMatch(/generate_reader_window_label/);
    expect(command).toMatch(/is_shutting_down[\s\S]*?CreateAppWindowError::ShuttingDown/);
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(environment).toBeGreaterThan(claim);
    expect(environment).toBeLessThan(build);
    expect(build).toBeGreaterThan(claim);
    expect(setup).toBeGreaterThan(build);
    expect(show).toBeGreaterThan(setup);
    expect(command.slice(setup, show)).toMatch(/is_shutting_down[\s\S]*?window\.destroy\(\)[\s\S]*?ShuttingDown/);
    expect(retain).toBeGreaterThan(show);
    expect(command.slice(setup)).toMatch(/window\.destroy\(\)[\s\S]*?workspace\.destroy_window/);
    expect(command).toMatch(/WebviewWindowBuilder/);
    expect(command).toMatch(/inner_size\(1040(?:\.0)?,\s*760(?:\.0)?\)/);
    expect(command).toMatch(/min_inner_size\(480(?:\.0)?,\s*360(?:\.0)?\)/);
    expect(command).toMatch(/decorations\(true\)/);
    expect(command).toMatch(/resizable\(true\)/);
    expect(command).toMatch(/fullscreen\(false\)/);
    expect(command).toMatch(/\.title\("Modeleaf"\)/);
    expect(command).toMatch(/\.visible\(false\)/);
    expect(source).toMatch(/\.manage\(AppWindowRegistry::default\(\)\)/);
    expect(source).toMatch(/WindowEvent::Destroyed[\s\S]*?AppWindowRegistry/);
    expect(source).toMatch(/CloseRequested[\s\S]*?window\.label\(\) == "main"[\s\S]*?else[\s\S]*?window\.destroy/);
    expect(source).toMatch(/sync_channel\(1\)[\s\S]*?with_webview[\s\S]*?recv_timeout/);
    expect(mainHardening).toBeGreaterThanOrEqual(0);
    expect(mainShow).toBeGreaterThan(mainHardening);
    expect(source).toMatch(/pending_windows[\s\S]*?acknowledge/);
    const singleInstanceRegistration = source.indexOf(
      ".plugin(tauri_plugin_single_instance::init",
    );
    expect(singleInstanceRegistration).toBeGreaterThanOrEqual(0);
    expect(singleInstanceRegistration).toBeLessThan(source.indexOf(".setup("));
    expect(source.slice(0, singleInstanceRegistration).match(/\.plugin\(/g) ?? []).toHaveLength(0);
    expect(source).toMatch(
      /async fn open_external_link\s*\([\s\S]*?request:\s*ExternalLink/,
    );
    expect(source).toMatch(
      /#\[serde\(rename_all = "camelCase"\)\]\s*struct ExternalLinkActivationRequest/,
    );
  });

  it("pins local toolchains, PDF.js policy, and authoritative local gates", async () => {
    const [toolchain, tsconfig, policy, packageJson] = await Promise.all([
      read("rust-toolchain.toml"),
      read("tsconfig.json"),
      read("src/pdf/PdfJsPolicy.ts"),
      readJson("package.json"),
    ]);
    const scripts = packageJson.scripts as Record<string, string>;
    const engines = packageJson.engines as Record<string, string>;

    expect(toolchain).toMatch(/channel\s*=\s*"1\.97\.1"/);
    expect(toolchain).toMatch(/targets\s*=\s*\["x86_64-pc-windows-msvc"\]/);
    expect(tsconfig).toMatch(/"strict"\s*:\s*true/);
    expect(policy).toMatch(/PDFJS_VERSION\s*=\s*"6\.2\.108"/);
    expect(
      (packageJson.dependencies as Record<string, string>)["pdfjs-dist"],
    ).toBe("6.2.108");
    expect(engines).toEqual({ node: "24.19.0", npm: "11.17.0" });
    expect(scripts["legal:verify"]).toBe(
      "node tools/legal/verify-third-party.mjs",
    );
    expect(scripts["security:verify"]).toBe(
      "npm audit --omit=dev --audit-level=high",
    );
    expect(scripts["gate:w01"]).toContain("npm run legal:verify");
    expect(scripts["gate:w01"]).toContain("npm run security:verify");
    expect(scripts["gate:w01"]).toContain("cargo clippy");
    expect(scripts["gate:w01"]).toContain("cargo test");
    expect(scripts["tauri:build-debug"]).toBe("node tools/tauri/build-debug.mjs");
    expect(scripts["gate:w01"]).toContain("npm run tauri:build-debug");
  });

  it("has no active Windows CI workflow while local gates are authoritative", async () => {
    await expect(
      stat(resolve(root, ".github/workflows/ci-windows.yml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
