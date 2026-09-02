import { ACTION_IDS, getActionDescriptor, type ActionId, type InputContext } from "./ActionRegistry";
import { normalizeKeySequence } from "../input/KeyGrammar";

const raw: Record<ActionId, readonly string[]> = {
  "document.open":["<C-o>"], "document.close":["<C-w>"], "document.print":["<C-p>"], "app.quit":["<A-F4>"], "app.new":["<C-n>"],
  "palette.open":[":","<C-S-p>"], "help.show":["?"], "tab.next":["N"], "tab.previous":["P"],
  "tab.select.1":["<C-1>"], "tab.select.2":["<C-2>"], "tab.select.3":["<C-3>"], "tab.select.4":["<C-4>"], "tab.select.5":["<C-5>"], "tab.select.6":["<C-6>"], "tab.select.7":["<C-7>"], "tab.select.8":["<C-8>"], "tab.select.9":["<C-9>"],
  "scroll.left":["h","<Left>"], "scroll.down":["j","<Down>"], "scroll.up":["k","<Up>"], "scroll.right":["l","<Right>"], "scroll.largeDown":["d"], "scroll.largeUp":["u"],
  "toc.toggle":["t"], "toc.scrollDown":["J"], "toc.scrollUp":["K"], "page.next":["n"], "page.previous":["p"], "page.first":["gg"], "page.last":["G"], "page.prompt":["g"],
  "history.back":["<A-Left>"], "history.forward":["<A-Right>"], "prompt.commit":["<Enter>"], "prompt.cancel":["<Esc>"],
  "search.prompt":["/"], "search.next":["<Enter>"], "search.previous":["<S-Enter>"], "search.cancel":["<Esc>"],
  "view.zoomIn":["=","+"], "view.zoomOut":["-"], "view.zoomReset":[], "view.fitWidth":["w"], "view.fitPage":["F"], "view.rotateLeft":["["], "view.rotateRight":["]"],
  "link.hint":["f"], "config.reload":["<prefix>r"], "config.writeDefault":[], "config.resetDefault":[], "theme.picker":["T"], "indicator.picker":["I"], "update.show":["U"],
};

export const DEFAULT_BINDINGS: Readonly<Record<ActionId, readonly string[]>> = Object.freeze(
  Object.fromEntries(ACTION_IDS.map((id) => [id, Object.freeze([...raw[id]])])) as Record<ActionId, readonly string[]>,
);

export interface DefaultBindingCollision { readonly sequence: string; readonly left: ActionId; readonly right: ActionId; readonly context: InputContext }

export function defaultBindingCollisions(): readonly DefaultBindingCollision[] {
  const indexed: { id: ActionId; sequence: string; contexts: readonly InputContext[] }[] = [];
  for (const id of ACTION_IDS) {
    const descriptor = getActionDescriptor(id)!;
    const contexts = descriptor.availability.kind === "global"
      ? (["navigation", "pagePrompt", "searchPrompt", "searchResults"] as const)
      : descriptor.availability.contexts;
    for (const source of DEFAULT_BINDINGS[id]) {
      const sequence = normalizeKeySequence(source);
      if (sequence === undefined) throw new Error(`Invalid built-in binding ${id}:${source}`);
      indexed.push({ id, sequence, contexts });
    }
  }
  const collisions: DefaultBindingCollision[] = [];
  for (let left = 0; left < indexed.length; left += 1) for (let right = left + 1; right < indexed.length; right += 1) {
    const a = indexed[left]!; const b = indexed[right]!;
    if (a.sequence !== b.sequence) continue;
    for (const context of a.contexts) if (b.contexts.includes(context)) collisions.push(Object.freeze({ sequence: a.sequence, left: a.id, right: b.id, context }));
  }
  return Object.freeze(collisions);
}
