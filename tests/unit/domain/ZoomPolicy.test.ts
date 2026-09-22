import { describe, expect, it } from "vitest";
import { appendZoomIntent, resolveZoomIntent, type PendingZoomIntent } from "../../../src/domain/navigation/ZoomPolicy";

const compose = (factors: readonly number[]): PendingZoomIntent => {
  let intent: PendingZoomIntent | undefined;
  for (const factor of factors) intent = appendZoomIntent(intent, factor);
  if (intent === undefined) throw new Error("Test needs a zoom step");
  return intent;
};

describe("bounded ordered zoom intent", () => {
  it("retains reversal after hitting either scale limit", () => {
    expect(resolveZoomIntent(4, compose([1.1, 1.1, 1 / 1.1]))).toBeCloseTo(4 / 1.1, 12);
    expect(resolveZoomIntent(0.25, compose([1 / 1.1, 1 / 1.1, 1.1]))).toBeCloseTo(0.275, 12);
    expect(resolveZoomIntent(1.35, compose([1 / 1.1, 1 / 1.1]))).toBeCloseTo(1.35 / 1.1 ** 2, 12);
  });

  it("matches individual ordered clamps across bases and mixed directions", () => {
    let seed = 140;
    const factors = Array.from({ length: 500 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return [1.1, 1 / 1.1, 3, 0.1][(seed >>> 16) % 4]!;
    });
    for (const base of [0.25, 0.26, 0.67, 1, 1.35, 2.9, 3.99, 4]) {
      let expected = base;
      let intent: PendingZoomIntent | undefined;
      for (const factor of factors) {
        expected = Math.max(0.25, Math.min(4, expected * factor));
        intent = appendZoomIntent(intent, factor);
        expect(resolveZoomIntent(base, intent)).toBeCloseTo(expected, 10);
      }
    }
  });

  it("keeps numerical state bounded through saturation and extreme finite factors", () => {
    let intent: PendingZoomIntent | undefined;
    for (let index = 0; index < 100_000; index += 1) intent = appendZoomIntent(intent, 1.1);
    expect(resolveZoomIntent(0.25, intent!)).toBe(4);
    expect(Object.keys(intent!)).toEqual(["factor", "lower", "upper"]);
    expect(intent!.factor).toBeLessThanOrEqual(16);
    for (const factor of [Number.MAX_VALUE, Number.MIN_VALUE, Number.MAX_VALUE, 1 / 1.1]) {
      intent = appendZoomIntent(intent, factor);
      expect(Object.values(intent).every(Number.isFinite)).toBe(true);
    }
    expect(resolveZoomIntent(1, intent!)).toBeCloseTo(4 / 1.1, 12);
  });

  it.each([0, -1, NaN, Infinity, -Infinity])("rejects invalid factors and bases: %s", value => {
    expect(() => appendZoomIntent(undefined, value)).toThrow(RangeError);
    expect(() => resolveZoomIntent(value, compose([1.1]))).toThrow(RangeError);
  });
});
