export const EVIDENCE_SCHEMA_VERSION = "modeleaf.phase0.evidence.v1";
export const REQUIRED_WARMUPS = 5;
export const REQUIRED_COLD_PROCESS = 20;
export const REQUIRED_WARM_REOPEN = 20;

const populations = new Set(["warmup", "cold-process", "warm-reopen"]);
const transports = new Set(["A", "B"]);
const outcomes = new Set(["pass", "fail", "cancelled"]);

function fail(message) { throw new TypeError(message); }
function record(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
}
function exactKeys(value, keys, name) {
  record(value, name);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${name} has missing or extra fields`);
}
function string(value, name, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) fail(`${name} must be a valid string`);
}
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${name} must be an integer >= ${minimum}`);
}
function number(value, name, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) fail(`${name} must be a finite number >= ${minimum}`);
}
function bool(value, name) { if (typeof value !== "boolean") fail(`${name} must be boolean`); }

export function nearestRankP95(values) {
  if (!Array.isArray(values) || values.length === 0) fail("p95 requires at least one value");
  const sorted = values.map((value, index) => {
    number(value, `p95[${index}]`);
    return value;
  }).sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

export function validateEnvironment(value) {
  exactKeys(value, ["schema", "cpu", "cores", "ramBytes", "windows", "webview2", "node", "rust", "tauri", "pdfjs", "scaling", "power", "commit"], "environment");
  string(value.schema, "environment.schema");
  if (value.schema !== EVIDENCE_SCHEMA_VERSION) fail("environment.schema is unsupported");
  string(value.cpu, "environment.cpu"); integer(value.cores, "environment.cores", 1); integer(value.ramBytes, "environment.ramBytes", 1);
  for (const key of ["windows", "webview2", "node", "rust", "tauri", "pdfjs", "scaling", "power", "commit"]) string(value[key], `environment.${key}`);
  if (value.pdfjs !== "6.2.108") fail("environment.pdfjs must be 6.2.108");
  return value;
}

export function validateSample(value) {
  exactKeys(value, ["schema", "transport", "remediation", "trace", "population", "ordinal", "fixtureSha256", "endpoints", "rangeBytes", "cancel", "barrier", "pids", "privateBytes", "peakPrivateBytes", "steadyPrivateBytes", "staleCanvasCount", "outcome"], "sample");
  string(value.schema, "sample.schema"); if (value.schema !== EVIDENCE_SCHEMA_VERSION) fail("sample.schema is unsupported");
  string(value.transport, "sample.transport"); if (!transports.has(value.transport)) fail("sample.transport is invalid");
  bool(value.remediation, "sample.remediation"); string(value.trace, "sample.trace", /^[A-Za-z0-9_-]+$/);
  string(value.population, "sample.population"); if (!populations.has(value.population)) fail("sample.population is invalid"); integer(value.ordinal, "sample.ordinal", 1);
  string(value.fixtureSha256, "sample.fixtureSha256", /^[a-f0-9]{64}$/);
  exactKeys(value.endpoints, ["openToFirstVisibleMs", "inputToStateMs"], "sample.endpoints");
  number(value.endpoints.openToFirstVisibleMs, "sample.endpoints.openToFirstVisibleMs"); number(value.endpoints.inputToStateMs, "sample.endpoints.inputToStateMs");
  exactKeys(value.rangeBytes, ["requested", "returned"], "sample.rangeBytes"); integer(value.rangeBytes.requested, "sample.rangeBytes.requested"); integer(value.rangeBytes.returned, "sample.rangeBytes.returned");
  exactKeys(value.cancel, ["uiMs", "acceptanceMs"], "sample.cancel"); number(value.cancel.uiMs, "sample.cancel.uiMs"); number(value.cancel.acceptanceMs, "sample.cancel.acceptanceMs");
  exactKeys(value.barrier, ["ms"], "sample.barrier"); number(value.barrier.ms, "sample.barrier.ms");
  if (!Array.isArray(value.pids) || value.pids.length === 0) fail("sample.pids must be a non-empty array"); value.pids.forEach((pid, index) => integer(pid, `sample.pids[${index}]`, 1));
  integer(value.privateBytes, "sample.privateBytes"); integer(value.peakPrivateBytes, "sample.peakPrivateBytes"); integer(value.steadyPrivateBytes, "sample.steadyPrivateBytes"); integer(value.staleCanvasCount, "sample.staleCanvasCount");
  string(value.outcome, "sample.outcome"); if (!outcomes.has(value.outcome)) fail("sample.outcome is invalid");
  return value;
}

export function validateRangeEvidenceRow(value) {
  exactKeys(value, ["schema", "kind", "fixtureSha256", "case", "offset", "length", "returnedBytes", "outcome"], "range evidence row");
  string(value.schema, "range evidence row.schema"); if (value.schema !== EVIDENCE_SCHEMA_VERSION) fail("range evidence row.schema is unsupported");
  if (value.kind !== "range-correctness") fail("range evidence row.kind is invalid"); string(value.fixtureSha256, "range evidence row.fixtureSha256", /^[a-f0-9]{64}$/);
  integer(value.case, "range evidence row.case"); integer(value.offset, "range evidence row.offset"); integer(value.length, "range evidence row.length"); integer(value.returnedBytes, "range evidence row.returnedBytes");
  if (value.outcome !== "pass") fail("range evidence row.outcome is invalid"); return value;
}

export function validateSummary(value) {
  exactKeys(value, ["schema", "transport", "remediation", "fixtureSha256", "counts", "p95", "max", "thresholds", "decision"], "summary");
  string(value.schema, "summary.schema"); if (value.schema !== EVIDENCE_SCHEMA_VERSION) fail("summary.schema is unsupported"); string(value.transport, "summary.transport"); if (!transports.has(value.transport)) fail("summary.transport is invalid"); bool(value.remediation, "summary.remediation"); string(value.fixtureSha256, "summary.fixtureSha256", /^[a-f0-9]{64}$/);
  exactKeys(value.counts, ["warmup", "coldProcess", "warmReopen"], "summary.counts");
  for (const [key, expected] of [["warmup", REQUIRED_WARMUPS], ["coldProcess", REQUIRED_COLD_PROCESS], ["warmReopen", REQUIRED_WARM_REOPEN]]) if (value.counts[key] !== expected) fail(`summary.counts.${key} must be ${expected}`);
  exactKeys(value.p95, ["coldFirstVisibleMs", "warmFirstVisibleMs", "inputToStateMs", "cancelUiMs", "acceptanceMs"], "summary.p95");
  for (const key of Object.keys(value.p95)) number(value.p95[key], `summary.p95.${key}`);
  exactKeys(value.max, ["barrierMs"], "summary.max"); number(value.max.barrierMs, "summary.max.barrierMs");
  exactKeys(value.thresholds, ["coldFirstVisible", "warmFirstVisible", "inputToState", "cancelUi", "acceptance", "barrier"], "summary.thresholds");
  for (const key of Object.keys(value.thresholds)) bool(value.thresholds[key], `summary.thresholds.${key}`);
  bool(value.decision, "summary.decision");
  const expected = {
    coldFirstVisible: value.p95.coldFirstVisibleMs < 2000,
    warmFirstVisible: value.p95.warmFirstVisibleMs < 2000,
    inputToState: value.p95.inputToStateMs < 50,
    cancelUi: value.p95.cancelUiMs <= 100,
    acceptance: value.p95.acceptanceMs <= 250,
    barrier: value.max.barrierMs <= 1000,
  };
  for (const [key, passed] of Object.entries(expected)) if (value.thresholds[key] !== passed) fail(`summary.thresholds.${key} is inconsistent`);
  if (value.decision !== Object.values(value.thresholds).every(Boolean)) fail("summary.decision is inconsistent");
  return value;
}

export function evaluateThresholds(samples) {
  if (!Array.isArray(samples)) fail("samples must be an array");
  samples.forEach(validateSample);
  const cold = samples.filter((sample) => sample.population === "cold-process");
  const warm = samples.filter((sample) => sample.population === "warm-reopen");
  const warmups = samples.filter((sample) => sample.population === "warmup");
  if (warmups.length !== REQUIRED_WARMUPS || cold.length !== REQUIRED_COLD_PROCESS || warm.length !== REQUIRED_WARM_REOPEN) fail("required benchmark populations are incomplete");
  const measured = [...cold, ...warm];
  const p95 = {
    coldFirstVisibleMs: nearestRankP95(cold.map((s) => s.endpoints.openToFirstVisibleMs)),
    warmFirstVisibleMs: nearestRankP95(warm.map((s) => s.endpoints.openToFirstVisibleMs)),
    inputToStateMs: nearestRankP95(measured.map((s) => s.endpoints.inputToStateMs)),
    cancelUiMs: nearestRankP95(measured.map((s) => s.cancel.uiMs)),
    acceptanceMs: nearestRankP95(measured.map((s) => s.cancel.acceptanceMs)),
  };
  const max = { barrierMs: Math.max(...measured.map((s) => s.barrier.ms)) };
  const thresholds = { coldFirstVisible: p95.coldFirstVisibleMs < 2000, warmFirstVisible: p95.warmFirstVisibleMs < 2000, inputToState: p95.inputToStateMs < 50, cancelUi: p95.cancelUiMs <= 100, acceptance: p95.acceptanceMs <= 250, barrier: max.barrierMs <= 1000 };
  return { p95, max, thresholds, decision: Object.values(thresholds).every(Boolean) && measured.every((s) => s.outcome === "pass" && s.staleCanvasCount === 0) };
}

export function validateBenchmarkEvidence(samples, summary) {
  if (!Array.isArray(samples)) fail("samples must be an array");
  samples.forEach(validateSample);
  const groups = {
    warmup: samples.filter((sample) => sample.population === "warmup"),
    "cold-process": samples.filter((sample) => sample.population === "cold-process"),
    "warm-reopen": samples.filter((sample) => sample.population === "warm-reopen"),
  };
  const expectedCounts = { warmup: REQUIRED_WARMUPS, "cold-process": REQUIRED_COLD_PROCESS, "warm-reopen": REQUIRED_WARM_REOPEN };
  for (const [population, count] of Object.entries(expectedCounts)) {
    const group = groups[population];
    if (group.length !== count || new Set(group.map((sample) => sample.ordinal)).size !== count || group.some((sample) => sample.ordinal > count)) fail(`${population} population is incomplete`);
  }
  const fixtureSha256 = samples[0]?.fixtureSha256;
  if (!fixtureSha256 || samples.some((sample) => sample.fixtureSha256 !== fixtureSha256)) fail("samples must share one fixture hash");
  validateSummary(summary);
  if (summary.fixtureSha256 !== fixtureSha256) fail("summary fixture hash does not match samples");
  const evaluated = evaluateThresholds(samples);
  for (const key of Object.keys(evaluated.p95)) if (summary.p95[key] !== evaluated.p95[key]) fail(`summary.p95.${key} is inconsistent`);
  if (summary.max.barrierMs !== evaluated.max.barrierMs || summary.decision !== evaluated.decision) fail("summary does not match raw samples");
  return { samples, summary };
}

export function validateEvidenceJsonl(text) {
  if (typeof text !== "string" || !text.endsWith("\n")) fail("JSONL must end with LF");
  const lines = text.split("\n").slice(0, -1); if (lines.length === 0 || lines.some((line) => line.length === 0)) fail("JSONL contains an empty row");
  return lines.map((line, index) => { try { return validateSample(JSON.parse(line)); } catch (error) { fail(`JSONL row ${index + 1}: ${error.message}`); } });
}
