export const OUTLINE_EDGE_TOLERANCE_POINTS = 8;
export const MAX_OUTLINE_ROWS = 2048;

export interface RawOutlineDestination {
  readonly pageIndex: number;
  readonly x: number;
  readonly y: number;
  readonly pageWidth: number;
  readonly pageHeight: number;
}
export interface RawOutlineNode {
  readonly title?: string;
  readonly destination?: RawOutlineDestination;
  readonly children?: readonly RawOutlineNode[];
}
export interface OutlineDestination { readonly pageIndex: number; readonly x: number; readonly y: number }
export interface OutlineRow {
  readonly id: string;
  readonly title: string;
  readonly depth: 0 | 1;
  readonly destination?: OutlineDestination;
  readonly enabled: boolean;
  readonly selector?: string;
}

export function normalizeOutline(nodes: readonly RawOutlineNode[]): readonly OutlineRow[] {
  const roots = hideSingleWrapper(nodes);
  const visited = new Set<RawOutlineNode>();
  const rows: Omit<OutlineRow, "selector">[] = [];
  const visit = (node: RawOutlineNode, path: readonly number[], sourceDepth: number): void => {
    if (rows.length >= MAX_OUTLINE_ROWS || visited.has(node)) return;
    visited.add(node);
    const destination = normalizeDestination(node.destination);
    rows.push(Object.freeze({
      id: path.join("."), title: node.title?.trim() || "Untitled section",
      depth: Math.min(sourceDepth, 1) as 0 | 1,
      ...(destination === undefined ? {} : { destination }), enabled: destination !== undefined,
    }));
    if (sourceDepth < 1) for (const [index, child] of (node.children ?? []).entries()) visit(child, [...path, index], sourceDepth + 1);
  };
  roots.forEach((node, index) => visit(node, [index], 0));
  let selectorIndex = 0;
  return Object.freeze(rows.map((row): OutlineRow => Object.freeze({
    ...row,
    ...(row.enabled ? { selector: selectorLabel(selectorIndex++) } : {}),
  })));
}

export function currentOutlineRow(rows: readonly OutlineRow[], position: { readonly pageIndex: number; readonly x: number; readonly y: number }): OutlineRow | undefined {
  let current: OutlineRow | undefined;
  for (const row of rows) {
    const destination = row.destination;
    if (destination === undefined) continue;
    const before = destination.pageIndex < position.pageIndex
      || (destination.pageIndex === position.pageIndex && (destination.y > position.y
        || (destination.y === position.y && destination.x <= position.x)));
    if (before && (current === undefined || compareDestinations(current.destination!, destination) < 0)) current = row;
  }
  return current;
}

function hideSingleWrapper(nodes: readonly RawOutlineNode[]): readonly RawOutlineNode[] {
  return nodes.length === 1 && nodes[0]!.destination === undefined && (nodes[0]!.children?.length ?? 0) > 0
    ? nodes[0]!.children!
    : nodes;
}
function normalizeDestination(value: RawOutlineDestination | undefined): OutlineDestination | undefined {
  if (value === undefined || !Number.isSafeInteger(value.pageIndex) || value.pageIndex < 0
    || ![value.x, value.y, value.pageWidth, value.pageHeight].every(Number.isFinite)
    || value.pageWidth <= 0 || value.pageHeight <= 0 || value.x < -OUTLINE_EDGE_TOLERANCE_POINTS
    || value.x > value.pageWidth + OUTLINE_EDGE_TOLERANCE_POINTS || value.y < -OUTLINE_EDGE_TOLERANCE_POINTS
    || value.y > value.pageHeight + OUTLINE_EDGE_TOLERANCE_POINTS) return undefined;
  return Object.freeze({ pageIndex: value.pageIndex, x: Math.min(value.pageWidth, Math.max(0, value.x)), y: Math.min(value.pageHeight, Math.max(0, value.y)) });
}
function selectorLabel(index: number): string {
  return String(index + 1);
}
function compareDestinations(left: OutlineDestination, right: OutlineDestination): number {
  return left.pageIndex - right.pageIndex || right.y - left.y || left.x - right.x;
}
