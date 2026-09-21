import { describe, expect, it } from "vitest";
import { fitRecentPath } from "../../../src/ui/RecentPathPresentation";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const measure = (text: string): number => Array.from(text).length * 8;
const visibleText = (value: ReturnType<typeof fitRecentPath>): string => value.directoryText + value.filenameText;

function expectFits(value: ReturnType<typeof fitRecentPath>, width: number): void {
  expect(measure(visibleText(value))).toBeLessThanOrEqual(width);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("RecentPathPresentation", () => {
  it("keeps a fitting full path at the fixed measurement size", () => {
    const path = "C:\\Docs\\paper.pdf";
    const result = fitRecentPath(path, "paper.pdf", measure(path), measure);
    expect(visibleText(result)).toBe(path);
    expect(result.directoryText).toBe("C:\\Docs\\");
    expect(result.filenameText).toBe("paper.pdf");
  });

  it("middle-truncates a long directory while retaining its root and full filename", () => {
    const name = "report.pdf";
    const path = `C:\\Research\\${"Long directory\\".repeat(16)}${name}`;
    const width = 260;
    const result = fitRecentPath(path, name, width, measure);
    expect(result.directoryText.startsWith("C:\\")).toBe(true);
    expect(result.directoryText).toContain("…");
    expect(result.filenameText).toBe(name);
    expectFits(result, width);
  });

  it("middle-truncates a long filename while keeping its .pdf extension", () => {
    const name = `${"long-report-".repeat(20)}.pdf`;
    const width = 180;
    const result = fitRecentPath(`C:\\Documents\\${name}`, name, width, measure);
    expect(result.directoryText.startsWith("C:\\")).toBe(true);
    expect(result.filenameText).not.toBe(name);
    expect(result.filenameText).toContain("…");
    expect(result.filenameText.endsWith(".pdf")).toBe(true);
    expectFits(result, width);
  });

  it("collapses an overlong UNC root instead of forcing an undersized font", () => {
    const name = "report.pdf";
    const path = `\\\\${"s".repeat(30)}\\${"h".repeat(30)}\\docs\\${name}`;
    const width = 180;
    const result = fitRecentPath(path, name, width, measure);
    expect(result.directoryText.startsWith("\\\\")).toBe(true);
    expect(result.directoryText).toContain("…");
    expect(result.filenameText).toBe(name);
    expectFits(result, width);
  });

  it("keeps Unicode grapheme clusters intact around directory truncation", () => {
    const name = "연구😀.pdf";
    const path = `C:\\${"가족👨‍👩‍👧‍👦é\\".repeat(30)}${name}`;
    const result = fitRecentPath(path, name, 270, measure);
    expect(result.directoryText.startsWith("C:\\")).toBe(true);
    expect(result.directoryText).toContain("…");
    expect(result.directoryText).not.toMatch(/…\p{M}/u);
    expect(hasUnpairedSurrogate(result.directoryText)).toBe(false);
    expect(Array.from(graphemeSegmenter.segment(result.directoryText)).length).toBeGreaterThan(0);
    expectFits(result, 270);
  });

  it("restores the complete path when width grows without carrying truncation state", () => {
    const name = `${"long-name-".repeat(20)}.pdf`;
    const path = `D:\\Papers\\${name}`;
    const narrow = fitRecentPath(path, name, 160, measure);
    expect(visibleText(narrow)).not.toBe(path);
    expectFits(narrow, 160);

    const wide = fitRecentPath(path, name, measure(path) + 1, measure);
    expect(visibleText(wide)).toBe(path);
    expect(wide.directoryText).toBe("D:\\Papers\\");
    expect(wide.filenameText).toBe(name);
  });

  it("returns no overflowing text for tiny, zero, or invalid widths", () => {
    const path = "C:\\Docs\\paper.pdf";
    expect(fitRecentPath(path, "paper.pdf", 1, measure)).toEqual({ directoryText: "", filenameText: "" });
    expect(fitRecentPath(path, "paper.pdf", 0, measure)).toEqual({ directoryText: "", filenameText: "" });
    expect(fitRecentPath(path, "paper.pdf", Number.NaN, measure)).toEqual({ directoryText: "", filenameText: "" });
    expect(fitRecentPath(path, "paper.pdf", Number.POSITIVE_INFINITY, measure)).toEqual({ directoryText: "", filenameText: "" });
  });

  it("bounds measurements for a maximum-length path", () => {
    const name = `${"long-report-".repeat(1000)}.pdf`;
    const directory = `C:\\${"x".repeat(32767 - 3 - name.length - 1)}\\`;
    const path = directory + name;
    expect(path.length).toBe(32767);

    let measureCalls = 0;
    const measured = (text: string): number => {
      measureCalls += 1;
      return Array.from(text).length * 8;
    };
    const width = 240;
    const result = fitRecentPath(path, name, width, measured);
    expect(measureCalls).toBeLessThanOrEqual(150);
    expectFits(result, width);
  });
  it("supports forward-slash display paths at the same fixed size", () => {
    const name = "paper.pdf";

    const path = `/research/${"long-folder/".repeat(16)}${name}`;
    const width = 250;
    const result = fitRecentPath(path, name, width, measure);
    expect(result.directoryText.startsWith("/")).toBe(true);
    expect(result.directoryText).toContain("…");
    expect(result.filenameText).toBe(name);
    expectFits(result, width);
  });
});
