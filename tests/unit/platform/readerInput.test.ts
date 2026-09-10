import { describe, expect, it } from "vitest";
import { wheelPageDirection } from "../../../src/platform/readerInput";

const base = { zoomMode: "fit-page" as const, deltaX: 0, deltaY: 120, page: 2, pageCount: 5 };
describe("wheelPageDirection", () => {
  it("leaves continuous scrolling to the host even when the page label lags at document edges", () => {
    for (const zoomMode of ["fit-width", "custom"] as const) {
      for (const page of [1, 2, 5]) {
        expect(wheelPageDirection({ ...base, zoomMode, page })).toBe(0);
        expect(wheelPageDirection({ ...base, zoomMode, page, deltaY: -120 })).toBe(0);
      }
    }
  });
  it("turns one fitted page in either direction without scroll-boundary heuristics", () => {
    expect(wheelPageDirection(base)).toBe(1);
    expect(wheelPageDirection({ ...base, deltaY: -120 })).toBe(-1);
  });
  it("clamps fitted page turns at both document ends", () => {
    expect(wheelPageDirection({ ...base, page: 5 })).toBe(0);
    expect(wheelPageDirection({ ...base, page: 1, deltaY: -120 })).toBe(0);
    expect(wheelPageDirection({ ...base, page: 1, pageCount: 1 })).toBe(0);
  });
  it("does not claim horizontal, zoom, zero, or nonfinite gestures", () => {
    expect(wheelPageDirection({ ...base, ctrlKey: true })).toBe(0);
    expect(wheelPageDirection({ ...base, deltaX: 140 })).toBe(0);
    for (const deltaY of [0, NaN, Infinity, -Infinity]) expect(wheelPageDirection({ ...base, deltaY })).toBe(0);
  });
});
