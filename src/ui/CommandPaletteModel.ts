import {
  DEFAULT_BINDINGS,
  formatShortcutKeys,
  isCommandEnabled,
  type CommandAvailabilityContext,
} from "../core/defaultBindings.windows";

const MAX_RECENT_ENTRIES = 15;
/** Maximum normalized query size accepted for fuzzy matching, in Unicode code points. */
const MAX_QUERY_CODE_POINTS = 256;
/** Maximum raw UTF-16 query size accepted before Unicode normalization. */
const MAX_RAW_QUERY_CODE_UNITS = MAX_QUERY_CODE_POINTS * 2;

export interface RecentPaletteRecord {
  readonly recentId: string;
  readonly displayName: string;
}

export interface CommandPaletteCommandEntry {
  readonly kind: "command";
  readonly id: string;
  readonly shortcut: string;
  readonly label: string;
  readonly enabled: boolean;
}

export interface CommandPaletteRecentEntry extends RecentPaletteRecord {
  readonly kind: "recent";
}

export type CommandPaletteEntry = CommandPaletteCommandEntry | CommandPaletteRecentEntry;

type ScoredEntry = {
  readonly entry: CommandPaletteEntry;
  readonly matchKind: 0 | 1 | 2;
  readonly score: number;
  readonly recencyRank: number;
  readonly stableId: string;
};

function normalizeForMatch(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function exceedsCodePointCount(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return true;
  }
  return false;
}

function codePointLength(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

function compareStableIds(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex)!;
    const rightCodePoint = right.codePointAt(rightIndex)!;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
    leftIndex += leftCodePoint > 0xFFFF ? 2 : 1;
    rightIndex += rightCodePoint > 0xFFFF ? 2 : 1;
  }

  return leftIndex === left.length ? (rightIndex === right.length ? 0 : -1) : 1;
}

function fuzzyMatch(
  label: string,
  query: string,
  queryCharacters: readonly string[],
): { readonly matchKind: 0 | 1 | 2; readonly score: number } | undefined {
  if (label === query) return { matchKind: 0, score: Number.MAX_SAFE_INTEGER };

  const labelCharacters = Array.from(label);
  if (label.startsWith(query)) {
    return { matchKind: 1, score: Number.MAX_SAFE_INTEGER - labelCharacters.length };
  }
  if (queryCharacters.length > labelCharacters.length) return undefined;

  const bestMatches: Array<number | undefined> = Array(queryCharacters.length);
  let previousIndexMatches: Array<number | undefined> = Array(queryCharacters.length);

  for (let labelIndex = 0; labelIndex < labelCharacters.length; labelIndex += 1) {
    const currentIndexMatches: Array<number | undefined> = Array(queryCharacters.length);
    for (let queryIndex = 0; queryIndex < queryCharacters.length; queryIndex += 1) {
      if (labelCharacters[labelIndex] !== queryCharacters[queryIndex]) continue;
      const baseScore = 10 + labelCharacters.length - labelIndex;
      if (queryIndex === 0) {
        currentIndexMatches[queryIndex] = baseScore;
      } else {
        const priorBest = bestMatches[queryIndex - 1];
        const adjacentPrior = previousIndexMatches[queryIndex - 1];
        if (priorBest === undefined && adjacentPrior === undefined) continue;
        currentIndexMatches[queryIndex] = baseScore + Math.max(
          priorBest ?? Number.NEGATIVE_INFINITY,
          adjacentPrior === undefined ? Number.NEGATIVE_INFINITY : adjacentPrior + 5,
        );
      }
    }
    for (let queryIndex = 0; queryIndex < queryCharacters.length; queryIndex += 1) {
      const candidate = currentIndexMatches[queryIndex];
      const bestMatch = bestMatches[queryIndex];
      if (candidate !== undefined && (bestMatch === undefined || candidate > bestMatch)) {
        bestMatches[queryIndex] = candidate;
      }
    }
    previousIndexMatches = currentIndexMatches;
  }

  const match = bestMatches[queryCharacters.length - 1];
  return match === undefined ? undefined : { matchKind: 2, score: match };
}

