declare const tabIdBrand: unique symbol;
export type TabId = number & { readonly [tabIdBrand]: "TabId" };

export interface Tab<T> { readonly id: TabId; readonly value: T }
export interface TabStoreSnapshot<T> { readonly tabs: readonly Tab<T>[]; readonly activeId?: TabId; readonly stagedId?: TabId }
export type TabStoreEffect<T> =
  | { readonly kind: "removed"; readonly tab: Tab<T> }
  | { readonly kind: "rolled-back"; readonly tab: Tab<T> };
export type TabStoreResult<T> =
  | { readonly ok: true; readonly snapshot: TabStoreSnapshot<T>; readonly effect?: TabStoreEffect<T> }
  | { readonly ok: false; readonly reason: "Tab not found" | "Adoption already staged" | "No adoption staged" };

export class TabStore<T> {
  private tabs: Tab<T>[] = [];
  private activeIdValue: TabId | undefined;
  private stagedTab: Tab<T> | undefined;
  private nextId = 1;

  public snapshot(): TabStoreSnapshot<T> {
    return Object.freeze({
      tabs: Object.freeze(this.tabs.map((tab) => Object.freeze({ ...tab }))),
      ...(this.activeIdValue === undefined ? {} : { activeId: this.activeIdValue }),
      ...(this.stagedTab === undefined ? {} : { stagedId: this.stagedTab.id }),
    });
  }

  public appendAndActivate(value: T): TabStoreResult<T> {
    const tab = Object.freeze({ id: this.nextId++ as TabId, value });
    this.tabs.push(tab);
    this.activeIdValue = tab.id;
    return { ok: true, snapshot: this.snapshot() };
  }

  public activate(id: TabId): TabStoreResult<T> {
    if (!this.has(id)) return { ok: false, reason: "Tab not found" };
    this.activeIdValue = id;
    return { ok: true, snapshot: this.snapshot() };
  }

  public next(): TabStoreResult<T> { return this.activateAdjacent(1); }
  public previous(): TabStoreResult<T> { return this.activateAdjacent(-1); }

  public close(id: TabId): TabStoreResult<T> {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return { ok: false, reason: "Tab not found" };
    const [removed] = this.tabs.splice(index, 1);
    if (this.activeIdValue === id) {
      this.activeIdValue = this.tabs[index]?.id ?? this.tabs[index - 1]?.id;
    }
    return { ok: true, snapshot: this.snapshot(), effect: Object.freeze({ kind: "removed", tab: removed! }) };
  }

  public stageAdoption(value: T): TabStoreResult<T> {
    if (this.stagedTab !== undefined) return { ok: false, reason: "Adoption already staged" };
    this.stagedTab = Object.freeze({ id: this.nextId++ as TabId, value });
    return { ok: true, snapshot: this.snapshot() };
  }

  public commitAdoption(): TabStoreResult<T> {
    const candidate = this.stagedTab;
    if (candidate === undefined) return { ok: false, reason: "No adoption staged" };
    this.tabs.push(candidate);
    this.activeIdValue = candidate.id;
    this.stagedTab = undefined;
    return { ok: true, snapshot: this.snapshot() };
  }

  public rollbackAdoption(): TabStoreResult<T> {
    const candidate = this.stagedTab;
    if (candidate === undefined) return { ok: false, reason: "No adoption staged" };
    this.stagedTab = undefined;
    return { ok: true, snapshot: this.snapshot(), effect: Object.freeze({ kind: "rolled-back", tab: candidate }) };
  }

  public get(id: TabId): T | undefined { return this.tabs.find((tab) => tab.id === id)?.value; }

  private activateAdjacent(direction: 1 | -1): TabStoreResult<T> {
    if (this.tabs.length === 0 || this.activeIdValue === undefined) return { ok: false, reason: "Tab not found" };
    const index = this.tabs.findIndex((tab) => tab.id === this.activeIdValue);
    const target = (index + direction + this.tabs.length) % this.tabs.length;
    this.activeIdValue = this.tabs[target]!.id;
    return { ok: true, snapshot: this.snapshot() };
  }
  private has(id: TabId): boolean { return this.tabs.some((tab) => tab.id === id); }
}
