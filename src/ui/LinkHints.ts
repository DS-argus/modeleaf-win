import type {
  PdfLinkActivationResult,
  PdfVisibleLinkCandidate,
  PdfVisibleLinkSnapshot,
} from "../pdf/PdfContentController";

/** The stable, home-row-first alphabet used by the shell link-hint overlay. */
export const LINK_HINT_ALPHABET = "fjdkslaghrueiwoncmpvtbyzxq";
export const DEFAULT_LINK_HINT_MAX_CANDIDATES = 256;

export type LinkHintFilterResult =
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "unique"; readonly index: number };

/** Generates equal-length, prefix-free labels in the pinned macOS order. */
export function generateLinkHintLabels(count: number, alphabet = LINK_HINT_ALPHABET): readonly string[] {
  if (!Number.isSafeInteger(count) || count <= 0) return [];
  const symbols = Array.from(alphabet);
  if (symbols.length < 2 || new Set(symbols).size !== symbols.length) throw new Error("LINK_HINT_ALPHABET_INVALID");
  const base = symbols.length;
  let length = 1;
  let capacity = base;
  while (capacity < count) {
    if (capacity > Number.MAX_SAFE_INTEGER / base) throw new Error("LINK_HINT_CAPACITY_OVERFLOW");
    capacity *= base;
    length += 1;
  }
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    let value = index;
    const characters: string[] = [];
    for (let position = 0; position < length; position += 1) {
      characters.push(symbols[value % base]!);
      value = Math.floor(value / base);
    }
    return characters.reverse().join("");
  }));
}

/** Returns candidate indices whose labels begin with the typed prefix. */
export function linkHintCandidates(labels: readonly string[], typed: string): readonly number[] {
  const query = typed.toLocaleLowerCase();
  if (query.length === 0) return Object.freeze(labels.map((_, index) => index));
  return Object.freeze(labels.flatMap((label, index) => label.toLocaleLowerCase().startsWith(query) ? [index] : []));
}

/** Classifies the typed prefix without mutating the candidate set. */
export function filterLinkHints(labels: readonly string[], typed: string): LinkHintFilterResult {
  const matches = linkHintCandidates(labels, typed);
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "unique", index: matches[0]! };
  return { kind: "ambiguous" };
}

export interface LinkHintAuthority {
  readonly visibleLinkSnapshot: PdfVisibleLinkSnapshot;
  activateVisibleLink(
    snapshot: PdfVisibleLinkSnapshot,
    selectionId: string,
    confirmExternal?: boolean,
  ): Promise<PdfLinkActivationResult>;
  readonly cancelVisibleLinkActivation: () => void;
}

export interface LinkHintHostContext {
  readonly authority: LinkHintAuthority;
  readonly host: HTMLElement;
}

export interface LinkHintKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  preventDefault(): void;
}

export interface LinkHintsOptions {
  readonly getContext: () => LinkHintHostContext | undefined;
  readonly onFeedback?: (message: string) => void;
  readonly maxCandidates?: number;
}

interface SelectedLinkHint {
  readonly candidate: PdfVisibleLinkCandidate;
  readonly index: number;
}
interface ActiveLinkHints {
  readonly context: LinkHintHostContext;
  readonly snapshot: PdfVisibleLinkSnapshot;
  readonly candidates: readonly PdfVisibleLinkCandidate[];
  readonly labels: readonly string[];
  readonly overlay: HTMLElement;
  typedPrefix: string;
  selected?: SelectedLinkHint | undefined;
  operation: number;
}

const isFiniteRect = (candidate: PdfVisibleLinkCandidate): boolean => {
  const rect = candidate.rect;
  return Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0;
};

const safeDisplayText = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�");
const lowerLetter = (key: string): string | undefined => {
  const value = key.toLocaleLowerCase();
  return value.length === 1 && /^[a-z]$/u.test(value) ? value : undefined;
};

/**
 * Transient, pointer-transparent shell overlay for keyboard PDF-link selection.
 * Candidate identities, rather than array positions, are retained through every
 * activation so an authority update can only produce a stale/rejected result.
 */
