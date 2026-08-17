import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const source = async (): Promise<string> => readFile(resolve(root, "tools/windows/smoke-w06.ps1"), "utf8");
const mainSource = async (): Promise<string> => readFile(resolve(root, "src/main.ts"), "utf8");

describe("W06 packaged Windows smoke contract", () => {
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
    expect(main).toMatch(/async function activateCurrentTab/);
    expect(main).toMatch(/await prior\.session\.deactivate\(\)/);
    expect(main).toMatch(/await activateCurrentTab\(true\)/);
    expect(main).not.toMatch(/deactivate\(\)\.catch\(\(\) => undefined\)/);
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
    expect(script).toMatch(/status=\$status;dryRun=\(-not \$Run\);bindings=/);
    expect(script).not.toMatch(/\.png|Copy\(\$pdf|Set-Content/);
  });
});
