export const MAX_RECENT_FILES = 15;
export interface RecentFile { readonly recentId: string; readonly displayName: string }
export interface RecentFileMatch { readonly recentId: string; readonly displayName: string; readonly score: number; readonly matchedIndices: readonly number[] }
export interface RecentSnapshot { readonly revision: string; readonly entries: readonly RecentFile[] }

export function adoptRecentSnapshot(current: RecentSnapshot | undefined, candidate: RecentSnapshot): RecentSnapshot {
  const currentRevision = current === undefined ? -1n : BigInt(current.revision);
  const candidateRevision = BigInt(candidate.revision);
  if (candidateRevision < currentRevision) return current!;
  return Object.freeze({
    revision: candidate.revision,
    entries: Object.freeze(candidate.entries.slice(0, MAX_RECENT_FILES).map((entry) => Object.freeze({
      recentId: entry.recentId,
      displayName: entry.displayName.normalize("NFC"),
    }))),
  });
}

export function filterRecentFiles(entries: readonly RecentFile[], query: string): readonly RecentFileMatch[] {
  const normalized = Array.from(query.normalize("NFC").trim().toLocaleLowerCase());
  const projected = entries.map((entry, inputIndex) => {
    const displayName = entry.displayName.normalize("NFC");
    const matched = fuzzyMatch(Array.from(displayName.toLocaleLowerCase()), normalized);
    return matched === undefined ? undefined : {
      inputIndex,
      value: Object.freeze({ recentId: entry.recentId, displayName, score: matched.score, matchedIndices: Object.freeze(matched.indices) }),
    };
  }).filter((value): value is NonNullable<typeof value> => value !== undefined);
  projected.sort((left, right) => left.value.score - right.value.score || left.inputIndex - right.inputIndex);
  return Object.freeze(projected.map(({ value }) => value));
}

function fuzzyMatch(candidate: readonly string[], query: readonly string[]): { score: number; indices: number[] } | undefined {
  if (query.length === 0) return { score: 0, indices: [] };
  let cursor = 0;
  let gaps = 0;
  const indices: number[] = [];
  for (const character of query) {
    const found = candidate.indexOf(character, cursor);
    if (found < 0) return undefined;
    gaps += found - cursor;
    indices.push(found);
    cursor = found + 1;
  }
  const contiguous = indices.every((index, position) => position === 0 || index === indices[position - 1]! + 1);
  return { score: contiguous ? indices[0]! : candidate.length + gaps, indices };
}