export class LinkHints {
  private activeState: ActiveLinkHints | undefined;
  private disposed = false;
  private pendingAuthority: LinkHintAuthority | undefined;
  private pendingEpoch = 0;
  private readonly maxCandidates: number;

  public constructor(private readonly options: LinkHintsOptions) {
    const requested = options.maxCandidates ?? DEFAULT_LINK_HINT_MAX_CANDIDATES;
    this.maxCandidates = Number.isSafeInteger(requested)
      ? Math.max(1, Math.min(DEFAULT_LINK_HINT_MAX_CANDIDATES, requested))
      : DEFAULT_LINK_HINT_MAX_CANDIDATES;
  }

  public get isPresenting(): boolean { return this.activeState !== undefined; }
  public get currentPrefix(): string { return this.activeState?.typedPrefix ?? ""; }
  public get visibleLabels(): readonly string[] { return this.activeState?.labels ?? []; }


  public show(): boolean {
    if (this.disposed) return false;
    this.cancel();
    const context = this.options.getContext();
    if (context === undefined) return false;
    let snapshot: PdfVisibleLinkSnapshot;
    try {
      snapshot = context.authority.visibleLinkSnapshot;
    } catch {
      this.feedback("PDF links are unavailable.");
      return false;
    }
    const candidates = snapshot.candidates
      .filter((candidate) => (candidate.kind === "internal" || candidate.kind === "external") && isFiniteRect(candidate))
      .slice(0, this.maxCandidates);
    if (candidates.length === 0) {
      this.feedback("No PDF links visible.");
      return false;
    }
    const overlay = document.createElement("div");
    overlay.className = "link-hints-overlay";
    overlay.dataset.linkHints = "overlay";
    overlay.setAttribute("aria-label", "PDF link hints");
    overlay.setAttribute("aria-live", "polite");
    overlay.setAttribute("role", "status");
    document.body.append(overlay);
    this.activeState = {
      context,
      snapshot,
      candidates: Object.freeze(candidates),
      labels: generateLinkHintLabels(candidates.length),
      overlay,
      typedPrefix: "",
      operation: 0,
    };
    this.render();
    return true;
  }

  /** Removes labels without invalidating the authority; used immediately before activation. */
  public dismiss(): void {
    const state = this.activeState;
    this.activeState = undefined;
    if (state !== undefined) state.overlay.remove();
  }

