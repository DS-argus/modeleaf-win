export const NAVIGATION_HISTORY_LIMIT = 100;
export const NAVIGATION_HISTORY_TOLERANCE = 0.5;
const TOLERANCE_EPSILON = 1e-9;

export interface NavigationSnapshot { readonly pageIndex: number; readonly x: number; readonly y: number; }
export type NavigationCause = "page-prompt" | "page-first" | "page-last" | "internal-link" | "search" | "ordinary-scroll" | "page-next" | "page-previous" | "zoom" | "fit" | "rotation" | "external-link";
export type NavigationPrepareResult = { readonly kind: "prepared"; readonly transaction: NavigationTransaction } | { readonly kind: "excluded" } | { readonly kind: "same-location" } | { readonly kind: "search-epoch-recorded" } | { readonly kind: "invalid" };
export interface NavigationTransaction { readonly id: number; readonly generation: number; readonly kind: "jump" | "back" | "forward"; readonly origin: NavigationSnapshot; readonly target: NavigationSnapshot; readonly cause?: NavigationCause; readonly searchEpoch?: number; }
export type NavigationCommitResult = "committed" | "same-location" | "rolled-back" | "stale" | "failed-verification";
const RECORDED_CAUSES: ReadonlySet<NavigationCause> = new Set(["page-prompt", "page-first", "page-last", "internal-link", "search"]);

/** Two stacks plus the owner-supplied live position; preparation never mutates either stack. */
export class NavigationHistory {
  private back: NavigationSnapshot[] = [];
  private forward: NavigationSnapshot[] = [];
  private generation = 0;
  private transactionSequence = 0;
  private readonly pending = new Set<number>();
  private recordedSearchEpoch: number | undefined;

  public get canBack(): boolean { return this.back.length > 0; }
  public get canForward(): boolean { return this.forward.length > 0; }
  public snapshot(): Readonly<{ back: readonly NavigationSnapshot[]; forward: readonly NavigationSnapshot[]; generation: number }> {
    return Object.freeze({ back: Object.freeze(this.back.map(copy)), forward: Object.freeze(this.forward.map(copy)), generation: this.generation });
  }
  public prepareJump(origin: NavigationSnapshot, target: NavigationSnapshot, cause: NavigationCause, searchEpoch?: number): NavigationPrepareResult {
    if (!isSnapshot(origin) || !isSnapshot(target)) return { kind: "invalid" };
    if (!RECORDED_CAUSES.has(cause)) return { kind: "excluded" };
    if (sameSnapshotWithinTolerance(origin, target)) return { kind: "same-location" };
    if (cause === "search") {
      if (!Number.isSafeInteger(searchEpoch) || searchEpoch! < 0) return { kind: "invalid" };
      if (this.recordedSearchEpoch === searchEpoch) return { kind: "search-epoch-recorded" };
    }
    return this.prepare("jump", origin, target, cause, searchEpoch);
  }
  public prepareBack(origin: NavigationSnapshot): NavigationTransaction | undefined { return this.prepareTraversal("back", origin, this.back.at(-1)); }
  public prepareForward(origin: NavigationSnapshot): NavigationTransaction | undefined { return this.prepareTraversal("forward", origin, this.forward.at(-1)); }
  public commit(transaction: NavigationTransaction, displayed: NavigationSnapshot | undefined, verificationTarget: NavigationSnapshot = transaction.target): NavigationCommitResult {
    if (transaction.generation !== this.generation || !this.pending.delete(transaction.id)) return "stale";
    if (displayed === undefined || !isSnapshot(displayed) || !isSnapshot(verificationTarget)
      || verificationTarget.pageIndex !== transaction.target.pageIndex
      || !sameSnapshotWithinTolerance(verificationTarget, displayed)) { this.generation += 1; return "failed-verification"; }
    if (sameSnapshotWithinTolerance(transaction.origin, displayed)) { this.generation += 1; return "same-location"; }
    if (transaction.kind === "jump") { this.back.push(copy(transaction.origin)); this.forward = []; this.trimBack(); if (transaction.cause === "search") this.recordedSearchEpoch = transaction.searchEpoch; }
    else if (transaction.kind === "back") { this.back.pop(); this.forward.push(copy(transaction.origin)); }
    else { this.forward.pop(); this.back.push(copy(transaction.origin)); }
    this.generation += 1;
    return "committed";
  }
  public rollback(transaction: NavigationTransaction): NavigationCommitResult {
    if (transaction.generation !== this.generation || !this.pending.delete(transaction.id)) return "stale";
    this.generation += 1;
    return "rolled-back";
  }
  public cancelPending(): void { if (this.pending.size > 0) { this.pending.clear(); this.generation += 1; } }
  public reset(): void { this.back = []; this.forward = []; this.pending.clear(); this.recordedSearchEpoch = undefined; this.generation += 1; }
  private prepare(kind: NavigationTransaction["kind"], origin: NavigationSnapshot, target: NavigationSnapshot, cause?: NavigationCause, searchEpoch?: number): Extract<NavigationPrepareResult, { readonly kind: "prepared" }> {
    const transaction: NavigationTransaction = Object.freeze({ id: ++this.transactionSequence, generation: this.generation, kind, origin: copy(origin), target: copy(target), ...(cause === undefined ? {} : { cause }), ...(searchEpoch === undefined ? {} : { searchEpoch }) });
    this.pending.add(transaction.id);
    return { kind: "prepared", transaction };
  }
  private prepareTraversal(kind: "back" | "forward", origin: NavigationSnapshot, target: NavigationSnapshot | undefined): NavigationTransaction | undefined { return !isSnapshot(origin) || target === undefined ? undefined : this.prepare(kind, origin, target).transaction; }
  private trimBack(): void { const maxBack = NAVIGATION_HISTORY_LIMIT - 1 - this.forward.length; if (this.back.length > maxBack) this.back.splice(0, this.back.length - maxBack); }
}
export function isSnapshot(value: NavigationSnapshot): boolean { return Number.isSafeInteger(value.pageIndex) && value.pageIndex >= 0 && Number.isFinite(value.x) && Number.isFinite(value.y); }
export function sameSnapshot(left: NavigationSnapshot, right: NavigationSnapshot): boolean { return left.pageIndex === right.pageIndex && left.x === right.x && left.y === right.y; }
export function sameSnapshotWithinTolerance(left: NavigationSnapshot, right: NavigationSnapshot): boolean { return left.pageIndex === right.pageIndex && Math.abs(left.x - right.x) <= NAVIGATION_HISTORY_TOLERANCE + TOLERANCE_EPSILON && Math.abs(left.y - right.y) <= NAVIGATION_HISTORY_TOLERANCE + TOLERANCE_EPSILON; }
function copy(value: NavigationSnapshot): NavigationSnapshot { return Object.freeze({ pageIndex: value.pageIndex, x: value.x, y: value.y }); }
