import "../../src/styles/app.css";
import mainSource from "../../src/main.ts?raw";
import { THEMES, THEME_TOKENS, themeContrastEndpoint } from "../../src/domain/theme/Theme";
import { createTabStripRenderer, type TabStripTab } from "../../src/ui/shell/TabStripRenderer";
import { createShellStatusRenderer } from "../../src/ui/shell/ShellStatusRenderer";
import { createPrintProgress } from "../../src/ui/PrintProgress";
import { AnnotationMode, getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { renderCommandPalette } from "../../src/ui/CommandPaletteRenderer";
import { buildCommandPaletteEntries } from "../../src/ui/CommandPaletteModel";
import { buildHelpRows } from "../../src/ui/HelpModel";

// Renderer-only fixture: no native behavior or installed version is simulated as evidence.
const app = document.querySelector<HTMLElement>("#app")!;
const emptyMarkup = mainSource.match(/<section id="empty-reader"[\s\S]*?<\/section>/)![0];
app.innerHTML = `<section class="app-shell"><nav class="windows-menu" aria-label="Application menu"><details><summary>File</summary></details><details><summary>View</summary></details><details><summary>Help</summary></details></nav><div id="tabs" class="tab-strip" role="tablist" aria-label="Open PDFs"></div><main id="reader-main"><div class="tab-hosts"><div class="reader-surface tab-host"><div class="pdf-page-frame"><canvas class="pdf-page"></canvas></div></div></div>${emptyMarkup}</main><footer class="statusbar"></footer></section>`;
const root = app.firstElementChild as HTMLElement;
for (const id of ["help", "theme", "command-palette"]) {
  root.insertAdjacentHTML("beforeend", mainSource.match(new RegExp(`<dialog id="${id}-dialog"[\\s\\S]*?</dialog>`))![0]);
}
renderCommandPalette(root.querySelector("#palette-list")!, buildCommandPaletteEntries().filter((entry) => entry.kind === "command"), 0, () => undefined);
const helpGroups = new Map<string, HTMLElement>();
for (const row of buildHelpRows()) {
  let list = helpGroups.get(row.category);
  if (!list) {
    const section = document.createElement("section"); section.className = "help-group";
    const heading = document.createElement("h2"); heading.textContent = row.category;
    list = document.createElement("dl"); section.append(heading, list);
    root.querySelector("#help-rows")!.append(section); helpGroups.set(row.category, list);
  }
  const label = document.createElement("dt"); label.textContent = row.label;
  const key = document.createElement("dd"); key.textContent = row.shortcut; list.append(label, key);
}
for (const theme of THEMES) {
  const option = document.createElement("button"); option.type = "button"; option.className = "theme-option";
  option.setAttribute("role", "radio"); option.setAttribute("aria-checked", String(theme.id === "tokyo-night"));
  option.textContent = theme.displayName; root.querySelector("#theme-list")!.append(option);
}
root.querySelector(".theme-footer")!.innerHTML = "<kbd>j/k</kbd> preview · <kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel";
const canvas = app.querySelector<HTMLCanvasElement>("canvas")!;
const footer = app.querySelector<HTMLElement>("footer")!;
const empty = app.querySelector<HTMLElement>("#empty-reader")!;
empty.hidden = true;
app.querySelector("kbd")!.textContent = "Ctrl+O";
let tabs: TabStripTab[] = [];
let status = { hasDocument: true, zoomMode: "fit-page" as "fit-page" | "custom", query: "", searchPromptOpen: false, status: "", page: 1, pageCount: 3, zoom: 1.25 };
const strip = createTabStripRenderer(app.querySelector<HTMLElement>("#tabs")!, {
  activate: (id) => { tabs = tabs.map((tab) => ({ ...tab, selected: tab.id === id })); strip.render(tabs); },
  close: (id) => { tabs = tabs.filter((tab) => tab.id !== id); if (!tabs.some((tab) => tab.selected) && tabs[0]) tabs[0] = { ...tabs[0], selected: true }; strip.render(tabs); },
});
const shell = createShellStatusRenderer(footer, () => status, { onHelp: () => { root.dataset.helpInvoked = "true"; } });
const print = createPrintProgress(shell.printHost, () => { root.dataset.printCancelled = "true"; });
const setTheme = (id: string) => {
  const theme = THEMES.find((entry) => entry.id === id);
  if (!theme) throw new Error("Unknown fixture theme");
  for (const token of THEME_TOKENS) root.style.setProperty(`--theme-${token}`, theme.palette[token]);
  root.style.setProperty("--theme-contrast", themeContrastEndpoint(theme.palette));
};
const setTabs = (count = 3) => {
  tabs = Array.from({ length: count }, (_, index) => ({ id: String(index), title: ["nonuniform-size-pdf.pdf", "2025-primacy-of-magnitude-and-very-long-filename.pdf", "apache-book-full-spread.pdf"][index % 3]!, selected: index === count - 1 }));
  strip.render(tabs);
};
setTheme("tokyo-night");
setTabs();
shell.render();
GlobalWorkerOptions.workerSrc = "/assets/pdfjs-6.2.108/build/pdf.worker.min.mjs";
const loading = getDocument({ url: "/fixtures/pdf/text-3-page.pdf", isEvalSupported: false, enableXfa: false });
const ready = loading.promise.then(async (pdf) => {
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 0.6 });
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d")!;
  await page.render({ canvas, canvasContext: context, viewport, annotationMode: AnnotationMode.DISABLE }).promise;
  await loading.destroy();
  root.dataset.ready = "true";
});
Object.assign(window, { shellQa: {
  ready, setTheme, setTabs,
  setStatus: (value: Partial<typeof status>, pending = "") => { status = { ...status, ...value }; shell.setPendingSequence(pending); shell.render(); },
  setVersion: shell.setVersion,
  setPath: shell.setPathNotice,
  showOverlay: (id: string | undefined) => {
    root.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((dialog) => dialog.close());
    if (id) root.querySelector<HTMLDialogElement>(`#${id}-dialog`)!.showModal();
  },
  setPrint: print.update,
  setEmpty: (visible: boolean) => { empty.hidden = !visible; app.querySelector<HTMLElement>(".tab-hosts")!.hidden = visible; app.querySelector<HTMLElement>("#tabs")!.hidden = visible; },
  setDisabled: (id: string) => { tabs = tabs.map((tab) => ({ ...tab, disabled: tab.id === id })); strip.render(tabs); },
  pixelHash: async () => {
    const bytes = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  },
} });
