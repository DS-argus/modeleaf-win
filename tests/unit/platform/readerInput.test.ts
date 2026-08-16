import { describe, expect, it } from "vitest";
import { wheelPageDirection } from "../../../src/platform/readerInput";

describe("wheelPageDirection", () => {
  it("turns pages only at the matching vertical scroll boundary", () => {
    expect(wheelPageDirection({
      deltaX: 0, deltaY: 120, scrollTop: 600, scrollHeight: 1000, clientHeight: 400,
      page: 2, pageCount: 5,
    })).toBe(1);
    expect(wheelPageDirection({
      deltaX: 0, deltaY: -120, scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
      page: 2, pageCount: 5,
    })).toBe(-1);
    expect(wheelPageDirection({
      deltaX: 0, deltaY: 120, scrollTop: 300, scrollHeight: 1000, clientHeight: 400,
      page: 2, pageCount: 5,
    })).toBe(0);
  });

  it("does not turn beyond the document or during horizontal and zoom gestures", () => {
    expect(wheelPageDirection({
      deltaX: 0, deltaY: -120, scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
      page: 1, pageCount: 5,
    })).toBe(0);
    expect(wheelPageDirection({
      deltaX: 0, deltaY: 120, scrollTop: 600, scrollHeight: 1000, clientHeight: 400,
      page: 5, pageCount: 5,
    })).toBe(0);
    expect(wheelPageDirection({
      deltaX: 120, deltaY: 30, scrollTop: 600, scrollHeight: 1000, clientHeight: 400,
      page: 2, pageCount: 5,
    })).toBe(0);
    expect(wheelPageDirection({
      deltaX: 0, deltaY: 120, scrollTop: 600, scrollHeight: 1000, clientHeight: 400,
      page: 2, pageCount: 5, ctrlKey: true,
    })).toBe(0);
  });
});
