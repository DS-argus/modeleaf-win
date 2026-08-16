import { describe, expect, it } from "vitest";
import { normalizeKeySequence, parseKeySequence } from "../../../src/domain/input/KeyGrammar";

const error = (source: string) => {
  const result = parseKeySequence(source);
  if (result.ok) throw new Error(`Expected ${source} to fail`);
  return result;
};

describe("KeyGrammar", () => {
  it("preserves supported bare Unicode and rejects whitespace/stray closing brackets", () => {
    expect(normalizeKeySequence("gg")).toBe("gg");
    expect(normalizeKeySequence("한?")).toBe("한?");
    expect(error(" ").code).toBe("KEY_LITERAL_UNSUPPORTED");
    expect(error("g>").code).toBe("KEY_TOKEN_UNEXPECTED_CLOSE");
  });

  it("normalizes modifiers to C-A-S and shift-only lowercase Latin to bare uppercase", () => {
    expect(normalizeKeySequence("<A-C-s>")).toBe("<C-A-s>");
    expect(normalizeKeySequence("<S-o>")).toBe("O");
    expect(normalizeKeySequence("<C-S-o>")).toBe("<C-S-o>");
    expect(error("<C-P>").code).toBe("KEY_UPPERCASE_CHORD_BASE");
  });

  it("round-trips the exact named vocabulary and Backtab alias", () => {
    const named = ["Esc", "Enter", "BS", "Del", "Tab", "Left", "Right", "Up", "Down", "Home", "End", "PageUp", "PageDown", "Space", "LT", "GT", "Minus", ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)];
    for (const key of named) expect(normalizeKeySequence(`<${key.toLowerCase()}>`)).toBe(`<${key}>`);
    expect(normalizeKeySequence("<Backtab>")).toBe("<S-Tab>");
  });

  it.each(["Escape", "CR", "Return", "Backspace", "Delete", "Backtick", "Plus", "Equal", "Slash"])(
    "rejects removed named spelling %s",
    (key) => expect(error(`<${key}>`).code).toBe("KEY_NAMED_REMOVED"),
  );

  it("keeps physical Ctrl+I distinct from Tab and supports prefix templates", () => {
    expect(normalizeKeySequence("<C-i>")).toBe("<C-i>");
    expect(normalizeKeySequence("<Tab>")).toBe("<Tab>");
    expect(normalizeKeySequence("<C-i>")).not.toBe(normalizeKeySequence("<Tab>"));
    expect(normalizeKeySequence("<prefix>r")).toBe("<prefix>r");
  });

  it("returns dedicated Windows migration and routing errors", () => {
    expect(error("<D-o>").code).toBe("KEY_MODIFIER_D_MIGRATION");
    expect(error("<Win-o>").code).toBe("KEY_MODIFIER_WIN_UNSUPPORTED");
    expect(error("<Meta-o>").code).toBe("KEY_MODIFIER_WIN_UNSUPPORTED");
    expect(error("<Dead>").code).toBe("KEY_INPUT_UNROUTABLE");
    expect(error("<AltGraph>").code).toBe("KEY_INPUT_UNROUTABLE");
  });

  it.each([
    ["", "KEY_EMPTY"], ["<C-o", "KEY_TOKEN_UNCLOSED"], ["<>", "KEY_TOKEN_MALFORMED"],
    ["<C--o>", "KEY_TOKEN_MALFORMED"], ["<C-C-o>", "KEY_MODIFIER_DUPLICATE"],
    ["<Q-o>", "KEY_MODIFIER_UNKNOWN"], ["<NotAKey>", "KEY_NAMED_UNKNOWN"], ["<F13>", "KEY_NAMED_UNKNOWN"],
  ])("rejects %s with %s", (source, code) => expect(error(source).code).toBe(code));

  it("returns deeply frozen successful tokens", () => {
    const result = parseKeySequence("<C-S-p>");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tokens)).toBe(true);
    expect(Object.isFrozen(result.tokens[0])).toBe(true);
    expect(Object.isFrozen(result.tokens[0]!.modifiers)).toBe(true);
  });
});
