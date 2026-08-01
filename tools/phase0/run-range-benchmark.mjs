import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { EVIDENCE_SCHEMA_VERSION, validateRangeEvidenceRow } from "./evidence-schema.mjs";

export const RANGE_CASE_COUNT = 512;
export const RANGE_SEED = 0x52414e47;
export const NORMAL_RANGE_MAX = 1024 * 1024;
export const ABSOLUTE_RANGE_MAX = 4 * 1024 * 1024;

function xorshift32(state) {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

/** Deterministic cases include zero length, EOF, maximum accepted, and overlapping reads. */
export function createRangeCases(byteLength) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new TypeError("byteLength must be a non-negative safe integer");
  const max = Math.min(ABSOLUTE_RANGE_MAX, byteLength);
  const cases = [
    { offset: 0, length: 0 },
    { offset: byteLength, length: 0 },
    { offset: byteLength, length: 1 },
    { offset: Math.max(0, byteLength - 1), length: 1 },
    { offset: 0, length: max },
    { offset: Math.max(0, max - 1), length: Math.min(max, byteLength - Math.max(0, max - 1)) },
    { offset: 0, length: Math.min(NORMAL_RANGE_MAX, byteLength) },
    { offset: 17, length: Math.min(4096, Math.max(0, byteLength - 17)) },
    { offset: 18, length: Math.min(4096, Math.max(0, byteLength - 18)) },
  ];
  let state = RANGE_SEED;
  while (cases.length < RANGE_CASE_COUNT) {
    state = xorshift32(state); const offset = byteLength === 0 ? 0 : state % (byteLength + 1);
    state = xorshift32(state); const length = state % (ABSOLUTE_RANGE_MAX + 1);
    cases.push({ offset, length });
  }
  return cases;
}

function expectedRange(bytes, offset, length) {
  return bytes.subarray(Math.min(offset, bytes.length), Math.min(bytes.length, offset + length));
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("adapter.readRange must resolve to Buffer or Uint8Array");
}

/**
 * Runs only byte correctness. It intentionally records no app latency, process, or memory metrics;
 * those must be supplied by the CP0 native collector before a selection decision is finalized.
 */
export async function runRangeBenchmark({ fixturePath, adapter, evidencePath } = {}) {
  if (typeof fixturePath !== "string" || fixturePath.length === 0) throw new TypeError("fixturePath is required");
  if (!adapter || typeof adapter.readRange !== "function") throw new TypeError("adapter.readRange(offset, length) is required");
  const fixture = await readFile(fixturePath);
  const fixtureSha256 = sha256(fixture);
  const rows = [];
  for (const [index, range] of createRangeCases(fixture.length).entries()) {
    const actual = asBuffer(await adapter.readRange(range.offset, range.length));
    const expected = expectedRange(fixture, range.offset, range.length);
    if (!actual.equals(expected)) throw new Error(`range case ${index} differs: offset=${range.offset} length=${range.length} expected=${expected.length} actual=${actual.length}`);
    const row = { schema: EVIDENCE_SCHEMA_VERSION, kind: "range-correctness", fixtureSha256, case: index, offset: range.offset, length: range.length, returnedBytes: actual.length, outcome: "pass" };
    validateRangeEvidenceRow(row);
    rows.push(row);
  }
  const jsonl = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  if (evidencePath) await writeFile(evidencePath, jsonl, "utf8");
  return { fixtureSha256, rows, jsonl, decisionFinalized: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [fixturePath, adapterPath, evidencePath] = process.argv.slice(2);
  if (!fixturePath || !adapterPath) throw new Error("usage: node tools/phase0/run-range-benchmark.mjs <fixture> <adapter-module> [evidence.jsonl]");
  const imported = await import(pathToFileURL(resolve(adapterPath)).href);
  const adapter = imported.default ?? imported.adapter ?? imported;
  const result = await runRangeBenchmark({ fixturePath, adapter, evidencePath });
  process.stdout.write(`${JSON.stringify({ fixtureSha256: result.fixtureSha256, rows: result.rows.length, decisionFinalized: false })}\n`);
}
