import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "src", "domain");
const expectedDomains = [
  "actions",
  "config",
  "input",
  "navigation",
  "recent",
  "tabs",
  "theme",
  "update",
] as const;

const sourceFiles = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
};

const imports = (source: string): string[] => [...source.matchAll(
  /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu,
)].map((match) => match[1]!);

const forbiddenModule = /^(?:@tauri-apps\/|pdfjs-dist(?:\/|$))|(?:^|\/)(?:pdf|platform|ui|application)(?:\/|$)/u;
const forbiddenRuntime = /\b(?:window|document|HTMLElement|Element|Node|Range|KeyboardEvent|PointerEvent|MouseEvent|CanvasRenderingContext2D|HTMLCanvasElement|AbortController|AbortSignal)\b/u;

describe("W03 pure domain boundary", () => {
  it("contains every required product-domain slice", () => {
    expect(expectedDomains.filter((name) => !existsSync(join(root, name)))).toEqual([]);
  });

  it("imports no DOM, Tauri, PDF.js, platform, UI, application, or PDF adapter surface", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of imports(source)) {
        if (forbiddenModule.test(specifier.replaceAll("\\", "/"))) {
          violations.push(`${relative(root, file)} imports ${specifier}`);
        }
      }
      const executable = source
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/\/\/.*$/gmu, "")
        .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*?\1/gu, "");
      const runtime = executable.match(forbiddenRuntime)?.[0];
      if (runtime !== undefined) violations.push(`${relative(root, file)} uses ${runtime}`);
    }
    expect(violations).toEqual([]);
  });
});
