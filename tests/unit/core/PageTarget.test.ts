import { describe, expect, it } from "vitest";
import {
  appendPageTargetDigit,
  validatePageTarget,
} from "../../../src/core/PageTarget";

describe("PageTarget", () => {
  it("parses leading zeroes but rejects zero", () => {
    expect(validatePageTarget("0012", 20)).toEqual({ ok: true, page: 12 });
    expect(validatePageTarget("000", 20)).toEqual({
      ok: false,
      error: "PAGE_TARGET_OUT_OF_RANGE",
    });
  });

  it("validates empty and out-of-range targets", () => {
    expect(validatePageTarget("", 10)).toEqual({ ok: false, error: "PAGE_TARGET_EMPTY" });
    expect(validatePageTarget("11", 10)).toEqual({
      ok: false,
      error: "PAGE_TARGET_OUT_OF_RANGE",
    });
  });

  it("accepts nine digits and rejects a tenth", () => {
    expect(appendPageTargetDigit("12345678", "9")).toBe("123456789");
    expect(appendPageTargetDigit("123456789", "0")).toBe("PAGE_TARGET_TOO_LONG");
  });
});
