export const MAX_RECENT_FILES = 15;
export interface RecentFile { readonly id: string; readonly path: string; readonly filename: string; readonly openedAt: number }
export interface RecentFileMatch { readonly id: string; readonly filename: string; readonly openedAt: number; readonly score: number; readonly matchedIndices: readonly number[] }
export type RecentOpenResult =
  | { readonly ok: true; readonly entries: readonly RecentFile[] }
  | { readonly ok: false; readonly error: "RECENT_PATH_EMPTY" | "RECENT_NOT_PDF" | "RECENT_FILENAME_EMPTY" | "RECENT_FILENAME_MISMATCH" | "RECENT_TIMESTAMP_INVALID" };
export type RecentOpenFailure = "missing" | "path-not-found" | "permission" | "transient" | "invalid-pdf";

export function recordSuccessfulPdfOpen(entries: readonly RecentFile[], input: { readonly id: string; readonly path: string; readonly filename: string; readonly openedAt: number }): RecentOpenResult {
  if (input.path.length === 0 || input.id.length === 0) return { ok: false, error: "RECENT_PATH_EMPTY" };
  const authoritativeFilename = basename(input.path);
  if (authoritativeFilename.length === 0) return { ok: false, error: "RECENT_FILENAME_EMPTY" };
  if (authoritativeFilename !== input.filename) return { ok: false, error: "RECENT_FILENAME_MISMATCH" };
  if (!/\.pdf$/iu.test(authoritativeFilename)) return { ok: false, error: "RECENT_NOT_PDF" };
  if (!Number.isFinite(input.openedAt) || input.openedAt < 0) return { ok: false, error: "RECENT_TIMESTAMP_INVALID" };
  const candidate = Object.freeze({ id: input.id, path: input.path, filename: authoritativeFilename, openedAt: input.openedAt });
  return { ok: true, entries: Object.freeze([candidate, ...entries.filter((entry) => entry.path !== input.path)].slice(0, MAX_RECENT_FILES)) };
}

export function shouldPruneRecent(failure: RecentOpenFailure): boolean { return failure === "missing" || failure === "path-not-found"; }

export function filterRecentFiles(entries: readonly RecentFile[], query: string): readonly RecentFileMatch[] {
  const normalized = Array.from(query.normalize("NFC").trim().toLocaleLowerCase());
  const projected = entries.map((entry, inputIndex) => {
    const filename = entry.filename.normalize("NFC");
    const matched = fuzzyMatch(Array.from(filename.toLocaleLowerCase()), normalized);
    return matched === undefined ? undefined : {
      inputIndex,
      value: Object.freeze({ id: entry.id, filename, openedAt: entry.openedAt, score: matched.score, matchedIndices: Object.freeze(matched.indices) }),
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
function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
