import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPhase0Pdf, generatePhase0Pdf } from "../../../tools/fixtures/generate-phase0-pdf.mjs";
import { EVIDENCE_SCHEMA_VERSION, evaluateThresholds, nearestRankP95, validateSample } from "../../../tools/phase0/evidence-schema.mjs";
import { RANGE_CASE_COUNT, createRangeCases, runRangeBenchmark } from "../../../tools/phase0/run-range-benchmark.mjs";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function sample(population: "warmup" | "cold-process" | "warm-reopen", ordinal: number, overrides = {}) {
  return {
    schema: EVIDENCE_SCHEMA_VERSION, transport: "A", remediation: false, trace: `trace-${population}-${ordinal}`, population, ordinal,
    fixtureSha256: "a".repeat(64), endpoints: { openToFirstVisibleMs: 1000, inputToStateMs: 20 }, rangeBytes: { requested: 1024, returned: 1024 },
    cancel: { uiMs: 50, acceptanceMs: 200 }, barrier: { ms: 500 }, pids: [1234], privateBytes: 1, peakPrivateBytes: 2, steadyPrivateBytes: 1,
    staleCanvasCount: 0, outcome: "pass", ...overrides,
  };
}

describe("Phase 0 fixture and evidence harness", () => {
  it("generates byte-identical, valid-size PDF 1.7 with deterministic annotations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "modeleaf-phase0-"));
    try {
      const first = join(directory, "first.pdf"); const second = join(directory, "second.pdf");
      const firstManifest = await generatePhase0Pdf({ outputPath: first, manifestPath: join(directory, "first.json") });
      const secondManifest = await generatePhase0Pdf({ outputPath: second, manifestPath: join(directory, "second.json") });
      const one = await readFile(first); const two = await readFile(second); const text = one.toString("latin1");
      expect(one.equals(two)).toBe(true); expect(firstManifest.outputSha256).toBe(hash(one)); expect(secondManifest.outputSha256).toBe(firstManifest.outputSha256);
      expect(one.subarray(0, 8).toString("ascii")).toBe("%PDF-1.7"); expect(one.length).toBeGreaterThanOrEqual(19 * 1024 * 1024); expect(one.length).toBeLessThanOrEqual(21 * 1024 * 1024);
      expect(text).toContain("xref\n0 "); expect(text).toContain("/Count 100"); expect((text.match(/\/Type \/Page(?!s)/g) ?? []).length).toBe(100);
      expect((text.match(/\/S \/GoTo/g) ?? []).length).toBe(10); expect((text.match(/https:\/\/example\.invalid\/modeleaf\//g) ?? []).length).toBe(10);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects missing schema data and uses nearest-rank p95 thresholds", () => {
    expect(() => validateSample({})).toThrow(); expect(nearestRankP95([1, 2, 3, 4, 100])).toBe(100); expect(nearestRankP95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])).toBe(19);
    const rows = [...Array.from({ length: 5 }, (_, index) => sample("warmup", index + 1)), ...Array.from({ length: 20 }, (_, index) => sample("cold-process", index + 1)), ...Array.from({ length: 20 }, (_, index) => sample("warm-reopen", index + 1))];
    expect(evaluateThresholds(rows).decision).toBe(true);
    rows[24] = sample("cold-process", 20, { barrier: { ms: 1001 } }); expect(evaluateThresholds(rows).thresholds.barrier).toBe(false);
  });

  it("checks all 512 deterministic ranges against a local byte adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "modeleaf-range-")); const fixture = join(directory, "bytes.bin");
    try {
      const bytes = createPhase0Pdf(); await writeFile(fixture, bytes);
      const result = await runRangeBenchmark({ fixturePath: fixture, adapter: { readRange: async (offset: number, length: number) => bytes.subarray(Math.min(offset, bytes.length), Math.min(bytes.length, offset + length)) } });
      expect(createRangeCases(bytes.length)).toHaveLength(RANGE_CASE_COUNT); expect(result.rows).toHaveLength(RANGE_CASE_COUNT); expect(result.decisionFinalized).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