function entryLabel(entry: CommandPaletteEntry): string {
  return entry.kind === "command" ? entry.label : entry.displayName;
}

function entryStableId(entry: CommandPaletteEntry): string {
  return entry.kind === "command" ? entry.id : entry.recentId;
}

export function buildCommandPaletteEntries(
  context?: CommandAvailabilityContext,
  recents: readonly RecentPaletteRecord[] = [],
  query = "",
): readonly CommandPaletteEntry[] {
  const commands: readonly CommandPaletteCommandEntry[] = DEFAULT_BINDINGS
    .filter((binding) => binding.showInPalette)
    .map((binding) => ({
      kind: "command",
      id: binding.id,
      shortcut: formatShortcutKeys(binding.keys),
      label: binding.label,
      enabled: isCommandEnabled(binding, context),
    }));
  const recentEntries: readonly CommandPaletteRecentEntry[] = recents
    .slice(0, MAX_RECENT_ENTRIES)
    .map((recent) => ({
      kind: "recent",
      recentId: recent.recentId,
      displayName: recent.displayName,
    }));
  const entries = [...commands, ...recentEntries];
  if (query.length > MAX_RAW_QUERY_CODE_UNITS) return [];
  const normalizedQuery = normalizeForMatch(query);

  if (normalizedQuery === "") return entries;
  if (exceedsCodePointCount(normalizedQuery, MAX_QUERY_CODE_POINTS)) return [];

  const queryCharacters = Array.from(normalizedQuery);
  const normalizedLabels = entries.map((entry) => normalizeForMatch(entryLabel(entry)));
  if (normalizedLabels.every((label) => queryCharacters.length > codePointLength(label))) {
    return [];
  }

  return entries
    .map((entry, index): ScoredEntry | undefined => {
      const label = normalizedLabels[index];
      if (label === undefined) return undefined;
      const match = fuzzyMatch(label, normalizedQuery, queryCharacters);
      return match === undefined
        ? undefined
        : {
          entry,
          ...match,
          recencyRank: entry.kind === "recent" ? MAX_RECENT_ENTRIES - (index - commands.length) : Number.NEGATIVE_INFINITY,
          stableId: entryStableId(entry),
        };
    })
    .filter((entry): entry is ScoredEntry => entry !== undefined)
    .sort((left, right) => (
      left.matchKind - right.matchKind
      || right.score - left.score
      || right.recencyRank - left.recencyRank
      || compareStableIds(left.stableId, right.stableId)
    ))
    .map(({ entry }) => entry);
}

type PaletteKeyboardEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "isComposing">;

function matchesLetter(event: PaletteKeyboardEvent, letter: string): boolean {
  return event.code === `Key${letter.toUpperCase()}` || event.key.toLowerCase() === letter.toLowerCase();
}

export function isPaletteClearShortcut(event: PaletteKeyboardEvent): boolean {
  return !event.isComposing && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && matchesLetter(event, "c");
}
export type CommandPaletteKeyAction = "close" | "submit" | "next" | "previous";

export function commandPaletteKeyAction(
  event: PaletteKeyboardEvent,
): CommandPaletteKeyAction | undefined {
  if (event.isComposing || event.altKey || event.metaKey) return undefined;
  if (event.key === "Escape" && !event.ctrlKey) return "close";
  if (event.key === "Enter" && !event.ctrlKey) return "submit";
  if (event.key === "ArrowDown" || (event.ctrlKey && matchesLetter(event, "j"))) return "next";
  if (event.key === "ArrowUp" || (event.ctrlKey && matchesLetter(event, "k"))) return "previous";
  return undefined;
}

export function moveCommandPaletteIndex(
  currentIndex: number,
  entryCount: number,
  action: "next" | "previous",
): number {
  if (!Number.isSafeInteger(entryCount) || entryCount < 0) throw new RangeError("Palette entry count is invalid");
  if (entryCount === 0) return 0;
  const normalized = ((currentIndex % entryCount) + entryCount) % entryCount;
  return (normalized + (action === "next" ? 1 : entryCount - 1)) % entryCount;
}
