const ELLIPSIS = "…";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface RecentPathFit {
  readonly directoryText: string;
  readonly filenameText: string;
}

/** Fits display text only; the caller retains the full path for accessibility/tooltip. */
export function fitRecentPath(
  displayPath: string,
  displayName: string,
  availableWidth: number,
  measureText: (text: string) => number,
): RecentPathFit {
  const result = (directoryText: string, filenameText: string): RecentPathFit => Object.freeze({ directoryText, filenameText });
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return result("", "");
  const fits = (text: string): boolean => {
    const width = measureText(text);
    return Number.isFinite(width) && width >= 0 && width <= availableWidth;
  };
  const separatorIndex = Math.max(displayPath.lastIndexOf("\\"), displayPath.lastIndexOf("/"));
  const directory = separatorIndex < 0 ? "" : displayPath.slice(0, separatorIndex + 1);
  if (fits(directory + displayName)) return result(directory, displayName);

  const parts = graphemes(directory);
  const prefixCount = rootPrefixLength(parts);
  const suffixCount = Math.min(isSeparator(parts.at(-1)) ? 2 : 1, Math.max(0, parts.length - prefixCount - 1));
  const minimum = prefixCount + suffixCount;
  // Retain the full filename when a middle-cut directory can fit. No list of
  // all possible strings is materialized, even for a32767-unit Windows path.
  if (prefixCount > 0 && suffixCount > 0 && minimum < parts.length) {
    const candidate = (retained: number): string => {
      const extra = retained - minimum;
      return parts.slice(0, prefixCount + Math.ceil(extra / 2)).join("") + ELLIPSIS
        + parts.slice(parts.length - suffixCount - Math.floor(extra / 2)).join("");
    };
    if (fits(candidate(minimum) + displayName)) {
      const fitted = largestFitting(minimum, parts.length - 1, candidate, text => fits(text + displayName));
      if (fitted !== undefined) return result(fitted, displayName);
    }
  }

  const separator = directory.endsWith("/") ? "/" : "\\";
  const root = parts.slice(0, prefixCount).join("");
  const rooted = directory === root ? root : root + ELLIPSIS + separator;
  const unc = isSeparator(parts[0]) && isSeparator(parts[1]);
  const directories = directory.length === 0 ? [""]
    : [...new Set([rooted, ...(unc ? [separator + separator + ELLIPSIS + separator] : []), ELLIPSIS + separator, ""])];
  const filenamePreservingDirectories = unc ? directories.slice(0, 2) : directories.slice(0, 1);
  for (const label of filenamePreservingDirectories) {
    if (fits(label + displayName)) return result(label, displayName);
  }
  const extension = displayName.length > 4 && /\.pdf$/iu.test(displayName) ? displayName.slice(-4) : "";
  const stem = graphemes(extension ? displayName.slice(0, -extension.length) : displayName);
  const minimumName = ELLIPSIS + extension;
  for (const label of directories) {
    if (fits(label + displayName)) return result(label, displayName);
    if (!fits(label + minimumName)) continue;
    const candidate = (retained: number): string => stem.slice(0, Math.ceil(retained / 2)).join("")
      + ELLIPSIS + stem.slice(stem.length - Math.floor(retained / 2)).join("") + extension;
    const fitted = largestFitting(0, Math.max(0, stem.length - 1), candidate, text => fits(label + text));
    if (fitted !== undefined) return result(label, fitted);
  }
  if (extension && fits(extension)) return result("", extension);
  return fits(ELLIPSIS) ? result("", ELLIPSIS) : result("", "");
}

function largestFitting(minimum: number, maximum: number, candidate: (retained: number) => string, fits: (text: string) => boolean): string | undefined {
  let best: string | undefined;
  while (minimum <= maximum) {
    const retained = Math.floor((minimum + maximum) / 2);
    const text = candidate(retained);
    if (fits(text)) { best = text; minimum = retained + 1; }
    else maximum = retained - 1;
  }
  return best;
}

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
}
function isSeparator(character: string | undefined): boolean { return character === "\\" || character === "/"; }
function rootPrefixLength(parts: readonly string[]): number {
  if (parts.length === 0) return 0;
  if (/^[A-Za-z]$/u.test(parts[0]!) && parts[1] === ":" && isSeparator(parts[2])) return 3;
  if (isSeparator(parts[0]) && isSeparator(parts[1])) {
    let separators = 0;
    for (let index = 2; index < parts.length; index += 1) {
      if (isSeparator(parts[index]) && ++separators === 2) return index + 1;
    }
    return Math.min(2, parts.length);
  }
  if (isSeparator(parts[0])) return 1;
  const index = parts.findIndex(isSeparator);
  return index < 0 ? 0 : index + 1;
}
