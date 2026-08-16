export const MAX_PANES = 4;
declare const paneIdBrand: unique symbol;
export type PaneId = number & { readonly [paneIdBrand]: "PaneId" };
export type SplitAxis = "horizontal" | "vertical";
declare const paneOwnerIdBrand: unique symbol;
export type PaneOwnerId = string & { readonly [paneOwnerIdBrand]: "PaneOwnerId" };
export function paneOwnerId(value: string): PaneOwnerId {
  if (value.trim().length === 0) throw new Error("Pane owner must not be empty");
  return value as PaneOwnerId;
}
export type FocusDirection = "left" | "right" | "up" | "down";

export type PaneNode =
  | { readonly kind: "leaf"; readonly paneId: PaneId; readonly tabOwnerId: PaneOwnerId }
  | { readonly kind: "split"; readonly axis: SplitAxis; readonly first: PaneNode; readonly second: PaneNode };
export interface PaneTopologySnapshot { readonly root: PaneNode; readonly focusedPaneId: PaneId; readonly paneCount: number; readonly revision: number; readonly stagedPaneId?: PaneId }
export type PaneResult =
  | { readonly ok: true; readonly snapshot: PaneTopologySnapshot; readonly effect?: { readonly kind: "detached"; readonly ownerIds: readonly PaneOwnerId[] } }
  | { readonly ok: false; readonly reason: "Maximum panes open" | "Pane not found" | "Split already staged" | "No split staged" | "Cannot close last pane" | "Stale pane owner" | "Pane owner already installed" | "No pane in direction" };

interface StagedSplit { readonly baseRevision: number; readonly sourcePaneId: PaneId; readonly newPaneId: PaneId; readonly root: PaneNode }
interface Rect { x: number; y: number; width: number; height: number }

export class PaneTopology {
  private rootValue: PaneNode;
  private focusedPaneIdValue: PaneId;
  private nextPaneId = 2;
  private revision = 0;
  private staged: StagedSplit | undefined;

  public constructor(initialTabOwnerId: PaneOwnerId) {
    this.rootValue = leaf(1 as PaneId, initialTabOwnerId);
    this.focusedPaneIdValue = 1 as PaneId;
  }

  public snapshot(): PaneTopologySnapshot {
    return Object.freeze({
      root: freezeNode(this.rootValue), focusedPaneId: this.focusedPaneIdValue,
      paneCount: leaves(this.rootValue).length, revision: this.revision,
      ...(this.staged === undefined ? {} : { stagedPaneId: this.staged.newPaneId }),
    });
  }

  public stageSplit(sourcePaneId: PaneId, axis: SplitAxis, newTabOwnerId: PaneOwnerId): PaneResult {
    if (this.staged !== undefined) return { ok: false, reason: "Split already staged" };
    if (!hasPane(this.rootValue, sourcePaneId)) return { ok: false, reason: "Stale pane owner" };
    if (leaves(this.rootValue).length >= MAX_PANES) return { ok: false, reason: "Maximum panes open" };
    if (leaves(this.rootValue).some((pane) => pane.tabOwnerId === newTabOwnerId)) return { ok: false, reason: "Pane owner already installed" };
    const newPaneId = this.nextPaneId++ as PaneId;
    const replacement: PaneNode = Object.freeze({ kind: "split", axis, first: findLeaf(this.rootValue, sourcePaneId)!, second: leaf(newPaneId, newTabOwnerId) });
    const root = replaceLeaf(this.rootValue, sourcePaneId, replacement)!;
    this.staged = Object.freeze({ baseRevision: this.revision, sourcePaneId, newPaneId, root });
    return { ok: true, snapshot: this.snapshot() };
  }

  public commitSplit(): PaneResult {
    if (this.staged === undefined) return { ok: false, reason: "No split staged" };
    if (this.staged.baseRevision !== this.revision || !hasPane(this.rootValue, this.staged.sourcePaneId)) {
      this.staged = undefined;
      return { ok: false, reason: "Stale pane owner" };
    }
    this.rootValue = this.staged.root;
    this.focusedPaneIdValue = this.staged.newPaneId;
    this.staged = undefined;
    this.revision += 1;
    return { ok: true, snapshot: this.snapshot() };
  }

  public rollbackSplit(): PaneResult {
    if (this.staged === undefined) return { ok: false, reason: "No split staged" };
    this.staged = undefined;
    return { ok: true, snapshot: this.snapshot() };
  }

  public focus(paneId: PaneId): PaneResult {
    if (!hasPane(this.rootValue, paneId)) return { ok: false, reason: "Pane not found" };
    this.focusedPaneIdValue = paneId;
    return { ok: true, snapshot: this.snapshot() };
  }

