import { describe, expect, it } from "vitest";
import { fitRecentPath } from "../../../src/ui/RecentPathPresentation";

const measure = (text: string, fontSize: number): number => Array.from(text).length * fontSize;
const visibleText = (value: ReturnType<typeof fitRecentPath>): string => value.directoryText + value.filenameText;

describe("RecentPathPresentation", () => {
  it("keeps a fitting full path without truncating or shrinking", () => {
    const path = "C:\\Docs\\paper.pdf";
    const result = fitRecentPath(path, "paper.pdf", measure(path, 13), 13, measure);
    expect(visibleText(result)).toBe(path);
    expect(result.fontSize).toBe(13);
  });

  it("middle-truncates the directory while retaining its root and complete filename", () => {
    const name = "report.pdf";
    const path = `C:\\Research\\${"Long directory\\".repeat(8)}${name}`;
    const result = fitRecentPath(path, name, 260, 13, measure);
    expect(result.directoryText.startsWith("C:\\")).toBe(true);
    expect(result.directoryText).toContain("…");
    expect(result.filenameText).toBe(name);
    expect(measure(visibleText(result), result.fontSize)).toBeLessThanOrEqual(260.01);
  });

  it("shrinks a long filename rather than clipping it or its extension", () => {
    const name = `${"긴보고서".repeat(50)}.pdf`;
    const result = fitRecentPath(`C:\\Documents\\${name}`, name, 120, 13, measure);
    expect(result.directoryText.startsWith("C:\\")).toBe(true);
    expect(result.filenameText).toBe(name);
    expect(result.fontSize).toBeGreaterThan(0);
    expect(result.fontSize).toBeLessThan(13);
    expect(measure(visibleText(result), result.fontSize)).toBeLessThanOrEqual(120.01);
  });

  it("does not split Unicode characters around the directory ellipsis", () => {
    const name = "연구😀.pdf";
    const path = `C:\\${"가족👨‍👩‍👧‍👦é\\".repeat(30)}${name}`;
    const result = fitRecentPath(path, name, 270, 13, measure);
    expect(result.filenameText).toBe(name);
    expect(result.directoryText).toContain("…");
    expect(result.directoryText).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(result.directoryText).not.toMatch(/…\p{M}/u);
    expect(measure(visibleText(result), result.fontSize)).toBeLessThanOrEqual(270.01);
  });

  it("recovers full text and base font when the available width grows", () => {
    const name = `${"long-name-".repeat(20)}.pdf`;
    const path = `D:\\Papers\\${name}`;
    const narrow = fitRecentPath(path, name, 200, 13, measure);
    expect(narrow.fontSize).toBeLessThan(13);
    const wide = fitRecentPath(path, name, measure(path, 13) + 1, 13, measure);
    expect(wide.fontSize).toBe(13);
    expect(visibleText(wide)).toBe(path);
  });

  it("supports display-only paths with forward separators", () => {
    const name = "paper.pdf";
    const path = `/research/${"long-folder/".repeat(12)}${name}`;
    const result = fitRecentPath(path, name, 250, 13, measure);
    expect(result.directoryText.startsWith("/")).toBe(true);
    expect(result.directoryText).toContain("…");
    expect(result.filenameText).toBe(name);
    expect(measure(visibleText(result), result.fontSize)).toBeLessThanOrEqual(250.01);
  });
});
