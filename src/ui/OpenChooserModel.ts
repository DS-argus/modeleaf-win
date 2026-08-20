import { filterRecentFiles, type RecentFile, type RecentSnapshot } from "../domain/recent/RecentFiles";

export type PreparedRecentState =
  | { readonly tag: "READY"; readonly snapshot: RecentSnapshot }
  | { readonly tag: "STATE_UNAVAILABLE"; readonly reason: string };
export interface OpenChooserModel {
  readonly generation: number;
  readonly prepared: PreparedRecentState;
  readonly query: string;
  readonly activeIndex: number;
  readonly diagnostic: string | undefined;
}
export type OpenChooserRow =
  | { readonly kind: "browse"; readonly label: "Browse..." }
  | { readonly kind: "recent"; readonly recentId: string; readonly displayName: string };

export function createOpenChooser(prepared: PreparedRecentState, generation = 1): OpenChooserModel {
  return Object.freeze({ generation, prepared, query: "", activeIndex: 0, diagnostic: undefined });
}
export function chooserRows(model: OpenChooserModel): readonly OpenChooserRow[] {
  const recents: readonly RecentFile[] = model.prepared.tag === "READY" ? model.prepared.snapshot.entries : [];
  return Object.freeze([
    Object.freeze({ kind: "browse" as const, label: "Browse..." as const }),
    ...filterRecentFiles(recents, model.query).map((entry) => Object.freeze({ kind: "recent" as const, recentId: entry.recentId, displayName: entry.displayName })),
  ]);
}
export function updateChooserQuery(model: OpenChooserModel, query: string): OpenChooserModel {
  const normalized = query.normalize("NFC");
  const hasMatch = model.prepared.tag === "READY" && filterRecentFiles(model.prepared.snapshot.entries, normalized).length > 0;
  return Object.freeze({ ...model, query: normalized, activeIndex: hasMatch ? 1 : 0, diagnostic: undefined });
}
export function moveChooserSelection(model: OpenChooserModel, delta: -1 | 1): OpenChooserModel {
  const count = chooserRows(model).length;
  return Object.freeze({ ...model, activeIndex: count === 0 ? 0 : (model.activeIndex + delta + count) % count });
}
export function selectChooserIndex(model: OpenChooserModel, index: number): OpenChooserModel {
  const maximum = chooserRows(model).length - 1;
  if (!Number.isSafeInteger(index) || index < 0 || index > maximum) return model;
  return Object.freeze({ ...model, activeIndex: index });
}
export function adoptChooserSnapshot(model: OpenChooserModel, generation: number, snapshot: RecentSnapshot, diagnostic?: string): OpenChooserModel {
  if (generation !== model.generation || (model.prepared.tag === "READY" && BigInt(snapshot.revision) < BigInt(model.prepared.snapshot.revision))) return model;
  const next: OpenChooserModel = Object.freeze({ ...model, prepared: Object.freeze({ tag: "READY" as const, snapshot }), diagnostic });
  return Object.freeze({ ...next, activeIndex: Math.min(next.activeIndex, chooserRows(next).length - 1) });
}
export function retainChooserFailure(model: OpenChooserModel, generation: number, diagnostic: string): OpenChooserModel {
  if (generation !== model.generation) return model;
  return Object.freeze({ ...model, diagnostic });
}
