import { getActionDescriptor, type ActionId, type InputContext } from "../actions/ActionRegistry";
import { parseKeySequence, type CanonicalKeyToken } from "./KeyGrammar";

export const DEFAULT_PREFIX_TIMEOUT_MS = 400;
export interface SequenceBinding { readonly sequence: string; readonly actionId: ActionId; readonly contexts: readonly InputContext[] }
export interface SequenceDispatch {
  readonly actionId: ActionId;
  readonly transitionedContext?: InputContext;
  readonly replay?: { readonly token: string; readonly tokenClass: "decimalDigit"; readonly targetContext: "pagePrompt" };
}
export type SequenceResult =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly sequence: string; readonly deadline: number; readonly epoch: number }
  | { readonly kind: "dispatch"; readonly dispatch: SequenceDispatch }
  | { readonly kind: "invalid"; readonly reason: "no-binding" | "invalid-sequence" | "repeat-suppressed" | "stale-timeout" };

interface TrieNode { readonly children: Map<string, TrieNode>; readonly bindings: SequenceBinding[] }

export class KeySequenceTrie {
  private readonly root: TrieNode = { children: new Map(), bindings: [] };
  public constructor(bindings: readonly SequenceBinding[]) { for (const binding of bindings) this.insert(binding); }
  public child(node: TrieNode | undefined, token: string): TrieNode | undefined { return (node ?? this.root).children.get(token); }
  public start(): TrieNode { return this.root; }
  public binding(node: TrieNode | undefined, context: InputContext): SequenceBinding | undefined {
    return node?.bindings.find((binding) => binding.contexts.includes(context));
  }

  private insert(binding: SequenceBinding): void {
    const parsed = parseKeySequence(binding.sequence);
    if (!parsed.ok) throw new Error(`Invalid binding ${binding.sequence}: ${parsed.code}`);
    let node = this.root;
    for (const token of parsed.tokens.map(({ canonical }) => canonical)) {
      const child = node.children.get(token) ?? { children: new Map<string, TrieNode>(), bindings: [] };
      node.children.set(token, child);
      node = child;
    }
    if (node.bindings.some((candidate) => candidate.contexts.some((context) => binding.contexts.includes(context)))) {
      throw new Error(`Overlapping binding ${binding.sequence}`);
    }
    node.bindings.push(Object.freeze({ ...binding, contexts: Object.freeze([...binding.contexts]), sequence: parsed.canonical }));
  }
}

/** Pure clock-driven state machine. Callers pass monotonic timestamps; no timer/DOM ownership leaks into domain. */
export class KeySequenceEngine {
  private node: TrieNode | undefined;
  private buffer: string[] = [];
  private deadline: number | undefined;
  private epoch = 0;

  public constructor(private readonly trie: KeySequenceTrie, private readonly timeoutMilliseconds = DEFAULT_PREFIX_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 100 || timeoutMilliseconds > 2000) throw new Error("PREFIX_TIMEOUT_INVALID");
  }

  public state(): SequenceResult {
    return this.deadline === undefined ? { kind: "idle" } : { kind: "pending", sequence: this.buffer.join(""), deadline: this.deadline, epoch: this.epoch };
  }
  public reset(): void { this.node = undefined; this.buffer = []; this.deadline = undefined; this.epoch += 1; }

  public expire(context: InputContext, now: number, epoch = this.epoch): SequenceResult {
    if (epoch !== this.epoch) return { kind: "invalid", reason: "stale-timeout" };
    if (this.deadline === undefined || now < this.deadline) return this.state();
    const fallback = this.trie.binding(this.node, context);
    this.reset();
    return fallback === undefined ? { kind: "invalid", reason: "invalid-sequence" } : dispatch(fallback, false);
  }

  public advance(tokenSource: string, context: InputContext, now: number, eventIsRepeat = false): SequenceResult {
    if (this.deadline !== undefined && now >= this.deadline) return this.expire(context, now);
    if (eventIsRepeat && this.deadline !== undefined) return { kind: "invalid", reason: "repeat-suppressed" };
    const parsed = parseKeySequence(tokenSource);
    if (!parsed.ok || parsed.tokens.length !== 1) { this.reset(); return { kind: "invalid", reason: "invalid-sequence" }; }
    const token = parsed.tokens[0]!;
    const next = this.trie.child(this.node, token.canonical);
    if (next === undefined) {
      const hadPending = this.buffer.length > 0;
      const fallback = this.trie.binding(this.node, context);
      this.reset();
      if (fallback?.actionId === "page.prompt" && isDecimalReplay(token)) {
        return { kind: "dispatch", dispatch: Object.freeze({
          actionId: fallback.actionId,
          transitionedContext: "pagePrompt",
          replay: Object.freeze({ token: token.canonical, tokenClass: "decimalDigit", targetContext: "pagePrompt" }),
        }) };
      }
      return { kind: "invalid", reason: hadPending ? "invalid-sequence" : "no-binding" };
    }
    this.node = next;
    this.buffer.push(token.canonical);
    const binding = this.trie.binding(next, context);
    if (binding !== undefined && next.children.size === 0) {
      this.reset();
      return dispatch(binding, eventIsRepeat);
    }
    if (binding === undefined && next.children.size === 0) { this.reset(); return { kind: "invalid", reason: "no-binding" }; }
    if (eventIsRepeat) { this.reset(); return { kind: "invalid", reason: "repeat-suppressed" }; }
    this.deadline = now + this.timeoutMilliseconds;
    this.epoch += 1;
    return this.state();
  }
}

function dispatch(binding: SequenceBinding, eventIsRepeat: boolean): SequenceResult {
  const descriptor = getActionDescriptor(binding.actionId)!;
  if (eventIsRepeat && descriptor.repeatBehavior === "suppressed") return { kind: "invalid", reason: "repeat-suppressed" };
  return { kind: "dispatch", dispatch: Object.freeze({
    actionId: binding.actionId,
    ...(binding.actionId === "page.prompt" ? { transitionedContext: "pagePrompt" as const } : {}),
  }) };
}
function isDecimalReplay(token: CanonicalKeyToken): boolean {
  return token.modifiers.length === 0 && /^[0-9]$/u.test(token.key);
}
