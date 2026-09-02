import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const source = async (path: string): Promise<string> => readFile(resolve(root, path), "utf8");

describe("link hint reliability contract", () => {
  it("does not recursively resynchronize an unchanged viewport from reader status publication", async () => {
    const main = await source("src/main.ts");

    expect(main).toMatch(/reader\.documentGeneration !== viewportSyncDocumentGeneration/);
    expect(main).toMatch(/viewportSyncDocumentGeneration = reader\.documentGeneration;\s*queueMicrotask\(scheduleViewportSync\);/);
    expect(main).not.toMatch(/if \(reader\.hasDocument\) queueMicrotask\(scheduleViewportSync\);/);
  });

  it("preserves the current link activation while superseding older destination work", async () => {
    const session = await source("src/pdf/PdfTabSession.ts");
    const main = await source("src/main.ts");
    const content = await source("src/pdf/PdfContentController.ts");

    expect(session).toMatch(/navigateToDestination[\s\S]*?supersedeNavigation\(false, true\)/);
    expect(session).toMatch(/cancelDestination\(undefined, preserveLinkActivation\)/);
    expect(main).toMatch(/if \(session\.navigationLandingInProgress\) return;/);
    expect(session).toMatch(/try \{[\s\S]*?renderPage\(page[\s\S]*?applyQueuedDestinationToResidentPage\(page\);[\s\S]*?\} finally \{/);
    expect(content).toMatch(/cancelDestination\(intentId\?: number, preserveLinkActivation = false\)/);
    expect(content).toMatch(/if \(!preserveLinkActivation\) this\.linkActivationSequence \+= 1/);
  });
});
