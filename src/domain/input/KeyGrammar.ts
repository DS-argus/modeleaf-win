export const KEY_MODIFIERS = Object.freeze(["C", "A", "S"] as const);
export type KeyModifier = (typeof KEY_MODIFIERS)[number];

export type KeyGrammarErrorCode =
  | "KEY_EMPTY" | "KEY_TOKEN_UNCLOSED" | "KEY_TOKEN_UNEXPECTED_CLOSE" | "KEY_TOKEN_MALFORMED"
  | "KEY_MODIFIER_DUPLICATE" | "KEY_MODIFIER_D_MIGRATION" | "KEY_MODIFIER_WIN_UNSUPPORTED" | "KEY_MODIFIER_UNKNOWN"
  | "KEY_UPPERCASE_CHORD_BASE" | "KEY_NAMED_REMOVED" | "KEY_NAMED_UNKNOWN" | "KEY_LITERAL_UNSUPPORTED" | "KEY_INPUT_UNROUTABLE";

export interface CanonicalKeyToken {
  readonly key: string;
  readonly modifiers: readonly KeyModifier[];
  readonly canonical: string;
  readonly kind: "literal" | "chord" | "named" | "prefix";
  readonly printable: boolean;
}
export type KeyGrammarResult =
  | { readonly ok: true; readonly tokens: readonly CanonicalKeyToken[]; readonly canonical: string }
  | { readonly ok: false; readonly code: KeyGrammarErrorCode; readonly offset: number; readonly replacement?: string };

const NAMED = Object.freeze({
  esc: "Esc", enter: "Enter", bs: "BS", del: "Del", tab: "Tab", left: "Left", right: "Right", up: "Up", down: "Down",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", space: "Space", lt: "LT", gt: "GT", minus: "Minus",
} as const);
const PRINTABLE_NAMED = new Set(["Space", "LT", "GT", "Minus"]);
const REMOVED: Readonly<Record<string, string>> = Object.freeze({
  escape: "<Esc>", cr: "<Enter>", return: "<Enter>", backspace: "<BS>", delete: "<Del>",
  backtick: "`", plus: "+", equal: "=", slash: "/",
});
const UNROUTABLE_KEYS = new Set(["dead", "deadkey", "process", "compose", "altgraph", "ime", "unidentified"]);

/** Parses the config grammar. Bare non-whitespace Unicode code points remain literal. */
export function parseKeySequence(source: string): KeyGrammarResult {
  if (source.length === 0) return fail("KEY_EMPTY", 0);
  const tokens: CanonicalKeyToken[] = [];
  let offset = 0;
  while (offset < source.length) {
    if (source[offset] === ">") return fail("KEY_TOKEN_UNEXPECTED_CLOSE", offset);
    if (source[offset] !== "<") {
      const key = String.fromCodePoint(source.codePointAt(offset)!);
      if (!isSupportedLiteral(key)) return fail("KEY_LITERAL_UNSUPPORTED", offset);
      tokens.push(freezeToken(key, [], "literal", key, true));
      offset += key.length;
      continue;
    }
    const close = source.indexOf(">", offset + 1);
    if (close < 0) return fail("KEY_TOKEN_UNCLOSED", offset);
    const parsed = parseBracketToken(source.slice(offset + 1, close), offset);
    if (!parsed.ok) return parsed;
    tokens.push(parsed.token);
    offset = close + 1;
  }
  return Object.freeze({ ok: true, tokens: Object.freeze(tokens), canonical: tokens.map(({ canonical }) => canonical).join("") });
}

export function normalizeKeySequence(source: string): string | undefined {
  const result = parseKeySequence(source);
  return result.ok ? result.canonical : undefined;
}

