export interface PagePoint {
  readonly x: number;
  readonly y: number;
}

export interface PageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type LinkTarget =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "goTo"; readonly pageIndex: number; readonly point?: PagePoint };

export interface RawLink {
  readonly sourcePageIndex: number;
  readonly pageSpaceBounds: PageRect;
  readonly target: LinkTarget;
}

export interface ReaderLink {
  readonly sourcePageIndex: number;
  readonly rects: readonly PageRect[];
  readonly target: LinkTarget;
  readonly primaryLabelRect: PageRect;
}

export interface LinkHint extends ReaderLink {
  readonly label: string;
}

export interface HintKeyInput {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
}

export interface HintFilterResult {
  readonly query: string;
  readonly matches: readonly LinkHint[];
  readonly selected: LinkHint | null;
}

export const DEFAULT_HINT_ALPHABET = "fjdkslaghrueiwoncmpvtbyzxq";

/** Generates unique, prefix-free, lowercase labels in a fixed reading-order alphabet. */
export function generateHintLabels(count: number, alphabet = DEFAULT_HINT_ALPHABET): readonly string[] {
  if (!Number.isSafeInteger(count) || count <= 0) {
    return Object.freeze([]);
  }
  if (!/^[a-z]+$/.test(alphabet) || new Set(alphabet).size !== alphabet.length || alphabet.length < 2) {
    throw new Error("hint alphabet must contain at least two unique lowercase letters");
  }

  let length = 1;
  let capacity = alphabet.length;
  while (capacity < count) {
    capacity *= alphabet.length;
    length += 1;
  }

  return Object.freeze(Array.from({ length: count }, (_, index) => {
    let value = index;
    let label = "";
    for (let digit = 0; digit < length; digit += 1) {
      label = alphabet[value % alphabet.length]! + label;
      value = Math.floor(value / alphabet.length);
    }
    return label;
  }));
}

/** Dedupe only annotation geometry plus the complete target identity, then canonicalize reading order. */
export function mergeLinks(rawLinks: readonly RawLink[]): readonly ReaderLink[] {
  const ordered = [...rawLinks].sort(compareRawLinks);
  const unique: ReaderLink[] = [];
  for (const link of ordered) {
    if (!unique.some((candidate) => isExactDuplicate(candidate, link))) {
      const bounds = freezeRect(link.pageSpaceBounds);
      unique.push(Object.freeze({
        sourcePageIndex: link.sourcePageIndex,
        rects: Object.freeze([bounds]),
        target: freezeTarget(link.target),
        primaryLabelRect: bounds,
      }));
    }
  }
  return Object.freeze(unique);
}

export function buildLinkHints(rawLinks: readonly RawLink[]): readonly LinkHint[] {
  const links = mergeLinks(rawLinks);
  const labels = generateHintLabels(links.length);
  return Object.freeze(links.map((link, index) => Object.freeze({ ...link, label: labels[index]! })));
}

/** Filters immutable hint records by a lowercase label prefix. Invalid input has no matches. */
export function filterLinkHints(hints: readonly LinkHint[], query: string): HintFilterResult {
  if (!/^[a-z]*$/.test(query)) {
    return Object.freeze({ query, matches: Object.freeze([]), selected: null });
  }
  const matches = Object.freeze(hints.filter((hint) => hint.label.startsWith(query)));
  return Object.freeze({
    query,
    matches,
    selected: matches.length === 1 && matches[0]!.label === query ? matches[0]! : null,
  });
}

/** Rejects IME, modifier, uppercase, dead-key, and non-letter input before changing the filter. */
export function appendHintInput(query: string, input: HintKeyInput): string | null {
  if (
    input.altKey || input.ctrlKey || input.metaKey || input.shiftKey || input.isComposing ||
    !/^[a-z]$/.test(input.key) || !/^[a-z]*$/.test(query)
  ) {
    return null;
  }
  return query + input.key;
}

function compareRawLinks(left: RawLink, right: RawLink): number {
  if (left.sourcePageIndex !== right.sourcePageIndex) {
    return left.sourcePageIndex - right.sourcePageIndex;
  }
  const geometry = compareRectsInReadingOrder(left.pageSpaceBounds, right.pageSpaceBounds);
  return geometry !== 0 ? geometry : compareTargets(left.target, right.target);
}

function compareRectsInReadingOrder(left: PageRect, right: PageRect): number {
  const topDifference = minY(right) - minY(left);
  return topDifference !== 0 ? topDifference : minX(left) - minX(right);
}

function compareTargets(left: LinkTarget, right: LinkTarget): number {
  if (left.kind !== right.kind) {
    return left.kind === "url" ? -1 : 1;
  }
  if (left.kind === "url" && right.kind === "url") {
    return left.url.localeCompare(right.url);
  }
  const leftGoTo = left as Extract<LinkTarget, { kind: "goTo" }>;
  const rightGoTo = right as Extract<LinkTarget, { kind: "goTo" }>;
  if (leftGoTo.pageIndex !== rightGoTo.pageIndex) {
    return leftGoTo.pageIndex - rightGoTo.pageIndex;
  }
  if (!leftGoTo.point || !rightGoTo.point) {
    return leftGoTo.point === rightGoTo.point ? 0 : leftGoTo.point ? 1 : -1;
  }
  return leftGoTo.point.y === rightGoTo.point.y
    ? leftGoTo.point.x - rightGoTo.point.x
    : rightGoTo.point.y - leftGoTo.point.y;
}

function isExactDuplicate(link: ReaderLink, raw: RawLink): boolean {
  return link.sourcePageIndex === raw.sourcePageIndex &&
    sameRect(link.primaryLabelRect, raw.pageSpaceBounds) && sameTarget(link.target, raw.target);
}

function sameRect(left: PageRect, right: PageRect): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function sameTarget(left: LinkTarget, right: LinkTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "url" && right.kind === "url") return left.url === right.url;
  const a = left as Extract<LinkTarget, { kind: "goTo" }>;
  const b = right as Extract<LinkTarget, { kind: "goTo" }>;
  return a.pageIndex === b.pageIndex && a.point?.x === b.point?.x && a.point?.y === b.point?.y;
}

function minX(rect: PageRect): number {
  return Math.min(rect.x, rect.x + rect.width);
}

function minY(rect: PageRect): number {
  return Math.min(rect.y, rect.y + rect.height);
}

function freezeRect(rect: PageRect): PageRect {
  return Object.freeze({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
}

function freezeTarget(target: LinkTarget): LinkTarget {
  if (target.kind === "url") return Object.freeze({ kind: "url", url: target.url });
  return Object.freeze({
    kind: "goTo",
    pageIndex: target.pageIndex,
    ...(target.point === undefined ? {} : { point: Object.freeze({ ...target.point }) }),
  });
}