  public focusDirection(direction: FocusDirection): PaneResult {
    const layouts = new Map<PaneId, Rect>();
    layout(this.rootValue, { x: 0, y: 0, width: 1, height: 1 }, layouts);
    const origin = layouts.get(this.focusedPaneIdValue)!;
    const candidates = [...layouts].filter(([id, rect]) => id !== this.focusedPaneIdValue && isDirection(origin, rect, direction));
    candidates.sort((left, right) => compareFocus(origin, left[1], right[1], direction) || Number(left[0]) - Number(right[0]));
    if (candidates.length === 0) return { ok: false, reason: "No pane in direction" };
    this.focusedPaneIdValue = candidates[0]![0];
    return { ok: true, snapshot: this.snapshot() };
  }

  public unsplit(paneId: PaneId): PaneResult {
    const retained = findLeaf(this.rootValue, paneId);
    if (retained === undefined) return { ok: false, reason: "Pane not found" };
    const currentLeaves = leaves(this.rootValue);
    if (currentLeaves.length === 1) return { ok: false, reason: "Cannot close last pane" };
    const ownerIds = Object.freeze(currentLeaves.filter((pane) => pane.paneId !== paneId).map((pane) => pane.tabOwnerId));
    this.rootValue = retained;
    this.focusedPaneIdValue = paneId;
    this.staged = undefined;
    this.revision += 1;
    return { ok: true, snapshot: this.snapshot(), effect: Object.freeze({ kind: "detached", ownerIds }) };
  }
}

const leaf = (paneId: PaneId, tabOwnerId: PaneOwnerId): PaneNode => Object.freeze({ kind: "leaf", paneId, tabOwnerId });
const freezeNode = (node: PaneNode): PaneNode => node.kind === "leaf" ? leaf(node.paneId, node.tabOwnerId) : Object.freeze({ kind: "split", axis: node.axis, first: freezeNode(node.first), second: freezeNode(node.second) });
const leaves = (node: PaneNode): Extract<PaneNode, { kind: "leaf" }>[] => node.kind === "leaf" ? [node] : [...leaves(node.first), ...leaves(node.second)];
const hasPane = (node: PaneNode, id: PaneId): boolean => leaves(node).some((candidate) => candidate.paneId === id);
const findLeaf = (node: PaneNode, id: PaneId): Extract<PaneNode, { kind: "leaf" }> | undefined => leaves(node).find((candidate) => candidate.paneId === id);
function replaceLeaf(node: PaneNode, id: PaneId, replacement: PaneNode): PaneNode | undefined {
  if (node.kind === "leaf") return node.paneId === id ? replacement : undefined;
  const first = replaceLeaf(node.first, id, replacement);
  if (first !== undefined) return Object.freeze({ ...node, first });
  const second = replaceLeaf(node.second, id, replacement);
  return second === undefined ? undefined : Object.freeze({ ...node, second });
}
function layout(node: PaneNode, rect: Rect, output: Map<PaneId, Rect>): void {
  if (node.kind === "leaf") { output.set(node.paneId, rect); return; }
  if (node.axis === "horizontal") {
    layout(node.first, { ...rect, width: rect.width / 2 }, output);
    layout(node.second, { ...rect, x: rect.x + rect.width / 2, width: rect.width / 2 }, output);
  } else {
    layout(node.first, { ...rect, height: rect.height / 2 }, output);
    layout(node.second, { ...rect, y: rect.y + rect.height / 2, height: rect.height / 2 }, output);
  }
}
const center = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
function isDirection(origin: Rect, candidate: Rect, direction: FocusDirection): boolean {
  const a = center(origin); const b = center(candidate);
  return direction === "left" ? b.x < a.x : direction === "right" ? b.x > a.x : direction === "up" ? b.y < a.y : b.y > a.y;
}
function focusRank(origin: Rect, candidate: Rect, direction: FocusDirection): readonly number[] {
  const horizontal = direction === "left" || direction === "right";
  const overlap = horizontal
    ? Math.max(0, Math.min(origin.y + origin.height, candidate.y + candidate.height) - Math.max(origin.y, candidate.y))
    : Math.max(0, Math.min(origin.x + origin.width, candidate.x + candidate.width) - Math.max(origin.x, candidate.x));
  const a = center(origin);
  const b = center(candidate);
  const primary = horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
  const perpendicular = horizontal ? Math.abs(b.y - a.y) : Math.abs(b.x - a.x);
  return [overlap > 0 ? 0 : 1, primary, perpendicular];
}
function compareFocus(origin: Rect, left: Rect, right: Rect, direction: FocusDirection): number {
  const a = focusRank(origin, left, direction);
  const b = focusRank(origin, right, direction);
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}
