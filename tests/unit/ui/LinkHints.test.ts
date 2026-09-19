// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateProductConfig } from "../../../src/domain/config/ConfigValidator";
import { createRootKeyboardRouter, type RootKeyboardContext } from "../../../src/platform/RootKeyboardRouter";
import {
  LINK_HINT_ALPHABET,
  LinkHints,
  filterLinkHints,
  generateLinkHintLabels,
  linkHintCandidates,
  type LinkHintAuthority,
  type LinkHintKeyEvent,
} from "../../../src/ui/LinkHints";
import type {
  PdfLinkActivationResult,
  PdfVisibleLinkCandidate,
  PdfVisibleLinkSnapshot,
} from "../../../src/pdf/PdfContentController";

const viewport = Object.freeze({ x: 0, y: 0, width: 240, height: 160 });

function candidate(
  selectionId: string,
  kind: PdfVisibleLinkCandidate["kind"] = "external",
  overrides: Partial<PdfVisibleLinkCandidate> = {},
): PdfVisibleLinkCandidate {
  return Object.freeze({
    selectionId,
    pageNumber: 1,
    kind,
    rect: Object.freeze({ x: 24, y: 32, width: 12, height: 8 }),
    ...(kind === "external" ? { url: `https://example.test/${selectionId}` } : {}),
    ...overrides,
  });
}

function snapshot(candidates: readonly PdfVisibleLinkCandidate[], revision = 1): PdfVisibleLinkSnapshot {
  return Object.freeze({
    revision,
    generation: 7,
    viewport,
    scrollLeft: 0,
    scrollTop: 0,
    truncated: false,
    candidates: Object.freeze(candidates),
  });
}

function keyEvent(key: string, overrides: Partial<LinkHintKeyEvent> = {}) {
  let prevented = false;
  const event: LinkHintKeyEvent = {
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    preventDefault: () => { prevented = true; },
    ...overrides,
  };
  return { event, prevented: () => prevented };
}

