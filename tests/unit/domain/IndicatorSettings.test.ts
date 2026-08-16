import { describe, expect, it } from "vitest";
import {
  DEFAULT_INDICATOR_SETTINGS,
  INDICATOR_COLORS,
  INDICATOR_STYLES,
  normalizeIndicatorColor,
  validateIndicatorSettings,
} from "../../../src/domain/links/IndicatorSettings";

describe("IndicatorSettings", () => {
  it("freezes the exact defaults and enumerations", () => {
    expect(INDICATOR_STYLES).toEqual(["pulse-ring", "target", "beacon", "static-ring", "diamond-pulse"]);
    expect(INDICATOR_COLORS).toEqual(["red", "amber", "cyan", "green", "purple", "accent", "auto-contrast", "high-contrast"]);
    expect(DEFAULT_INDICATOR_SETTINGS).toEqual({ style: "pulse-ring", color: "red", size: 28, durationMilliseconds: 1500 });
    expect(Object.isFrozen(DEFAULT_INDICATOR_SETTINGS)).toBe(true);
  });

  it("normalizes custom colors and accepts numeric boundaries", () => {
    expect(normalizeIndicatorColor("#A0Bc12")).toBe("#a0bc12");
    for (const [size, durationMilliseconds] of [[16, 500], [48, 3000]]) {
      expect(validateIndicatorSettings({ style: "target", color: "#ABCDEF", size, durationMilliseconds })).toEqual({
        ok: true,
        value: { style: "target", color: "#abcdef", size, durationMilliseconds },
      });
    }
  });

  it("accepts finite fractional sizes inside the inclusive Double range", () => {
    expect(validateIndicatorSettings({ style: "beacon", color: "cyan", size: 28.5, durationMilliseconds: 1500 })).toMatchObject({ ok: true, value: { size: 28.5 } });
  });
  it.each([
    [null, "INDICATOR_NOT_OBJECT"],
    [{ style: "bad", color: "red", size: 28, durationMilliseconds: 1500 }, "INDICATOR_STYLE_INVALID"],
    [{ style: "target", color: "#12345g", size: 28, durationMilliseconds: 1500 }, "INDICATOR_COLOR_INVALID"],
    [{ style: "target", color: "red", size: 15, durationMilliseconds: 1500 }, "INDICATOR_SIZE_INVALID"],
    [{ style: "target", color: "red", size: 49, durationMilliseconds: 1500 }, "INDICATOR_SIZE_INVALID"],
    [{ style: "target", color: "red", size: 28, durationMilliseconds: 499 }, "INDICATOR_DURATION_INVALID"],
    [{ style: "target", color: "red", size: 28, durationMilliseconds: 3001 }, "INDICATOR_DURATION_INVALID"],
  ])("rejects invalid settings with an exact code", (value, error) => {
    expect(validateIndicatorSettings(value)).toEqual({ ok: false, error });
  });
});
