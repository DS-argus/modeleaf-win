import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { generateHintLabels } from "../../src/domain/links/LinkHints";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const source = async (): Promise<string> => readFile(resolve(root, "tools/windows/smoke-w06.ps1"), "utf8");
const mainSource = async (): Promise<string> => readFile(resolve(root, "src/main.ts"), "utf8");
const tabActivationSource = async (): Promise<string> => readFile(resolve(root, "src/application/TabActivationCoordinator.ts"), "utf8");
const nativeSource = async (): Promise<string> => readFile(resolve(root, "src-tauri/src/lib.rs"), "utf8");

describe("W06 packaged Windows smoke contract", () => {
  it("projects the committed display annotations to the exact packaged hint labels", async () => {
    const task = getDocument({ data: new Uint8Array(await readFile(resolve(root, "fixtures/pdf/links.pdf"))) });
    try {
      const pdf = await task.promise;
      const annotations = await (await pdf.getPage(1)).getAnnotations({ intent: "display" });
      expect(annotations).toHaveLength(6);
      expect(annotations.map(({ url, unsafeUrl, dest }) => ({ url, unsafeUrl, dest }))).toMatchObject([
        { url: "https://example.invalid/allowed" },
        { unsafeUrl: "file:///C:/forbidden" },
        { dest: expect.any(Array) },
        { dest: expect.any(Array) },
        { dest: "unresolved-destination" },
        { unsafeUrl: expect.stringContaining("foreign.pdf") },
      ]);
      const supported = annotations.filter(({ url, dest }) => typeof url === "string" || dest !== undefined);
      expect(supported).toHaveLength(4);
      expect(generateHintLabels(supported.length)).toEqual(["f", "j", "d", "k"]);
    } finally {
      await task.destroy();
    }
  });

  it("keeps W08 as an explicit fail-closed links fixture scenario bound to immutable authority", async () => {
    const script = await source();
    const linkHints = await readFile(resolve(root, "src/domain/links/LinkHints.ts"), "utf8");
    const manifest = await readFile(resolve(root, "fixtures/manifest.json"), "utf8");
    const porting = await readFile(resolve(root, "docs/windows-porting/feature-spec.md"), "utf8");
    expect(script).toMatch(/\[switch\]\$W08/);
    expect(script).toContain("if($W08){Run-W08Scenario}");
    expect(script).toContain("W08 requires the committed links.pdf fixture");
    expect(script).toContain("if($W08 -and -not $Run){throw 'W08 requires -Run'}");
    expect(script).toContain("dd5e2d598fa9e0bcae25e488541a898220d38b791991bc95796d7ba5f30044d4");
    expect(manifest).toContain('"name": "links.pdf"');
    expect(manifest).toContain('"sha256": "dd5e2d598fa9e0bcae25e488541a898220d38b791991bc95796d7ba5f30044d4"');
    expect(porting).toContain("0f7ff0b54c3674c48f6b555261f939397cfbfb88");
    expect(porting).toContain("PR [#1]");
    expect(porting).toContain("[#23]");
    expect(linkHints).toContain("Accepts Shift/Caps ASCII letters");
    expect(linkHints).toMatch(/input\.altKey \|\| input\.ctrlKey \|\| input\.metaKey \|\| input\.altGraph \|\| input\.isComposing \|\| input\.keyCode === 229/);
    expect(linkHints).toContain("return query.toLowerCase() + input.key.toLowerCase()");
    for (const interaction of ["w08:annotation-authority", "w08:hints-open", "w08:hints-visible", "w08:hints-dismiss", "w08:hints-dismissal"]) expect(script).toContain(interaction);
    expect(script).toContain("exact-four-supported-of-six-display-link-annotations");
    expect(script).toContain("W08 hint overlay did not change the visible reader");
    expect(script).toContain("W08 hint dismissal did not change the visible reader");
    expect(await mainSource()).toContain('invoke<number>("open_external_link"');
    expect(await nativeSource()).toMatch(/open_external_link[\s\S]*Result<u64, ExternalLinkError>[\s\S]*Ok\(operation_sequence\)/);
    expect(script).toContain("Capture-VisualHash 'w08-authority-baseline'");
    expect(script).toContain("$visualHashes['w08-authority-baseline'] -eq $visualHashes['w08-hints-visible']");
    expect(script).toContain("Capture-VisualHash 'w08-hints-visible'");
    expect(script).toContain("Capture-VisualHash 'w08-hints-dismissed'");
    expect(script).toContain("w08CommittedLinksFixtureSha256");
  });
  it("requires explicit run admission and leaves the default route product-free", async () => {
    const script = await source();
    expect(script).toMatch(/CmdletBinding\(DefaultParameterSetName='DryRun'\)/);
    expect(script).toMatch(/\[Parameter\(ParameterSetName='Run'\)\]\[switch\]\$Run/);
    expect(script).toMatch(/if\(-not \$Run\)\s*\{/);
    expect(script).toMatch(/dry-run:helper-timeout-cleanup/);
    expect(script).toMatch(/no-product-process-started/);
  });

  it("binds exact inputs and terminally rechecks immutable fixture bytes", async () => {
    const script = await source();
    expect(script).toMatch(/\$exeHash=Get-Sha256 \$exe;\$scriptHash=Get-Sha256 \$script/);
    expect(script).toMatch(/\$fixtureHash=Get-Sha256 \$pdf/);
    expect(script).toMatch(/function Assert-FixtureUnchanged/);
    expect(script).toMatch(/Fixture SHA-256 changed after/);
    expect(script).toMatch(/Assert-FixtureUnchanged 'open'/);
    expect(script).toMatch(/Assert-FixtureUnchanged 'terminal'/);
    expect(script).toMatch(/fixtureSha256Before=.*fixtureSha256After=\(Get-Sha256 \$pdf\)/);
  });

  it("owns bounded processes and resources, then proves cleanup", async () => {
    const script = await source();
    expect(script).toMatch(/CreateKillOnCloseJob/);
    expect(script).toMatch(/AssignProcessToJobObject/);
    expect(script).toMatch(/CreateProcess/);
    expect(script).toMatch(/StartOwned/);
    expect(script).toMatch(/StartOwnedArguments/);
    expect(script).not.toMatch(/\$helper=Start-Process/);
    expect(script).toMatch(/0x4/);
    expect(script).toMatch(/WaitForSingleObject/);
    expect(script).toMatch(/terminationError/);
    expect(script).toMatch(/UnconfirmedProcessCleanup=true/);
    expect(script).toMatch(/Helper process cleanup was not confirmed/);
    expect(script).toMatch(/\$helper=\$null/);
    expect(script).toMatch(/Owned helper survived cleanup/);
    expect(script).toMatch(/\$cleanup=\$false/);
    expect(script).toMatch(/uint wait=WaitForSingleObject/);
    expect(script).toMatch(/Owned process termination was not confirmed/);
    expect(script).toMatch(/TerminateJobObject/);
    expect(script).toMatch(/LaunchTimeoutMs=20000/);
    expect(script).toMatch(/ActionTimeoutMs=8000/);
    expect(script).toMatch(/ExitTimeoutMs=15000/);
    expect(script).toMatch(/MaxWorkingSetMiB=768/);
    expect(script).toMatch(/MaxCpuMilliseconds=7200000/);
    expect(script).toMatch(/function Assert-Resources/);
    expect(script).toMatch(/cleanupGuaranteed=\$cleanup/);
  });

  it("covers the reader states and rejects writable capabilities through accessible UI", async () => {
    const script = await source();
    for (const event of [
      "native-open-request:fixture-selected",
      "view:fit-width-default",
      "view:zoom-in",
      "view:zoom-out",
      "view:rotate-quarter-turn",
      "page:navigate-next",
      "scroll:viewport-down",
      "navigation:bounded-repeat",
      "read-only:forbidden-capability-check",
      "close:clean",
    ]) expect(script).toContain(event);
    expect(script).toMatch(/\^\(Save\|Save As\|Export\|Download\)/);
    expect(script).toMatch(/TreeScope\]::Subtree/);
    expect(script).toMatch(/for\(\$i=0;\$i -lt 20;\$i\+\+\)/);
    expect(script).toMatch(/function Capture-VisualHash/);
    expect(script).toMatch(/FocusedWindow/);
    expect(script).toMatch(/GetGUIThreadInfo/);
  });

  it("awaits tab activity publication and never swallows revocation failure", async () => {
    const main = await mainSource();
    const coordinator = await tabActivationSource();
    expect(main).toMatch(/async function activateCurrentTab/);
    expect(coordinator).toMatch(/await operations\.deactivate\(prior\)/);
    expect(main).toMatch(/activateCurrent: \(restoreFocus\) => activateCurrentTab\(restoreFocus\)/);
    expect(coordinator).not.toMatch(/deactivate\([^)]*\)\.catch\(\(\) => undefined\)/);
    expect(main).toMatch(/function reportPresentationFailure/);
    expect(main).toMatch(/error\.message === "PDF_RESIDENT_AUTHORITY_INCOMPLETE"/);
    expect(main).toMatch(/viewportSynchronization\.catch\(\(error: unknown\)/);
    expect(main).toMatch(/renderPage\(reader\.page\)\.catch/);
    expect(main).toMatch(/renderCurrentView\(\)\.catch/);
    expect(main).toMatch(/await session\.navigateToDestination\(page, destination, cause, isActivationCurrent\)/);
    expect(main).toMatch(/isActive: \(payload\) => payload\.session\.snapshot\.active/);
    expect(main).toMatch(/Could not activate this tab/);
    expect(main).toMatch(/Could not activate the tab after closing/);
    expect(main).toMatch(/queueWorkspaceTransition[\s\S]*?\.catch/);
  });
  it("emits a single path-free atomic terminal receipt and refuses stale evidence", async () => {
    const script = await source();
    expect(script).toMatch(/EvidenceDirectory already exists; refusing stale evidence overwrite/);
    expect(script).toMatch(/function Write-AtomicTerminal/);
    expect(script).toMatch(/Terminal evidence already exists/);
    expect(script).toMatch(/\.tmp/);
    expect(script).toMatch(/\[IO\.File\]::Move\(\$temporary,\$Path\)/);
    expect(script).toMatch(/w06-packaged-smoke\.json/);
    expect(script).toMatch(/status=\$status;dryRun=\(-not \$Run\);w08Scenario=\$W08;bindings=/);
    expect(script).not.toMatch(/\.png|Copy\(\$pdf|Set-Content/);
  });
});
