// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  AccessibilityController,
  focusRestoreTarget,
  readerAccessibilityName,
  safeDocumentBasename,
  tabAccessibilitySemantics,
  visualPageAccessibilityName,
} from "../../../src/ui/AccessibilityController";

function controller(generation = 0): {
  readonly polite: HTMLElement;
  readonly assertive: HTMLElement;
  readonly controller: AccessibilityController;
} {
  const polite = document.createElement("div");
  const assertive = document.createElement("div");
  return { polite, assertive, controller: new AccessibilityController({ target: { polite, assertive }, generation }) };
}

describe("AccessibilityController", () => {
  it("deduplicates identical polite and assertive messages", () => {
    const { controller: announcements, polite, assertive } = controller();
    announcements.announce({ kind: "palette", open: true });
    announcements.announce({ kind: "palette", open: true });
    announcements.announce({ kind: "error", error: "render-failed" });
    announcements.announce({ kind: "error", error: "render-failed" });

    expect(polite.textContent).toBe("Command palette opened.");
    expect(assertive.textContent).toBe("The page could not be rendered.");
    expect(polite.getAttribute("aria-live")).toBe("polite");
    expect(assertive.getAttribute("aria-live")).toBe("assertive");
    expect(assertive.getAttribute("aria-atomic")).toBe("true");
  });

  it("coalesces committed page and zoom updates into one polite message", () => {
    const { controller: announcements, polite } = controller(7);
    announcements.announce({ kind: "page", generation: 7, page: 4, pageCount: 12 });
    announcements.announce({ kind: "zoom", generation: 7, zoomPercent: 125 });
    announcements.flush();

    expect(polite.textContent).toBe("Page 4 of 12, zoom 125%.");
  });

  it("rejects stale document generations and drops their queued output", () => {
    const { controller: announcements, polite } = controller(2);
    expect(announcements.announce({ kind: "page", generation: 1, page: 1, pageCount: 9 })).toBe(false);
    expect(announcements.announce({ kind: "loading-complete", generation: 1, pageCount: 9 })).toBe(false);
    announcements.announce({ kind: "page", generation: 2, page: 2, pageCount: 9 });
    expect(announcements.setGeneration(3)).toBe(true);
    announcements.flush();

    expect(polite.textContent).toBe("");
  });
  it("accepts a lower document generation after activating a different tab", () => {
    const { controller: announcements, polite } = controller(5);
    expect(announcements.activateTab("tab-a", 5)).toBe(true);
    announcements.announce({ kind: "page", generation: 5, page: 5, pageCount: 9 });
    expect(announcements.activateTab("tab-b", 1)).toBe(true);
    expect(announcements.announce({ kind: "page", generation: 1, page: 1, pageCount: 3 })).toBe(true);
    announcements.flush();
    expect(polite.textContent).toBe("Page 1 of 3.");
  });

  it("allows only terminal safe error tags", () => {
    const { controller: announcements, assertive } = controller();
    expect(announcements.announce({ kind: "error", error: "document-locality-denied" })).toBe(true);
    expect(assertive.textContent).toBe("This document location is not supported.");
    expect(announcements.announce({ kind: "error", error: "C:\\Users\\Ada\\secret.pdf" as never })).toBe(false);
    expect(assertive.textContent).toBe("This document location is not supported.");
  });

  it("redacts prohibited document values from accessible names and announcements", () => {
    const { controller: announcements, polite } = controller();
    const prohibited = "https://user:password@example.test/private.pdf?query=한국어";
    const tab = tabAccessibilitySemantics({ basename: prohibited, ordinal: 1, total: 2, active: true });
    announcements.announce({ kind: "tab", active: 1, total: 2 });

    expect(safeDocumentBasename(prohibited)).toBe("PDF document");
    expect(tab.ariaLabel).toBe("PDF document, tab 1 of 2");
    expect(readerAccessibilityName(prohibited, 3)).toBe("PDF document reader, 3 pages");
    expect(visualPageAccessibilityName(2, 3)).toBe("PDF page 2 of 3");
    expect(polite.textContent).toBe("Tab 1 of 2.");
    expect(`${tab.ariaLabel} ${polite.textContent}`).not.toContain("password");
    expect(`${tab.ariaLabel} ${polite.textContent}`).not.toContain("한국어");
  });

  it("restores focus to a connected invoker, active tab, then reader", () => {
    const invoker = document.createElement("button");
    const tab = document.createElement("button");
    const reader = document.createElement("main");
    document.body.append(invoker, tab, reader);

    expect(focusRestoreTarget(invoker, tab, reader)).toBe(invoker);
    invoker.remove();
    expect(focusRestoreTarget(invoker, tab, reader)).toBe(tab);
    tab.remove();
    expect(focusRestoreTarget(invoker, tab, reader)).toBe(reader);
  });
});
