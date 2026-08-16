export const NAVIGATION_HISTORY_LIMIT = 100;

export interface NavigationSnapshot {
  readonly pageIndex: number;
  readonly x: number;
  readonly y: number;
}

export type NavigationCause =
  | "page-prompt"
  | "page-first"
  | "page-last"
  | "internal-link"
  | "link-hint"
  | "outline"
  | "search"
  | "ordinary-scroll"
  | "page-next"
  | "page-previous"
  | "zoom"
  | "fit"
  | "rotation"
  | "external-link";

export type NavigationPrepareResult =
  | { readonly kind: "prepared"; readonly transaction: NavigationTransaction }
  | { readonly kind: "excluded" }
  | { readonly kind: "same-location" }
  | { readonly kind: "search-epoch-recorded" }
  | { readonly kind: "invalid" };

export interface NavigationTransaction {
  readonly id: number;
  readonly generation: number;
  readonly kind: "jump" | "back" | "forward";
  readonly origin: NavigationSnapshot;
  readonly target: NavigationSnapshot;
  readonly cause?: NavigationCause;
  readonly searchEpoch?: number;
  readonly targetIndex?: number;
}

export type NavigationCommitResult =
  | "committed"
  | "rolled-back"
  | "stale"
  | "failed-verification";

const RECORDED_CAUSES: ReadonlySet<NavigationCause> = new Set([
  "page-prompt",
  "page-first",
  "page-last",
  "internal-link",
  "link-hint",
  "outline",
  "search",
]);

/**
 * Pure tab/pane-local page-space history. Preparing never mutates state; only a
 * verified displayed landing commits a jump or cursor movement.
 */
export class NavigationHistory {
  private positions: NavigationSnapshot[] = [];
  private cursor = -1;
  private generation = 0;
  private transactionSequence = 0;
  private readonly pendingTransactionIds = new Set<number>();
  private readonly recordedSearchEpochs = new Set<number>();

  public snapshot(): Readonly<{ positions: readonly NavigationSnapshot[]; cursor: number; generation: number }> {
    return Object.freeze({
      positions: Object.freeze(this.positions.map(freezeSnapshot)),
      cursor: this.cursor,
      generation: this.generation,
    });
  }

  public current(): NavigationSnapshot | undefined {
    return this.cursor < 0 ? undefined : freezeSnapshot(this.positions[this.cursor]!);
  }

  public prepareJump(
    origin: NavigationSnapshot,
    target: NavigationSnapshot,
    cause: NavigationCause,
    searchEpoch?: number,
  ): NavigationPrepareResult {
    if (!isSnapshot(origin) || !isSnapshot(target)) return { kind: "invalid" };
    if (!RECORDED_CAUSES.has(cause)) return { kind: "excluded" };
    if (sameSnapshot(origin, target)) return { kind: "same-location" };
    if (cause === "search") {
      if (!Number.isSafeInteger(searchEpoch) || searchEpoch! < 0) return { kind: "invalid" };
      if (this.recordedSearchEpochs.has(searchEpoch!)) return { kind: "search-epoch-recorded" };
    }
    const transaction = Object.freeze({
      id: ++this.transactionSequence,
      generation: this.generation,
      kind: "jump" as const,
      origin: freezeSnapshot(origin),
      target: freezeSnapshot(target),
      cause,
      ...(searchEpoch === undefined ? {} : { searchEpoch }),
    });
    this.pendingTransactionIds.add(transaction.id);
    return { kind: "prepared", transaction };
  }

  public prepareBack(): NavigationTransaction | undefined {
    return this.prepareCursorMove("back", this.cursor - 1);
  }

  public prepareForward(): NavigationTransaction | undefined {
    return this.prepareCursorMove("forward", this.cursor + 1);
  }

  public commit(transaction: NavigationTransaction, displayed: NavigationSnapshot | undefined): NavigationCommitResult {
    if (transaction.generation !== this.generation || !this.pendingTransactionIds.has(transaction.id)) return "stale";
    this.pendingTransactionIds.delete(transaction.id);
    if (displayed === undefined || !isSnapshot(displayed) || !sameSnapshot(transaction.target, displayed)) {
      this.generation += 1;
      return "failed-verification";
    }
    if (transaction.kind === "jump") this.commitJump(transaction);
    else this.cursor = transaction.targetIndex!;
    this.generation += 1;
    return "committed";
  }

  public rollback(transaction: NavigationTransaction): NavigationCommitResult {
    if (transaction.generation !== this.generation || !this.pendingTransactionIds.delete(transaction.id)) return "stale";
    this.generation += 1;
    return "rolled-back";
  }

  public reset(): void {
    this.positions = [];
    this.cursor = -1;
    this.recordedSearchEpochs.clear();
    this.pendingTransactionIds.clear();
    this.generation += 1;
  }

  private prepareCursorMove(kind: "back" | "forward", targetIndex: number): NavigationTransaction | undefined {
    if (this.cursor < 0 || targetIndex < 0 || targetIndex >= this.positions.length) return undefined;
    const transaction = Object.freeze({
      id: ++this.transactionSequence,
      generation: this.generation,
      kind,
      origin: freezeSnapshot(this.positions[this.cursor]!),
      target: freezeSnapshot(this.positions[targetIndex]!),
      targetIndex,
    });
    this.pendingTransactionIds.add(transaction.id);
    return transaction;
  }

  private commitJump(transaction: NavigationTransaction): void {
    const origin = freezeSnapshot(transaction.origin);
    const target = freezeSnapshot(transaction.target);
    const retained = this.cursor < 0 ? [] : this.positions.slice(0, this.cursor + 1);
    if (retained.length === 0 || !sameSnapshot(retained[retained.length - 1]!, origin)) retained.push(origin);
    retained.push(target);
    if (retained.length > NAVIGATION_HISTORY_LIMIT) retained.splice(0, retained.length - NAVIGATION_HISTORY_LIMIT);
    this.positions = retained;
    this.cursor = retained.length - 1;
    if (transaction.cause === "search") this.recordedSearchEpochs.add(transaction.searchEpoch!);
  }
}

export function isSnapshot(value: NavigationSnapshot): boolean {
  return Number.isSafeInteger(value.pageIndex) && value.pageIndex >= 0
    && Number.isFinite(value.x) && Number.isFinite(value.y);
}

export function sameSnapshot(left: NavigationSnapshot, right: NavigationSnapshot): boolean {
  return left.pageIndex === right.pageIndex && left.x === right.x && left.y === right.y;
}

function freezeSnapshot(snapshot: NavigationSnapshot): NavigationSnapshot {
  return Object.freeze({ pageIndex: snapshot.pageIndex, x: snapshot.x, y: snapshot.y });
}
