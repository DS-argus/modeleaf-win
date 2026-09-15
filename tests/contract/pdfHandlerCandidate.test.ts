import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const source = (path: string) => readFile(resolve(root, path), "utf8");


describe("PDF handler candidate registration", () => {
  it("uses Windows Capabilities and RegisteredApplications instead of a default association", async () => {
    const [config, helper, hooks] = await Promise.all([
      source("src-tauri/tauri.conf.json"),
      source("tools/windows/modeleaf-pdf-handler.ps1"),
      source("src-tauri/nsis/pdf-handler-candidate.nsh"),
    ]);

    expect(JSON.parse(config).bundle.fileAssociations).toBeUndefined();
    expect(JSON.parse(config).bundle.windows.nsis.installerHooks).toBe("nsis/pdf-handler-candidate.nsh");
    expect(helper).toContain("Software\\Classes\\Modeleaf.Pdf\\Capabilities");
    expect(helper).toContain("Software\\RegisteredApplications");
    expect(helper).toContain(".pdf\\OpenWithProgids");
    expect(hooks).toContain("Software\\Classes\\Modeleaf.Pdf\\Capabilities");
    expect(hooks).toContain("Software\\RegisteredApplications");
    expect(hooks).toContain("Software\\Classes\\.pdf\\OpenWithProgids");
  });

  it("limits all registration mutations to the Modeleaf allowlist", async () => {
    const [helper, hooks] = await Promise.all([
      source("tools/windows/modeleaf-pdf-handler.ps1"),
      source("src-tauri/nsis/pdf-handler-candidate.nsh"),
    ]);
    for (const path of [
      "$registeredApplicationsPath = 'HKCU:\\Software\\RegisteredApplications'",
      "$classesPath = 'HKCU:\\Software\\Classes'",
      "$capabilitiesPath = 'Software\\Classes\\Modeleaf.Pdf\\Capabilities'",
      "$progId = 'Modeleaf.Pdf'",
      "$openWithProgIdsPath = Join-Path $classesPath '.pdf\\OpenWithProgids'",
    ]) expect(helper).toContain(path);
    const executableHelper = helper.slice(helper.indexOf("Set-StrictMode"));
    expect(executableHelper).not.toMatch(/UserChoice|Hash|SetUserFTA|Applications\\modeleaf\.exe/iu);
    const executableHooks = hooks.slice(hooks.indexOf("!macro"));
    expect(executableHooks).not.toMatch(/UserChoice|Hash|Applications\\modeleaf\.exe/iu);
    expect(hooks).not.toMatch(/WriteRegStr SHCTX "Software\\Classes\\\.pdf" ""/u);
  });

  it("binds commands to an existing installed executable and removes only matching owned registrations", async () => {
    const [helper, hooks, packager] = await Promise.all([
      source("tools/windows/modeleaf-pdf-handler.ps1"),
      source("src-tauri/nsis/pdf-handler-candidate.nsh"),
      source("tools/windows/package-scoop.ps1"),
    ]);

    expect(helper).toContain("Resolve-InstalledExecutable");
    expect(helper).toContain("GetFileName($resolved.Path) -cne 'modeleaf.exe'");
    expect(helper).toContain("$currentCommand -eq $command");
    expect(hooks).toContain('ReadRegStr $R9 SHCTX "Software\\Classes\\Modeleaf.Pdf\\shell\\open\\command" ""');
    expect(hooks).toContain('DeleteRegValue SHCTX "Software\\Classes\\.pdf\\OpenWithProgids" "Modeleaf.Pdf"');
    expect(packager).toContain("modeleaf-pdf-handler.ps1");
  });
});