  /** Cancels labels and invalidates the authority so a shifted index cannot be reused. */
  public cancel(): void {
    const state = this.activeState;
    const authority = this.pendingAuthority ?? state?.context.authority ?? this.options.getContext()?.authority;
    this.pendingEpoch += 1;
    this.pendingAuthority = undefined;
    authority?.cancelVisibleLinkActivation();
    if (state !== undefined) state.operation += 1;
    this.dismiss();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  /** Routes key input only while the hint overlay owns the reader surface. */
  public handleKeyDown(event: LinkHintKeyEvent): boolean {
    const state = this.activeState;
    if (state === undefined) {
      if (this.pendingAuthority === undefined) return false;
      if (event.isComposing || event.keyCode === 229 || event.repeat) return true;
      event.preventDefault();
      if (event.key === "Escape" || event.key === "Tab") this.cancel();
      return true;
    }
    if (event.isComposing || event.keyCode === 229) return false;
    if (event.repeat) return true;
    if (!this.isAuthorityCurrent(state)) {
      this.dismiss();
      return true;
    }
    event.preventDefault();
    if (event.key === "Escape") {
      this.cancel();
      return true;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return true;
    if (event.key === "Tab") {
      this.cancel();
      return true;
    }
    if (event.key === "Backspace") {
      state.operation += 1;
      this.pendingEpoch += 1;
      this.pendingAuthority = undefined;
      if (state.typedPrefix.length > 0) state.typedPrefix = Array.from(state.typedPrefix).slice(0, -1).join("");
      state.selected = undefined;
      this.render();
      return true;
    }
    if (event.key === "Enter") {
      const selected = state.selected;
      if (selected === undefined) {
        this.feedback("Select a PDF link hint first.");
        return true;
      }
      this.confirmExternal(state, selected);
      return true;
    }
    const character = lowerLetter(event.key);
    if (character === undefined) {
      this.feedback("Type a PDF link hint.");
      return true;
    }
    const typed = `${state.typedPrefix}${character}`;
    const result = filterLinkHints(state.labels, typed);
    if (result.kind === "none") {
      this.feedback("No matching PDF link hint.");
      return true;
    }
    state.typedPrefix = typed;
    state.selected = undefined;
    if (result.kind === "ambiguous") {
      this.render();
      return true;
    }
    const candidate = state.candidates[result.index]!;
    if (candidate.kind === "external") {
      state.selected = { candidate, index: result.index };
      this.render();
      const operation = ++state.operation;
      const epoch = ++this.pendingEpoch;
      this.pendingAuthority = state.context.authority;
      void state.context.authority.activateVisibleLink(state.snapshot, candidate.selectionId, false).then((activation) => {
        if (this.activeState !== state || state.operation !== operation || this.pendingEpoch !== epoch) return;
        this.pendingAuthority = undefined;
        if (activation.kind === "confirmation-required") {
          const nextCandidate: PdfVisibleLinkCandidate = activation.url === candidate.url
            ? candidate
            : { ...candidate, url: activation.url };
          state.selected = { candidate: nextCandidate, index: result.index };
          this.render();
          return;
        }
        state.selected = undefined;
        this.dismiss();
        if (activation.kind !== "activated" && activation.kind !== "failed" && activation.kind !== "unsupported") this.feedback("That PDF link is no longer available.");
      }, () => {
        if (this.activeState !== state || state.operation !== operation || this.pendingEpoch !== epoch) return;
        this.pendingAuthority = undefined;
        state.selected = undefined;
        this.dismiss();
        this.feedback("That PDF link is no longer available.");
      });
      return true;
    }
    const snapshot = state.snapshot;
    const selectionId = candidate.selectionId;
    const epoch = ++this.pendingEpoch;
    this.pendingAuthority = state.context.authority;
    this.dismiss();
    void state.context.authority.activateVisibleLink(snapshot, selectionId, false).then((activation) => {
      if (this.pendingEpoch !== epoch) return;
      this.pendingAuthority = undefined;
      if (activation.kind !== "activated" && activation.kind !== "same-location" && activation.kind !== "failed" && activation.kind !== "unsupported") this.feedback("That PDF link is no longer available.");
    }, () => {
      if (this.pendingEpoch !== epoch) return;
      this.pendingAuthority = undefined;
      this.feedback("That PDF link could not be opened.");
    });
    return true;
  }

  private confirmExternal(state: ActiveLinkHints, selected: SelectedLinkHint): void {
    const snapshot = state.snapshot;
    const selectionId = selected.candidate.selectionId;
    const epoch = ++this.pendingEpoch;
    this.pendingAuthority = state.context.authority;
    this.dismiss();
    void state.context.authority.activateVisibleLink(snapshot, selectionId, true).then((activation) => {
      if (this.pendingEpoch !== epoch) return;
      this.pendingAuthority = undefined;
      if (activation.kind !== "activated" && activation.kind !== "failed" && activation.kind !== "unsupported") this.feedback("That PDF link is no longer available.");
    }, () => {
      if (this.pendingEpoch !== epoch) return;
      this.pendingAuthority = undefined;
      this.feedback("That PDF link could not be opened.");
    });
  }
  private isAuthorityCurrent(state: ActiveLinkHints): boolean {
    const context = this.options.getContext();
    if (context === undefined || context.host !== state.context.host || context.authority !== state.context.authority) return false;
    try {
      const current = context.authority.visibleLinkSnapshot;
      return current.revision === state.snapshot.revision
        && current.generation === state.snapshot.generation
        && current.scrollLeft === state.snapshot.scrollLeft
        && current.scrollTop === state.snapshot.scrollTop
        && current.viewport.width === state.snapshot.viewport.width
        && current.viewport.height === state.snapshot.viewport.height;
    } catch {
      return false;
    }
  }

  private feedback(message: string): void { this.options.onFeedback?.(message); }

  private render(): void {
    const state = this.activeState;
    if (state === undefined) return;
    const matches = new Set(linkHintCandidates(state.labels, state.typedPrefix));
    const host = state.context.host;
    const scrollLeft = 0;
    const scrollTop = 0;
    const visibleWidth = host.clientWidth > 0 ? host.clientWidth : Math.max(0, state.snapshot.viewport.width);
    const visibleHeight = host.clientHeight > 0 ? host.clientHeight : Math.max(0, state.snapshot.viewport.height);
    const bounds = host.getBoundingClientRect();
    state.overlay.style.left = `${bounds.left + host.clientLeft}px`;
    state.overlay.style.top = `${bounds.top + host.clientTop}px`;
    state.overlay.style.width = `${visibleWidth}px`;
    state.overlay.style.height = `${visibleHeight}px`;
    const children: HTMLElement[] = [];
    const labelPlacements: Array<{ readonly element: HTMLElement; readonly candidate: PdfVisibleLinkCandidate }> = [];
    for (let index = 0; index < state.candidates.length; index += 1) {
      const candidate = state.candidates[index]!;
      const label = state.labels[index]!;
      const badge = document.createElement("span");
      badge.className = "link-hints-label";
      badge.dataset.linkHintLabel = label;
      badge.dataset.linkHintCandidate = candidate.selectionId;
      badge.dataset.match = String(matches.has(index));
      badge.textContent = label.toUpperCase();
      badge.style.left = `${candidate.rect.x + scrollLeft}px`;
      badge.style.top = `${candidate.rect.y + scrollTop}px`;
      children.push(badge);
      labelPlacements.push({ element: badge, candidate });
    }
    let prompt: HTMLElement | undefined;
    if (state.selected !== undefined) {
      prompt = document.createElement("div");
      prompt.className = "link-hints-confirmation";
      prompt.dataset.linkHintsConfirmation = "url";
      prompt.setAttribute("role", "status");
      prompt.setAttribute("aria-live", "polite");
      const url = document.createElement("span");
      url.className = "link-hints-confirmation-url";
      url.style.maxHeight = `${Math.max(0, Math.min(128, visibleHeight - 48))}px`;
      url.dataset.linkHintsConfirmationUrl = "true";
      url.textContent = safeDisplayText(state.selected.candidate.url ?? "External link");
      url.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
      const actions = document.createElement("span");
      actions.className = "link-hints-confirmation-actions";
      actions.textContent = "Enter open · Esc cancel";
      prompt.append(url, actions);
      children.push(prompt);
    }
    state.overlay.replaceChildren(...children);
    const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));
    const minX = scrollLeft + 4;
    const minY = scrollTop + 4;
    const maxX = Math.max(minX, scrollLeft + visibleWidth - 4);
    const maxY = Math.max(minY, scrollTop + visibleHeight - 4);
    for (const placement of labelPlacements) {
      const width = placement.element.offsetWidth > 0 ? placement.element.offsetWidth : 32;
      const height = placement.element.offsetHeight > 0 ? placement.element.offsetHeight : 18;
      const left = clamp(placement.candidate.rect.x + scrollLeft - 1, minX, Math.max(minX, maxX - width));
      const top = clamp(placement.candidate.rect.y + scrollTop - 1, minY, Math.max(minY, maxY - height));
      placement.element.style.left = `${left}px`;
      placement.element.style.top = `${top}px`;
    }
    if (prompt !== undefined && state.selected !== undefined) {
      const width = prompt.offsetWidth > 0 ? prompt.offsetWidth : Math.min(420, Math.max(80, visibleWidth - 16));
      const height = prompt.offsetHeight > 0 ? prompt.offsetHeight : 48;
      const rect = state.selected.candidate.rect;
      const anchorX = rect.x + scrollLeft + 8;
      const anchorY = rect.y + scrollTop;
      const left = clamp(anchorX, minX, Math.max(minX, maxX - width));
      const below = anchorY + rect.height + 8;
      const above = anchorY - height - 8;
      const top = clamp(below + height > maxY ? above : below, minY, Math.max(minY, maxY - height));
      prompt.style.left = `${left}px`;
      prompt.style.top = `${top}px`;
    }
  }
}

