import { describe, expect, it } from "vitest";
import {
  MEBIBYTE,
  RESOURCE_LIMITS,
  ResourceReservationManager,
  checkedCanvasBytes,
  validateDocumentBytes,
  validateRange,
} from "../../../src/pdf/ResourceBudget";
import { BinaryRangeTransport } from "../../../src/pdf/BinaryRangeTransport";

describe("resource budgets", () => {
  it("keeps the approved checked constants", () => {
    expect(RESOURCE_LIMITS).toMatchObject({
      maxDocumentBytes: 512 * MEBIBYTE,
      maxSessions: 8,
      normalRangeBytes: MEBIBYTE,
      maxRangeBytes: 4 * MEBIBYTE,
      maxRangeWorkProcess: 4,
      maxRangeWorkSession: 2,
      maxRangeQueueProcess: 32,
      maxRangeQueueSession: 8,
      maxRendersProcess: 1,
      maxCanvasBytes: 256 * MEBIBYTE,
      maxCanvasCacheBytes: 128 * MEBIBYTE,
      maxTextProcessBytes: 128 * MEBIBYTE,
      maxTabs: 8,
      maxWindows: 4,
    });
  });

  it("accepts boundaries and rejects overflow", () => {
    expect(validateDocumentBytes(RESOURCE_LIMITS.maxDocumentBytes - 1)).toBeUndefined();
    expect(validateDocumentBytes(RESOURCE_LIMITS.maxDocumentBytes)).toBeUndefined();
    expect(validateDocumentBytes(RESOURCE_LIMITS.maxDocumentBytes + 1)).toBe("DOCUMENT_TOO_LARGE");
    expect(validateRange(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER)).toBe("RANGE_INVALID");
    expect(validateRange(0, RESOURCE_LIMITS.maxRangeBytes + 1, 1)).toBe("RANGE_INVALID");
    expect(validateRange(8, 3, 10)).toBe("RANGE_INVALID");
    expect(validateRange(10, 0, 10)).toBeUndefined();
    expect(checkedCanvasBytes(32_768, 32_768, 1)).toBe("CANVAS_LIMIT");
  });

  it("enforces global and session queue capacity then recovers on release", () => {
    const manager = new ResourceReservationManager();
    const first = manager.reserve({ kind: "range-work", amount: 2, sessionId: "a" });
    expect(first.ok).toBe(true);
    expect(manager.reserve({ kind: "range-work", amount: 1, sessionId: "a" })).toEqual({ ok: false, tag: "RANGE_CAPACITY" });
    const second = manager.reserve({ kind: "range-work", amount: 2, sessionId: "b" });
    expect(second.ok).toBe(true);
    expect(manager.reserve({ kind: "range-work", amount: 1, sessionId: "c" })).toEqual({ ok: false, tag: "RANGE_CAPACITY" });
    if (first.ok) expect(manager.release(first.reservation)).toBe(true);
    expect(manager.reserve({ kind: "range-work", amount: 1, sessionId: "c" }).ok).toBe(true);
  });

  it("evicts inactive heavy resources before denying a new request", () => {
    let manager: ResourceReservationManager;
    let inactive: ReturnType<ResourceReservationManager["reserve"]> | undefined;
    manager = new ResourceReservationManager(() => {
      if (inactive?.ok) manager.release(inactive.reservation);
    });
    inactive = manager.reserve({ kind: "canvas-cache-bytes", amount: RESOURCE_LIMITS.maxCanvasCacheBytes, sessionId: "inactive", inactive: true });
    const active = manager.reserve({ kind: "canvas-cache-bytes", amount: 1, sessionId: "active" });
    expect(active.ok).toBe(true);
    expect(manager.snapshot().totals["canvas-cache-bytes"]).toBe(1);
  });

  it("suppresses stale binary range completions", async () => {
    let current = true;
    const transport = new BinaryRangeTransport(
      { sessionId: "session", documentGeneration: 3, byteLength: 8 },
      { invoke: async () => new Uint8Array(4) },
      () => current,
    );
    current = false;
    await expect(transport.read({ sessionId: "session", documentGeneration: 3, requestId: "request", offset: 4, length: 4 }))
      .resolves.toEqual({ ok: false, tag: "RANGE_STALE" });
  });

  it("caps sessions and detects outstanding reservations", () => {
    const manager = new ResourceReservationManager();
    const held = Array.from({ length: RESOURCE_LIMITS.maxSessions }, (_, index) => manager.reserve({ kind: "session", amount: 1, sessionId: `${index}` }));
    expect(manager.reserve({ kind: "session", amount: 1, sessionId: "overflow" })).toEqual({ ok: false, tag: "SESSION_CAPACITY" });
    expect(() => manager.assertEmpty()).toThrow("not empty");
    for (const result of held) if (result.ok) manager.release(result.reservation);
    manager.assertEmpty();
  });
});
