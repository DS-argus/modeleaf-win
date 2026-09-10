const DIRECTORY_ELLIPSIS = "…";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface RecentPathFit {
  readonly directoryText: string;
  readonly filenameText: string;
  readonly fontSize: number;
}

export function fitRecentPath(
  displayPath: string,
  displayName: string,
  availableWidth: number,
  baseFontSize: number,
  measureText: (text: string, fontSize: number) => number,
): RecentPathFit {
  const separatorIndex = Math.max(displayPath.lastIndexOf("\\"), displayPath.lastIndexOf("/"));
  const directory = separatorIndex < 0 ? "" : displayPath.slice(0, separatorIndex + 1);
  const filenameText = displayName;
  const fullText = directory + filenameText;
  if (!(availableWidth > 0) || !(baseFontSize > 0) || measureText(fullText, baseFontSize) <= availableWidth) {
    return Object.freeze({ directoryText: directory, filenameText, fontSize: baseFontSize });
  }

  const graphemes = Array.from(graphemeSegmenter.segment(directory), ({ segment }) => segment);
  const prefixCount = rootPrefixGraphemeCount(graphemes);
  const preferredSuffixCount = graphemes.at(-1) !== undefined && isPathSeparator(graphemes.at(-1)!) ? 2 : 1;
  const suffixCount = Math.min(preferredSuffixCount, Math.max(0, graphemes.length - prefixCount - 1));
  const canTruncateDirectory = prefixCount > 0 && suffixCount > 0 && prefixCount + suffixCount < graphemes.length;
  const minimumDirectory = canTruncateDirectory
    ? truncateDirectory(graphemes, prefixCount, suffixCount, prefixCount + suffixCount)
    : directory;
  const minimumText = minimumDirectory + filenameText;
  const fontSize = largestFittingFontSize(minimumText, availableWidth, baseFontSize, measureText);

  if (!canTruncateDirectory || measureText(fullText, fontSize) <= availableWidth) {
    return Object.freeze({ directoryText: directory, filenameText, fontSize });
  }

  let lower = prefixCount + suffixCount;
  let upper = graphemes.length - 1;
  let directoryText = minimumDirectory;
  while (lower <= upper) {
    const retained = Math.floor((lower + upper) / 2);
    const candidate = truncateDirectory(graphemes, prefixCount, suffixCount, retained);
    if (measureText(candidate + filenameText, fontSize) <= availableWidth) {
      directoryText = candidate;
      lower = retained + 1;
    } else {
      upper = retained - 1;
    }
  }
  return Object.freeze({ directoryText, filenameText, fontSize });
}

function largestFittingFontSize(
  text: string,
  availableWidth: number,
  baseFontSize: number,
  measureText: (text: string, fontSize: number) => number,
): number {
  if (measureText(text, baseFontSize) <= availableWidth) return baseFontSize;
  let lower = 0;
  let upper = baseFontSize;
  let fitted = 0;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const candidate = (lower + upper) / 2;
    if (measureText(text, candidate) <= availableWidth) {
      fitted = candidate;
      lower = candidate;
    } else {
      upper = candidate;
    }
  }
  return fitted;
}

function truncateDirectory(
  graphemes: readonly string[],
  prefixCount: number,
  suffixCount: number,
  retainedCount: number,
): string {
  const extraCount = retainedCount - prefixCount - suffixCount;
  const leadingCount = prefixCount + Math.ceil(extraCount / 2);
  const trailingCount = suffixCount + Math.floor(extraCount / 2);
  return graphemes.slice(0, leadingCount).join("") + DIRECTORY_ELLIPSIS + graphemes.slice(graphemes.length - trailingCount).join("");
}

function rootPrefixGraphemeCount(graphemes: readonly string[]): number {
  if (graphemes.length === 0) return 0;
  if (/^[A-Za-z]$/u.test(graphemes[0]!) && graphemes[1] === ":" && isPathSeparator(graphemes[2])) return 3;
  if (isPathSeparator(graphemes[0]) && isPathSeparator(graphemes[1])) {
    let componentSeparators = 0;
    for (let index = 2; index < graphemes.length; index += 1) {
      if (!isPathSeparator(graphemes[index])) continue;
      componentSeparators += 1;
      if (componentSeparators === 2) return index + 1;
    }
    return 2;
  }
  if (isPathSeparator(graphemes[0])) return 1;
  const firstSeparator = graphemes.findIndex(isPathSeparator);
  return firstSeparator < 0 ? 1 : firstSeparator + 1;
}

function isPathSeparator(value: string | undefined): boolean {
  return value === "\\" || value === "/";
}
