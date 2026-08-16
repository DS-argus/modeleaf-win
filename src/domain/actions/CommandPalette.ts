export const MAX_PALETTE_ROWS = 12;

export interface PaletteEntry {
  readonly id: string;
  readonly title: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly kind: "action" | "recent";
  readonly recency?: number;
}

export interface PaletteMatch extends PaletteEntry {
  readonly matchKind: "exact" | "prefix" | "substring" | "fuzzy" | "empty";
  readonly score: number;

}

/** Pure enabled-first stable fuzzy projection. Entries must already omit filesystem paths. */
export function filterCommandPalette(entries: readonly PaletteEntry[], query: string): readonly PaletteMatch[] {
  const normalized = query.normalize("NFC").trim().toLocaleLowerCase();
  const matches: { readonly value: PaletteMatch; readonly inputIndex: number }[] = [];
  entries.forEach((entry, inputIndex) => {
    const matched = match(entry.title.normalize("NFC").toLocaleLowerCase(), normalized);
    if (matched !== undefined) matches.push({ value: Object.freeze({ ...entry, ...matched }), inputIndex });
  });
  matches.sort((left, right) =>
    Number(right.value.enabled) - Number(left.value.enabled)
    || kindRank(left.value.matchKind) - kindRank(right.value.matchKind)
    || left.value.score - right.value.score
    || left.inputIndex - right.inputIndex);
  return Object.freeze(matches.slice(0, MAX_PALETTE_ROWS).map(({ value }) => value));
}

function match(candidate: string, query: string): Pick<PaletteMatch, "matchKind" | "score"> | undefined {
  if (query.length === 0) return { matchKind: "empty", score: 0 };
  if (candidate === query) return { matchKind: "exact", score: 0 };
  if (candidate.startsWith(query)) return { matchKind: "prefix", score: candidate.length - query.length };
  const substring = candidate.indexOf(query);
  if (substring >= 0) return { matchKind: "substring", score: substring };
  let cursor = 0;
  let gaps = 0;
  for (const character of query) {
    const found = candidate.indexOf(character, cursor);
    if (found < 0) return undefined;
    gaps += found - cursor;
    cursor = found + character.length;
  }
  return { matchKind: "fuzzy", score: candidate.length + gaps };
}

function kindRank(kind: PaletteMatch["matchKind"]): number {
  return ({ exact: 0, prefix: 1, substring: 2, fuzzy: 3, empty: 4 } as const)[kind];
}