function parseBracketToken(inner: string, offset: number): { ok: true; token: CanonicalKeyToken } | Extract<KeyGrammarResult, { ok: false }> {
  if (inner.length === 0 || inner.includes("<") || inner.includes(">")) return fail("KEY_TOKEN_MALFORMED", offset);
  if (inner === "prefix") return { ok: true, token: freezeToken("prefix", [], "prefix", "<prefix>", false) };
  const parts = inner.split("-");
  if (parts.some((part) => part.length === 0)) return fail("KEY_TOKEN_MALFORMED", offset);
  const rawKey = parts.pop()!;
  const modifiers: KeyModifier[] = [];
  for (const rawModifier of parts) {
    const modifier = rawModifier.toUpperCase();
    if (modifier === "D") return fail("KEY_MODIFIER_D_MIGRATION", offset);
    if (modifier === "W" || modifier === "WIN" || modifier === "META") return fail("KEY_MODIFIER_WIN_UNSUPPORTED", offset);
    if (!KEY_MODIFIERS.includes(modifier as KeyModifier)) return fail("KEY_MODIFIER_UNKNOWN", offset);
    if (modifiers.includes(modifier as KeyModifier)) return fail("KEY_MODIFIER_DUPLICATE", offset);
    modifiers.push(modifier as KeyModifier);
  }
  modifiers.sort((left, right) => KEY_MODIFIERS.indexOf(left) - KEY_MODIFIERS.indexOf(right));
  if (/^[A-Z]$/u.test(rawKey)) return fail("KEY_UPPERCASE_CHORD_BASE", offset);
  const lower = rawKey.toLowerCase();
  if (UNROUTABLE_KEYS.has(lower)) return fail("KEY_INPUT_UNROUTABLE", offset);
  if (REMOVED[lower] !== undefined) return fail("KEY_NAMED_REMOVED", offset, REMOVED[lower]);
  if (lower === "backtab") {
    if (modifiers.includes("S")) return fail("KEY_MODIFIER_DUPLICATE", offset);
    modifiers.push("S");
    return namedToken("Tab", modifiers);
  }
  const named = NAMED[lower as keyof typeof NAMED] ?? functionKey(lower);
  if (named !== undefined) return namedToken(named, modifiers);
  if ([...rawKey].length !== 1 || !isSupportedLiteral(rawKey)) return fail("KEY_NAMED_UNKNOWN", offset);
  if (modifiers.length === 1 && modifiers[0] === "S" && /^[a-z]$/u.test(rawKey)) {
    const upper = rawKey.toUpperCase();
    return { ok: true, token: freezeToken(upper, [], "literal", upper, true) };
  }
  const key = modifiers.length === 0 ? rawKey : rawKey.toLocaleLowerCase();
  return { ok: true, token: freezeToken(key, modifiers, "chord", `<${[...modifiers, key].join("-")}>`, true) };
}

function namedToken(key: string, modifiers: readonly KeyModifier[]): { ok: true; token: CanonicalKeyToken } {
  return { ok: true, token: freezeToken(key, modifiers, "named", `<${[...modifiers, key].join("-")}>`, PRINTABLE_NAMED.has(key)) };
}
function functionKey(lower: string): string | undefined {
  const match = /^f(\d+)$/u.exec(lower);
  if (match === null) return undefined;
  const number = Number(match[1]);
  return number >= 1 && number <= 12 ? `F${number}` : undefined;
}
function isSupportedLiteral(key: string): boolean {
  return !/[\u0000-\u0020\u007f]/u.test(key) && key !== ">";
}
function freezeToken(key: string, modifiers: readonly KeyModifier[], kind: CanonicalKeyToken["kind"], canonical: string, printable: boolean): CanonicalKeyToken {
  return Object.freeze({ key, modifiers: Object.freeze([...modifiers]), canonical, kind, printable });
}
function fail(code: KeyGrammarErrorCode, offset: number, replacement?: string): Extract<KeyGrammarResult, { ok: false }> {
  return Object.freeze({ ok: false, code, offset, ...(replacement === undefined ? {} : { replacement }) });
}
