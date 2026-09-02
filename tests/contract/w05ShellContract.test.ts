import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const main = source("src/main.ts");
const native = source("src-tauri/src/lib.rs");
const catalog = source("src/application/commands/CommandCatalog.ts");
const palette = source("src/ui/CommandPaletteModel.ts");
const help = source("src/ui/HelpModel.ts");
describe("W05 shell contract", () => {
  it("uses one W03 registry catalog for menu palette help and runtime availability", () => {
    expect(catalog).toContain("ACTION_DESCRIPTORS");
    expect(catalog).toContain("getActionRuntimeAvailability");
    expect(main).toContain("buildWindowsMenuModel(commandAvailabilityContext(), shellConfig)");
    expect(palette).toContain("projectPaletteCommands(context, config, projectionOptions)");
    expect(help).toContain("projectHelpCommands(context, config, projectionOptions)");
    for (const runtimeSource of [main, palette, help]) expect(runtimeSource).not.toContain("defaultBindings.windows");
  });
  it("binds root routing, one overlay owner, empty semantics and all theme tokens", () => {
    expect(main).toContain("createRootKeyboardRouter({");
    expect(main).toContain("createOverlayOwner(SHELL_WINDOW_ID");
    expect(main).toContain('data-testid="empty-reader"');
    expect(main).toContain('data-testid="reader-main"');
    expect(main).toContain('data-testid="reader-status"');
    expect(main).toContain("for (const token of THEME_TOKENS)");
    expect(main).toContain("root.style.setProperty(`--theme-${token}`");
  });
  it("closes only the requesting window after renderer cleanup", () => {
    expect(main).toContain('requestApplicationQuit(false, true, event.payload.requestId)');
    expect(main).toContain('invoke("close_current_window",');
    expect(native).toContain("fn close_current_window(");
    const closeBlock = native.slice(native.indexOf("tauri::WindowEvent::CloseRequested"), native.indexOf("tauri::WindowEvent::Destroyed"));
    expect(closeBlock).toMatch(/window\.emit_to\([\s\S]*?&label,[\s\S]*?"window-close-requested"/);
    expect(closeBlock).toContain("claim_timeout(&label, request_id)");
    expect(main).toContain("{ requestId: closeRequestId, rendererDrained }");
    expect(closeBlock).toContain("DiagnosticEventName::Quit");
    expect(closeBlock).toContain("DiagnosticTag::Timeout");
    expect(main).toContain('invoke("window_close_ready")');
    expect(main).toContain('data-testid="windows-menu"');
    expect(main).not.toContain("ACTION_PENDING:");
    expect(closeBlock).not.toContain('window.label() == "main"');
    expect(closeBlock).not.toContain("begin_quit_application");
  });
  it("binds the durable application-menu owner before overlay claims and disposes it with the shell", () => {
    expect(main).toContain('import { bindApplicationMenuOwner } from "./ui/shell/ApplicationMenuOwner"');
    expect(main).toContain("const applicationMenuOwner = bindApplicationMenuOwner({ menu: windowsMenu");
    const claimOverlay = main.slice(main.indexOf("function claimOverlay"), main.indexOf("function releaseOverlay"));
    expect(claimOverlay).toContain("applicationMenuOwner.close();");
    expect(main).toContain("button.dataset.menuCommand = command.id;");
    expect(main).toContain("applicationMenuOwner.dispose();");
  });
});
