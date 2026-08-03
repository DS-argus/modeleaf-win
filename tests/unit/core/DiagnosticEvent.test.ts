import { describe, expect, it } from "vitest";
import {
  isDiagnosticEvent,
  type DiagnosticEvent,
} from "../../../src/core/DiagnosticEvent";

const valid: DiagnosticEvent = {
  event: "PDF_SESSION",
  outcome: "SUCCESS",
  tag: "NONE",
  storageClass: "LOCAL",
  epochMs: 1_700_000_000_000,
  appVersion: "0.1.0",
  runtimeVersion: "5.7.284",
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