function subject(initial: PdfVisibleLinkSnapshot) {
  let current = initial;
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: 600 },
    clientHeight: { configurable: true, value: 400 },
  });
  const feedback = vi.fn<(message: string) => void>();
  const cancelVisibleLinkActivation = vi.fn();
  const activateVisibleLink = vi.fn<LinkHintAuthority["activateVisibleLink"]>(async (captured, selectionId, confirmExternal = false): Promise<PdfLinkActivationResult> => {
    const selected = captured.candidates.find((entry) => entry.selectionId === selectionId);
    if (selected?.kind === "external" && !confirmExternal) return { kind: "confirmation-required", url: selected.url! };
    return { kind: "activated", link: selected?.kind ?? "internal" };
  });
  const authority: LinkHintAuthority = {
    get visibleLinkSnapshot() { return current; },
    activateVisibleLink,
    cancelVisibleLinkActivation,
  };
  const hints = new LinkHints({
    getContext: () => ({ authority, host }),
    onFeedback: feedback,
  });
  return {
    hints,
    host,
    authority,
    activateVisibleLink,
    cancelVisibleLinkActivation,
    feedback,
    setSnapshot: (next: PdfVisibleLinkSnapshot): void => { current = next; },
  };
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("LinkHints", () => {
  afterEach(() => document.body.replaceChildren());
  it("keeps a zoomed and scrolled host outside the hint overlay layout", () => {
    const h = subject(snapshot(Array.from({ length: 62 }, (_, index) => candidate(`link-${index}`))));
    h.host.scrollLeft = 5.384615;
    h.host.scrollTop = 26480.7695;
    h.host.getBoundingClientRect = () => new DOMRect(10, 63, 976, 1037);
    h.setSnapshot(Object.freeze({ ...h.authority.visibleLinkSnapshot, scrollLeft: h.host.scrollLeft, scrollTop: h.host.scrollTop }));
    expect(h.hints.show()).toBe(true);
    const overlay = document.querySelector<HTMLElement>(".link-hints-overlay")!;
    expect(overlay.parentElement).toBe(document.body);
    expect(h.host.contains(overlay)).toBe(false);
    expect(overlay.style.left).toBe("10px");
    expect(overlay.style.top).toBe("63px");
    expect(overlay.style.width).toBe("600px");
    expect(overlay.style.height).toBe("400px");
    h.hints.handleKeyDown(keyEvent("f").event);
    expect(h.hints.isPresenting).toBe(true);
    expect(h.hints.currentPrefix).toBe("f");
    h.hints.dispose();
    expect(document.querySelector(".link-hints-overlay")).toBeNull();
  });
  it("generates stable labels and classifies prefixes without mutating candidates", () => {
    expect(LINK_HINT_ALPHABET.startsWith("fjdksla")).toBe(true);
    expect(generateLinkHintLabels(4)).toEqual(["f", "j", "d", "k"]);
    const labels = generateLinkHintLabels(28);
    expect(labels).toHaveLength(28);
    expect(new Set(labels).size).toBe(28);
    expect(labels.every((label) => label.length === 2)).toBe(true);
    expect(linkHintCandidates(labels, "f")).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    expect(filterLinkHints(["ff", "fj"], "f")).toEqual({ kind: "ambiguous" });
    expect(filterLinkHints(["ff", "fj"], "fj")).toEqual({ kind: "unique", index: 1 });
    expect(filterLinkHints(["ff"], "z")).toEqual({ kind: "none" });
  });

  it("renders labels, narrows an ambiguous prefix, and handles Backspace", () => {
    const entries = Array.from({ length: 27 }, (_, index) => candidate(`link-${index}`));
    const h = subject(snapshot(entries));
    expect(h.hints.show()).toBe(true);
    expect(h.hints.visibleLabels).toHaveLength(27);
    expect(document.body.querySelectorAll("[data-link-hint-label]")).toHaveLength(27);

    const first = keyEvent("f");
    expect(h.hints.handleKeyDown(first.event)).toBe(true);
    expect(first.prevented()).toBe(true);
    expect(h.hints.currentPrefix).toBe("f");
    expect(document.body.querySelectorAll('[data-match="true"]')).toHaveLength(26);

    const backspace = keyEvent("Backspace");
    expect(h.hints.handleKeyDown(backspace.event)).toBe(true);
    expect(backspace.prevented()).toBe(true);
    expect(h.hints.currentPrefix).toBe("");
    expect(document.body.querySelectorAll('[data-match="true"]')).toHaveLength(27);
    expect(document.querySelector('[data-link-hint-label="ff"] .link-hints-entered')?.textContent).toBe("");
    expect(document.querySelector('[data-link-hint-label="ff"] .link-hints-remaining')?.textContent).toBe("FF");
  });

  it("reports invalid input and ignores repeated keys without changing the prefix", () => {
    const h = subject(snapshot([candidate("one"), candidate("two")]));
    expect(h.hints.show()).toBe(true);

    const invalid = keyEvent("?");
    expect(h.hints.handleKeyDown(invalid.event)).toBe(true);
    expect(invalid.prevented()).toBe(true);
    expect(h.hints.currentPrefix).toBe("");
    expect(h.feedback).toHaveBeenCalledWith("Type a PDF link hint.");

    const repeated = keyEvent("f", { repeat: true });
    expect(h.hints.handleKeyDown(repeated.event)).toBe(true);
    expect(repeated.prevented()).toBe(false);
    expect(h.hints.currentPrefix).toBe("");
    expect(h.activateVisibleLink).not.toHaveBeenCalled();
  });

  it("anchors a safe, complete long-URL confirmation and confirms exactly once with Enter", async () => {
    const url = `https://example.test/${"segment/".repeat(100)}<unsafe>`;
    const link = candidate("external", "external", { rect: Object.freeze({ x: 30, y: 40, width: 12, height: 10 }), url });
    const h = subject(snapshot([link]));
    expect(h.hints.show()).toBe(true);

    const label = keyEvent("f");
    expect(h.hints.handleKeyDown(label.event)).toBe(true);
    await settlePromises();
    const prompt = document.body.querySelector<HTMLElement>('[data-link-hints-confirmation="url"]');
    const urlNode = document.body.querySelector<HTMLElement>('[data-link-hints-confirmation-url]');
    expect(prompt).not.toBeNull();
    expect(urlNode?.textContent).toBe(url);
    expect(urlNode?.innerHTML).not.toContain("<unsafe>");
    expect(prompt?.style.left).toBe("38px");
    expect(prompt?.style.top).toBe("58px");

    const enter = keyEvent("Enter");
    expect(h.hints.handleKeyDown(enter.event)).toBe(true);
    await settlePromises();
    expect(h.activateVisibleLink).toHaveBeenCalledTimes(2);
    expect(h.hints.show()).toBe(true);
    const freshLabel = keyEvent("f");
    expect(h.hints.handleKeyDown(freshLabel.event)).toBe(true);
    await settlePromises();
    expect(h.activateVisibleLink).toHaveBeenCalledTimes(3);
    expect(h.hints.isPresenting).toBe(true);
    h.hints.cancel();
    expect(h.activateVisibleLink.mock.calls[0]?.[2]).toBe(false);
    expect(h.activateVisibleLink.mock.calls[1]?.[2]).toBe(true);
    expect(h.hints.isPresenting).toBe(false);
    const secondEnter = keyEvent("Enter");
    expect(h.hints.handleKeyDown(secondEnter.event)).toBe(false);
    expect(h.activateVisibleLink).toHaveBeenCalledTimes(3);
  });

  it("cancels an external confirmation on Escape and reports an empty candidate set", () => {
    const h = subject(snapshot([candidate("external")]));
    expect(h.hints.show()).toBe(true);
    const escape = keyEvent("Escape");
    expect(h.hints.handleKeyDown(escape.event)).toBe(true);
    expect(escape.prevented()).toBe(true);
    expect(h.hints.isPresenting).toBe(false);
    expect(h.cancelVisibleLinkActivation).toHaveBeenCalledTimes(2);
    expect(h.activateVisibleLink).not.toHaveBeenCalled();

    const noLinks = subject(snapshot([]));
    expect(noLinks.hints.show()).toBe(false);
    expect(noLinks.feedback).toHaveBeenCalledWith("No PDF links visible.");
    expect(noLinks.host.querySelector('[data-link-hints="overlay"]')).toBeNull();
  });

  it("cancels the active presentation and invalidates the authority explicitly", () => {
    const h = subject(snapshot([candidate("external")]));
    expect(h.hints.show()).toBe(true);
    h.hints.cancel();
    expect(h.hints.isPresenting).toBe(false);
    expect(document.body.querySelector('[data-link-hints="overlay"]')).toBeNull();
    expect(h.cancelVisibleLinkActivation).toHaveBeenCalledTimes(2);
  });

  it("keeps a composed root-owned 27-link overlay through prefix, invalid, and Backspace input", async () => {
    const entries = Array.from({ length: 27 }, (_, index) => candidate(`link-${index}`, index === 0 ? "internal" : "external"));
    const h = subject(snapshot(entries));
    const validated = validateProductConfig({});
    if (!validated.ok) throw new Error("built-in config invalid");
    const runtime = {
      hasDocument: true, canOpenDocument: true, canCreateSession: true, canCreateWindow: true,
      tabCount: 1, modalOpen: false, updateAvailable: false, configExists: false, searchActive: false,
      canHistoryBack: false, canHistoryForward: false,
    };
    const context: RootKeyboardContext = {
      windowId: "window-a", routeRevision: "route-a", generation: 7, inputContext: "navigation", runtime,
    };
    const dispatched: string[] = [];
    let router: ReturnType<typeof createRootKeyboardRouter>;
    router = createRootKeyboardRouter({
      config: validated.value,
      getContext: () => context,
      onDispatch: (actionId) => {
        dispatched.push(actionId);
        if (actionId === "links.hint") {
          router.cancelPending();
          expect(h.hints.show()).toBe(true);
        }
      },
      onPriorityKeyDown: (event) => h.hints.handleKeyDown(event),
      onPriorityCancel: () => h.hints.cancel(),
    });
    try {
      const open = keyEvent("f");
      expect(router.handleKeyDown(open.event)).toBe(true);
      expect(open.prevented()).toBe(true);
      expect(dispatched).toEqual(["links.hint"]);
      expect(h.hints.visibleLabels).toHaveLength(27);

      const invalid = keyEvent("?");
      expect(router.handleKeyDown(invalid.event)).toBe(true);
      expect(invalid.prevented()).toBe(true);
      expect(h.hints.currentPrefix).toBe("");
      expect(h.feedback).toHaveBeenLastCalledWith("Type a PDF link hint.");
      expect(dispatched).toEqual(["links.hint"]);

      const firstPrefix = keyEvent("f");
      expect(router.handleKeyDown(firstPrefix.event)).toBe(true);
      expect(firstPrefix.prevented()).toBe(true);
      expect(h.hints.currentPrefix).toBe("f");
      expect(document.body.querySelectorAll('[data-match="true"]')).toHaveLength(26);
      expect(document.querySelector('[data-link-hint-label="ff"] .link-hints-entered')?.textContent).toBe("F");
      expect(document.querySelector('[data-link-hint-label="ff"] .link-hints-remaining')?.textContent).toBe("F");
      expect(document.querySelector('[data-link-hint-label="jf"] .link-hints-entered')?.textContent).toBe("");
      expect(document.querySelector('[data-link-hint-label="jf"] .link-hints-remaining')?.textContent).toBe("JF");
      expect(dispatched).toEqual(["links.hint"]);

      const backspace = keyEvent("Backspace");
      expect(router.handleKeyDown(backspace.event)).toBe(true);
      expect(backspace.prevented()).toBe(true);
      expect(h.hints.currentPrefix).toBe("");
      expect(document.body.querySelectorAll('[data-match="true"]')).toHaveLength(27);

      const retryPrefix = keyEvent("f");
      const secondKey = keyEvent("f");
      expect(router.handleKeyDown(retryPrefix.event)).toBe(true);
      expect(router.handleKeyDown(secondKey.event)).toBe(true);
      expect(retryPrefix.prevented()).toBe(true);
      expect(secondKey.prevented()).toBe(true);
      await settlePromises();
      expect(h.activateVisibleLink).toHaveBeenCalledWith(expect.anything(), "link-0", false);
      expect(h.hints.isPresenting).toBe(false);
      expect(dispatched).toEqual(["links.hint"]);
    } finally {
      router.dispose();
    }
  });
});
