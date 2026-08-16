import { describe, expect, it } from "vitest";
import { normalizeOutline } from "../../../src/domain/outlines/OutlineModel";
import { OutlineSelectorInput } from "../../../src/domain/outlines/OutlineSelector";

const destination = (pageIndex: number) => ({ pageIndex, x: 0, y: 0, pageWidth: 100, pageHeight: 100 });
const rows = normalizeOutline(Array.from({ length: 28 }, (_, index) => ({ title: String(index), destination: destination(index) })));

describe("OutlineSelectorInput", () => {
  it("selects one-digit rows immediately when unambiguous", () => {
    const input = new OutlineSelectorInput(rows.slice(0, 2));
    expect(input.append("1", 0)).toMatchObject({ kind: "selected", row: { selector: "1" } });
  });

  it("waits for ambiguous decimal prefixes and respects 399/400 ms", () => {
    const input = new OutlineSelectorInput(rows);
    expect(input.append("1", 0)).toEqual({ kind: "pending", buffer: "1", deadline: 400 });
    expect(input.expire(399)).toEqual({ kind: "pending", buffer: "1", deadline: 400 });
    expect(input.expire(400)).toMatchObject({ kind: "selected", row: { selector: "1" } });
  });

  it("renews deadlines for second digits and backspace", () => {
    const input = new OutlineSelectorInput(rows);
    input.append("1", 0);
    expect(input.append("2", 100)).toMatchObject({ kind: "selected", row: { selector: "12" } });
    input.append("1", 200);
    expect(input.backspace(300)).toEqual({ kind: "cancelled" });
  });

  it("rejects non-digits and lifecycle cancellation clears state", () => {
    const input = new OutlineSelectorInput(rows);
    expect(input.append("a", 0)).toEqual({ kind: "invalid" });
    input.append("1", 0);
    expect(input.cancel()).toEqual({ kind: "cancelled" });
    expect(input.state()).toEqual({ buffer: "" });
  });
});
