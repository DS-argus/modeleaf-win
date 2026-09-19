// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
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
    expect(h.host.querySelectorAll("[data-link-hint-label]")).toHaveLength(27);

    const first = keyEvent("f");
    expect(h.hints.handleKeyDown(first.event)).toBe(true);
    expect(first.prevented()).toBe(true);
    expect(h.hints.currentPrefix).toBe("f");
    expect(h.host.querySelectorAll('[data-match="true"]')).toHaveLength(26);

    const backspace = keyEvent("Backspace");
    expect(h.hints.handleKeyDown(backspace.event)).toBe(true);
    expect(backspace.prevented()).toBe(true);
    expect(h.hints.currentPrefix).toBe("");
    expect(h.host.querySelectorAll('[data-match="true"]')).toHaveLength(27);
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
    const prompt = h.host.querySelector<HTMLElement>('[data-link-hints-confirmation="url"]');
    const urlNode = h.host.querySelector<HTMLElement>('[data-link-hints-confirmation-url]');
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
    expect(h.host.querySelector('[data-link-hints="overlay"]')).toBeNull();
    expect(h.cancelVisibleLinkActivation).toHaveBeenCalledTimes(2);
  });
});
