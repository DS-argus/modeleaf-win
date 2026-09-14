import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

const source = readFileSync("tools/windows/verify-browse-lifecycle.mjs", "utf8");
const start = source.indexOf("  await waitFor('normal QA process exit'");
const end = source.indexOf("} catch(error)", start);
if (start < 0 || end <= start) throw new Error("Native replay terminal gate is missing");
const terminal = source.slice(start, end);
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<string>;
const runTerminal = new AsyncFunction("waitFor", "appExited", "appExit", "assert",
  `let status = 'failed'; try { ${terminal} } catch { return status; } return status;`);
const observedExit = async (_label: string, exited: () => boolean) => { assert.equal(exited(), true); };

describe("native Browse replay terminal result", () => {
  it("passes only a recorded normal zero exit", async () => {
    await expect(runTerminal(observedExit, true, { code: 0, signal: null }, assert)).resolves.toBe("passed");
  });
  it.each([
    ["nonzero exit", { code: 1, signal: null }],
    ["signal termination", { code: null, signal: "SIGTERM" }],
    ["missing exit receipt", undefined],
  ])("does not promote %s to a passed artifact", async (_label, exit) => {
    await expect(runTerminal(observedExit, true, exit, assert)).resolves.toBe("failed");
  });
});
