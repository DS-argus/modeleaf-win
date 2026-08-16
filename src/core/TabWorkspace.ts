export const MAX_TAB_COUNT = 8;
const HISTORY_LIMIT = 32;

declare const tabIdBrand: unique symbol;

/** An opaque, workspace-local identifier. */
export type TabId = number & { readonly [tabIdBrand]: "TabId" };

/** The workspace owns calling this hook, while the caller owns the resource it closes. */
export interface TabLifecycle<T> {
  dispose(payload: T): void;
}

export interface TabSnapshot<T> {
  readonly id: TabId;
  /** Caller-owned state. It is deliberately neither copied nor frozen. */
  readonly payload: T;
  readonly staged: boolean;
}

export type TabHistoryKind = "append" | "activate" | "close" | "stage" | "commit" | "rollback";

export interface TabHistoryEntry {
  readonly kind: TabHistoryKind;
  readonly tabId: TabId;
}

export interface TabWorkspaceSnapshot<T> {
  readonly tabs: readonly TabSnapshot<T>[];
  readonly activeTabId: TabId;
  readonly history: readonly TabHistoryEntry[];
}

interface TabRecord<T> {
  readonly id: TabId;
  payload: T;
  lifecycle?: TabLifecycle<T>;
  staged: boolean;
  previousActiveId?: TabId;
  disposed: boolean;
}

/** Ordered UI tabs only; callers associate their own state payload with a tab. */
export class TabWorkspace<T = undefined> {
  private readonly createEmptyPayload: () => T;
  private readonly createEmptyLifecycle: TabLifecycle<T> | undefined;
  private readonly maximumTabs: number;
  private readonly tabs: TabRecord<T>[] = [];
  private readonly historyEntries: TabHistoryEntry[] = [];
  private activeId: TabId;
  private nextId = 1;
  private snapshotValue: TabWorkspaceSnapshot<T>;

  constructor(createEmptyPayload: () => T = (() => undefined as T), maximumTabs = MAX_TAB_COUNT, createEmptyLifecycle?: TabLifecycle<T>) {
    if (!Number.isSafeInteger(maximumTabs) || maximumTabs < 1 || maximumTabs > MAX_TAB_COUNT) {
      throw new RangeError(`maximumTabs must be a safe integer between 1 and ${MAX_TAB_COUNT}`);
    }
    this.createEmptyPayload = createEmptyPayload;
    this.createEmptyLifecycle = createEmptyLifecycle;
    this.maximumTabs = maximumTabs;
    const initial = this.createTab(this.createEmptyPayload(), this.createEmptyLifecycle, false);
    this.tabs.push(initial);
    this.activeId = initial.id;
    this.snapshotValue = this.buildSnapshot();
  }

  get snapshot(): TabWorkspaceSnapshot<T> { return this.snapshotValue; }
  get activeTabId(): TabId { return this.activeId; }

  appendAndActivate(payload: T, lifecycle?: TabLifecycle<T>): TabId | null {
    if (this.tabs.length >= this.maximumTabs) return null;
    const tab = this.createTab(payload, lifecycle, false);
    this.tabs.push(tab);
    this.activeId = tab.id;
    this.record("append", tab.id);
    this.publish();
    return tab.id;
  }

  activate(id: TabId): boolean {
    if (!this.findTab(id) || this.activeId === id) return false;
    this.activeId = id;
    this.record("activate", id);
    this.publish();
    return true;
  }

  adjacentId(direction: 1 | -1): TabId {
    const activeIndex = this.findTabIndex(this.activeId);
    const nextIndex = (activeIndex + direction + this.tabs.length) % this.tabs.length;
    return this.tabs[nextIndex]!.id;
  }

  stageAdoption(payload: T, lifecycle?: TabLifecycle<T>): TabId | null {
    if (this.tabs.length >= this.maximumTabs) return null;
    const tab = this.createTab(payload, lifecycle, true, this.activeId);
    this.tabs.push(tab);
    this.activeId = tab.id;
    this.record("stage", tab.id);
    this.publish();
    return tab.id;
  }

  commitAdoption(id: TabId): boolean {
    const tab = this.findTab(id);
    if (!tab || !tab.staged) return false;
    tab.staged = false;
    this.record("commit", id);
    this.publish();
    return true;
  }

  rollbackAdoption(id: TabId): boolean {
    const index = this.findTabIndex(id);
    const tab = index < 0 ? undefined : this.tabs[index];
    if (!tab?.staged) return false;
    this.tabs.splice(index, 1);
    this.dispose(tab);
    this.activeId = this.selectAfterRemoval(index, tab.previousActiveId);
    this.record("rollback", id);
    this.publish();
    return true;
  }

  /** Closes a tab and activates its right neighbor, then its left neighbor. */
  close(id: TabId): boolean {
    const index = this.findTabIndex(id);
    const tab = index < 0 ? undefined : this.tabs[index];
    if (!tab) return false;
    this.tabs.splice(index, 1);
    this.dispose(tab);
    if (this.activeId === id) this.activeId = this.selectAfterRemoval(index);
    else if (this.tabs.length === 0) this.activeId = this.ensureEmptyTab().id;
    this.record("close", id);
    this.publish();
    return true;
  }

  getPayload(id: TabId): T | undefined { return this.findTab(id)?.payload; }

  setPayload(id: TabId, payload: T): boolean {
    const tab = this.findTab(id);
    if (!tab) return false;
    tab.payload = payload;
    this.publish();
    return true;
  }

  private createTab(payload: T, lifecycle: TabLifecycle<T> | undefined, staged: boolean, previousActiveId?: TabId): TabRecord<T> {
    const id = this.nextId as TabId;
    this.nextId += 1;
    const tab: TabRecord<T> = { id, payload, staged, disposed: false };
    if (lifecycle !== undefined) tab.lifecycle = lifecycle;
    if (previousActiveId !== undefined) tab.previousActiveId = previousActiveId;
    return tab;
  }

  private selectAfterRemoval(removedIndex: number, preferredId?: TabId): TabId {
    if (preferredId !== undefined && this.findTab(preferredId)) return preferredId;
    const successor = this.tabs[removedIndex] ?? this.tabs[removedIndex - 1];
    return successor ? successor.id : this.ensureEmptyTab().id;
  }

  private ensureEmptyTab(): TabRecord<T> {
    const empty = this.createTab(this.createEmptyPayload(), this.createEmptyLifecycle, false);
    this.tabs.push(empty);
    return empty;
  }

  private findTab(id: TabId): TabRecord<T> | undefined { return this.tabs.find((tab) => tab.id === id); }
  private findTabIndex(id: TabId): number { return this.tabs.findIndex((tab) => tab.id === id); }

  private dispose(tab: TabRecord<T>): void {
    if (tab.disposed) return;
    tab.disposed = true;
    tab.lifecycle?.dispose(tab.payload);
  }

  private record(kind: TabHistoryKind, tabId: TabId): void {
    this.historyEntries.push(Object.freeze({ kind, tabId }));
    if (this.historyEntries.length > HISTORY_LIMIT) this.historyEntries.shift();
  }

  private publish(): void { this.snapshotValue = this.buildSnapshot(); }

  private buildSnapshot(): TabWorkspaceSnapshot<T> {
    return Object.freeze({
      tabs: Object.freeze(this.tabs.map((tab) => Object.freeze({ id: tab.id, payload: tab.payload, staged: tab.staged }))),
      activeTabId: this.activeId,
      history: Object.freeze([...this.historyEntries]),
    });
  }
}
