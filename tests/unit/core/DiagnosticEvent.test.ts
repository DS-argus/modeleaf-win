import { readFileSync } from "node:fs";
const matrix = JSON.parse(readFileSync("tests/fixtures/pdfDiagnosticStages.json", "utf8")) as [string, string, string][];
import { describe, expect, it } from "vitest";
import {
  isDiagnosticEvent,
  isRendererDiagnosticEvent,
  PDF_DIAGNOSTIC_STAGES,
  DIAGNOSTIC_EVENTS,
  DIAGNOSTIC_OUTCOMES,
  DIAGNOSTIC_TAGS,
  type DiagnosticEvent,
} from "../../../src/core/DiagnosticEvent";

const valid: DiagnosticEvent = {
  event: "PDF_SESSION",
  outcome: "SUCCESS",
  tag: "NONE",
  storageClass: "LOCAL",
  epochMs: 1_700_000_000_000,
  appVersion: "0.1.0",
  runtimeVersion: "6.2.108",
  traceId: "0123456789abcdef0123456789abcdef",
  requestId: "11111111111111111111111111111111",
  sessionId: "22222222222222222222222222222222",
  page: 1,
  count: 2,
  durationMs: 50,
  generation: 3,
};

describe("DiagnosticEvent", () => {
  it("accepts the exact bounded diagnostic DTO", () => {
    expect(isDiagnosticEvent(valid)).toBe(true);
  });

  it("distinguishes deferred cleanup from a timeout or successful settlement", () => {
    expect(isDiagnosticEvent({ ...valid, event: "QUIT", outcome: "CANCELLED", tag: "DEFERRED" })).toBe(true);
    expect(isDiagnosticEvent({ ...valid, tag: "DEFERRED", path: "\\\\server\\share\\private.pdf" })).toBe(false);
  });
  it("rejects arbitrary fields and out-of-range metadata", () => {
    expect(isDiagnosticEvent({ ...valid, message: "not allowed" })).toBe(false);
    expect(isDiagnosticEvent({ ...valid, page: 1_000_001 })).toBe(false);
    expect(isDiagnosticEvent({ ...valid, durationMs: -1 })).toBe(false);
  });

  it("rejects hostile text in every string boundary", () => {
    for (const hostile of [
      "C:\\Users\\alice\\secret.pdf",
      "\\\\server\\share\\secret.pdf",
      "https://example.test/document.pdf",
      "비밀번호 검색어",
      "password=hunter2",
      "PDF text\nwith control",
    ]) {
      expect(isDiagnosticEvent({ ...valid, appVersion: hostile })).toBe(false);
      expect(isDiagnosticEvent({ ...valid, traceId: hostile })).toBe(false);
    }
  });
});

describe("native PDF failure observations", () => {
  it("uses the same finite stages as the native regression vectors", () => {
    expect([...PDF_DIAGNOSTIC_STAGES].sort()).toEqual(matrix.map(([stage]) => stage).sort());
  });

  it.each(matrix)("validates %s combinations and renderer provenance", (stage, outcome, tag) => {
    const observation = { ...valid, stage, outcome, tag };
    expect(isDiagnosticEvent(observation)).toBe(true);
    expect(isDiagnosticEvent(JSON.parse(JSON.stringify(observation)))).toBe(true);
    expect(isRendererDiagnosticEvent(observation)).toBe(false);
    for (const osCode of [-2_147_483_648, -1, 0, 5, 2_147_483_647]) {
      expect(isDiagnosticEvent({ ...observation, osCode })).toBe(tag === "IO_FAILURE");
    }
    for (const osCode of [-2_147_483_649, 2_147_483_648, 1.5, NaN, Infinity, "5", null]) {
      expect(isDiagnosticEvent({ ...observation, osCode })).toBe(false);
    }
    for (const event of DIAGNOSTIC_EVENTS) {
      expect(isDiagnosticEvent({ ...observation, event })).toBe(event === "PDF_SESSION");
    }
    for (const otherOutcome of DIAGNOSTIC_OUTCOMES) {
      for (const otherTag of DIAGNOSTIC_TAGS) {
        expect(isDiagnosticEvent({ ...observation, outcome: otherOutcome, tag: otherTag }))
          .toBe(otherOutcome === outcome && otherTag === tag);
      }
    }
    expect(isDiagnosticEvent({ ...observation, message: "private" })).toBe(false);
  });

  it("rejects orphan codes, unknown/null stages and forged native fields", () => {
    expect(isRendererDiagnosticEvent(valid)).toBe(true);
    expect(isDiagnosticEvent({ ...valid, osCode: 5 })).toBe(false);
    for (const stage of ["POLICY", "unknown", null, 0]) {
      expect(isDiagnosticEvent({ ...valid, outcome: "FAILURE", tag: "IO_FAILURE", stage })).toBe(false);
    }
    expect(isRendererDiagnosticEvent({ ...valid, osCode: 5 })).toBe(false);
  });
});
