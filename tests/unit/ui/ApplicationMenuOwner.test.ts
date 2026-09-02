// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindApplicationMenuOwner } from "../../../src/ui/shell/ApplicationMenuOwner";

const styles = readFileSync(join(process.cwd(), "src/styles/app.css"), "utf8");

afterEach(() => document.body.replaceChildren());
function setup() {
  const menu = document.createElement("nav");
  const outside = document.createElement("button");
  outside.textContent = "Outside";
  document.body.append(menu, outside);
  const command = vi.fn<(id: string) => void>();
  const binding = bindApplicationMenuOwner({ menu, onCommand: command });
  const add = (id: string) => {
    const details = document.createElement("details");
    const summary = document.createElement("summary"); summary.textContent = id;
    const button = document.createElement("button"); button.dataset.menuCommand = id;
    details.append(summary, button); menu.append(details); return { details, summary, button };
  };
  return { menu, outside, command, binding, add };
}
function open(details: HTMLDetailsElement): void { details.open = true; details.dispatchEvent(new Event("toggle", { bubbles: true })); }
function escape(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
}

describe("ApplicationMenuOwner", () => {
  it("keeps one direct details menu open", () => {
    const { binding, add } = setup(); const first = add("first"); const second = add("second");
    open(first.details); open(second.details);
    expect(first.details.open).toBe(false); expect(second.details.open).toBe(true); binding.dispose();
  });
  it("keeps the native direct details and summary disclosure contract", () => {
    const { binding, menu, add } = setup(); const item = add("File");
    expect(menu.querySelectorAll(":scope > details")).toHaveLength(1);
    expect(item.details.querySelector(":scope > summary")).toBe(item.summary);
    binding.dispose();
  });
  it("closes before command activation through a stable delegated listener", () => {
    const { binding, command, add } = setup(); const item = add("document.open"); open(item.details);
    item.button.click();
    expect(item.details.open).toBe(false); expect(command).toHaveBeenCalledWith("document.open"); binding.dispose();
  });
  it("owns Escape in window capture before later page routing, prevents it, and restores summary focus", () => {
    const { binding, add } = setup(); const item = add("File"); const pageRouter = vi.fn();
    window.addEventListener("keydown", pageRouter, { capture: true }); open(item.details);
    const event = escape();
    expect(event.defaultPrevented).toBe(true); expect(pageRouter).not.toHaveBeenCalled();
    expect(item.details.open).toBe(false); expect(document.activeElement).toBe(item.summary);
    window.removeEventListener("keydown", pageRouter, { capture: true }); binding.dispose();
  });
  it("leaves unrelated Escape available to later capture routing", () => {
    const { binding } = setup(); const pageRouter = vi.fn();
    window.addEventListener("keydown", pageRouter, { capture: true });
    const event = escape();
    expect(event.defaultPrevented).toBe(false); expect(pageRouter).toHaveBeenCalledOnce();
    window.removeEventListener("keydown", pageRouter, { capture: true }); binding.dispose();
  });
  it("does not focus a disconnected owning summary on Escape", () => {
    const { binding, add } = setup(); const item = add("File"); open(item.details); item.details.remove();
    escape();
    expect(document.activeElement).not.toBe(item.summary); binding.dispose();
  });
  it("closes on an outside pointer and window blur", () => {
    const { binding, outside, add } = setup(); const item = add("File"); open(item.details);
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true })); expect(item.details.open).toBe(false);
    open(item.details); window.dispatchEvent(new Event("blur")); expect(item.details.open).toBe(false); binding.dispose();
  });
  it("forgets disconnected menus across rerenders without closing or focusing replacements", () => {
    const { binding, menu, add } = setup(); const old = add("old"); open(old.details);
    menu.replaceChildren(); const replacement = add("replacement"); open(replacement.details);
    expect(replacement.details.open).toBe(true); expect(document.activeElement).not.toBe(old.summary); binding.dispose();
  });
  it("removes its window capture handler when disposed", () => {
    const { binding, add } = setup(); const item = add("File"); const pageRouter = vi.fn();
    window.addEventListener("keydown", pageRouter, { capture: true }); binding.dispose();
    open(item.details); const event = escape();
    expect(event.defaultPrevented).toBe(false); expect(pageRouter).toHaveBeenCalledOnce();
    window.removeEventListener("keydown", pageRouter, { capture: true }); binding.dispose();
  });
  it("ignores unrelated details and disposes idempotently", () => {
    const { binding, add } = setup(); const item = add("File"); const unrelated = document.createElement("details"); document.body.append(unrelated);
    open(unrelated); expect(unrelated.open).toBe(true);
    open(item.details); binding.dispose(); binding.dispose();
    expect(item.details.open).toBe(false); item.details.open = true; item.details.dispatchEvent(new Event("toggle", { bubbles: true }));
    expect(item.details.open).toBe(true);
  });
  it("keeps late flyouts viewport bounded and right aligned without removing forced-colors support", () => {
    expect(styles).toContain("inline-size: min(17rem, calc(100vw - 0.7rem))");
    expect(styles).toContain("max-inline-size: calc(100vw - 0.7rem)");
    expect(styles).toContain(".windows-menu details:nth-child(n + 5) .windows-menu-commands { right: 0; }");
    expect(styles).toContain("@media (forced-colors: active)");
  });
});
