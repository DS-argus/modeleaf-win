import { getDocument, GlobalWorkerOptions, OPS, type PDFPageProxy } from "pdfjs-dist";
GlobalWorkerOptions.workerSrc = "/node_modules/pdfjs-dist/build/pdf.worker.mjs";
const allowed = new Set(["fixture-B-blank.pdf", "fixture-F-raster-12.pdf", "fixture-L-text-300.pdf", "print-mixed-rotation-4.pdf"]);
type Rect = { x: number; y: number; width: number; height: number };
const canvas = (width: number, height: number) => {
  const value = document.createElement("canvas"); value.width = width; value.height = height; return value;
};
const context = (surface: HTMLCanvasElement) => surface.getContext("2d", { willReadFrequently: true })!;
async function raster(page: PDFPageProxy, rotation = page.rotate, rect?: Rect) {
  const viewport = page.getViewport({ scale: 2, rotation });
  const surface = canvas(rect?.width ?? Math.ceil(viewport.width), rect?.height ?? Math.ceil(viewport.height));
  await page.render({ canvas: surface, canvasContext: context(surface), viewport, intent: "print", annotationMode: 0,
    background: "rgb(255,255,255)", ...(rect ? { transform: [1, 0, 0, 1, -rect.x, -rect.y] } : {}) }).promise;
  return surface;
}
function compose(source: HTMLCanvasElement, paper: { width: number; height: number }) {
  const result = canvas(paper.width, paper.height), ctx = context(result);
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, paper.width, paper.height);
  const fit = Math.min(paper.width / source.width, paper.height / source.height);
  ctx.drawImage(source, (paper.width - source.width * fit) / 2, (paper.height - source.height * fit) / 2, source.width * fit, source.height * fit);
  return result;
}
function thumbnail(source: HTMLCanvasElement) {
  const small = canvas(256, 256); context(small).drawImage(source, 0, 0, 256, 256);
  const pixels = context(small).getImageData(0, 0, 256, 256).data; small.width = small.height = 0; return pixels;
}
function distance(left: Uint8ClampedArray, right: Uint8ClampedArray) {
  if (left.length !== right.length) throw new Error("Pixel geometry mismatch");
  let sum = 0;
  for (let index = 0; index < left.length; index += 4) sum += Math.abs(left[index]! - right[index]!) + Math.abs(left[index + 1]! - right[index + 1]!) + Math.abs(left[index + 2]! - right[index + 2]!);
  return sum / (left.length / 4 * 3);
}
export async function verify(fixture: string, outputUrl: string) {
  if (!allowed.has(fixture) || !outputUrl.startsWith("/.internal/evidence/issue-83/native/") || !outputUrl.endsWith("/output.pdf") || outputUrl.includes("..")) throw new Error("Only owned fixture output may be verified");
  const read = async (path: string) => { const response = await fetch(path); if (!response.ok) throw new Error(`PDF fetch failed: ${response.status}`); return new Uint8Array(await response.arrayBuffer()); };
  const options = { useSystemFonts: false, standardFontDataUrl: "/node_modules/pdfjs-dist/standard_fonts/", cMapUrl: "/node_modules/pdfjs-dist/cmaps/", cMapPacked: true, wasmUrl: "/node_modules/pdfjs-dist/wasm/" };
  const sourceTask = getDocument({ ...options, data: await read(`/fixtures/pdf/${fixture}`) });
  const outputTask = getDocument({ ...options, data: await read(outputUrl) });
  const samples = [];
  try {
    const [source, output] = await Promise.all([sourceTask.promise, outputTask.promise]);
    if (source.numPages !== output.numPages) throw new Error(`Page count mismatch: ${source.numPages}/${output.numPages}`);
    const firstOutput = await output.getPage(1), paperView = firstOutput.getViewport({ scale: 2 });
    const paper = { width: Math.ceil(paperView.width), height: Math.ceil(paperView.height) };
    let numberRect: Rect | undefined;
    if (fixture === "fixture-L-text-300.pdf") {
      const page = await source.getPage(1), operators = await page.getOperatorList();
      const glyphs = operators.argsArray[operators.fnArray.indexOf(OPS.showText)]?.[0] as { unicode: string; width: number }[];
      const prefix = "PDFReader performance fixture L page ";
      if (!Array.isArray(glyphs) || glyphs.slice(0, prefix.length).map((glyph) => glyph.unicode).join("") !== prefix) throw new Error("Fixture digit geometry changed");
      const prefixPoints = glyphs.slice(0, prefix.length).reduce((sum, glyph) => sum + glyph.width * 14 / 1000, 0);
      const digitWidth = glyphs[prefix.length]!.width * 14 / 1000, view = page.getViewport({ scale: 2 });
      const fit = Math.min(paper.width / view.width, paper.height / view.height), m = 2 * fit;
      numberRect = { x: Math.floor((paper.width - view.width * fit) / 2 + (48 + prefixPoints - 2) * m),
        y: Math.floor((paper.height - view.height * fit) / 2 + (792 - 720 - 15) * m), width: Math.ceil((digitWidth * 3 + 4) * m), height: Math.ceil(19 * m) };
    }
    const templates: { page: number; rotation: number; pixels: Uint8ClampedArray }[] = [];
    for (let pageNumber = 1; pageNumber <= source.numPages; pageNumber += 1) {
      const page = await source.getPage(pageNumber);
      for (const rotation of fixture === "print-mixed-rotation-4.pdf" ? [0, 90, 180, 270] : [page.rotate]) {
        const image = await raster(page, rotation), expected = compose(image, paper);
        templates.push({ page: pageNumber, rotation, pixels: numberRect ? context(expected).getImageData(numberRect.x, numberRect.y, numberRect.width, numberRect.height).data : thumbnail(expected) });
        image.width = image.height = expected.width = expected.height = 0;
      }
    }
    for (let pageNumber = 1; pageNumber <= output.numPages; pageNumber += 1) {
      const page = await output.getPage(pageNumber), original = await source.getPage(pageNumber), view = page.getViewport({ scale: 2 });
      if (Math.abs(view.width - paperView.width) > 0.02 || Math.abs(view.height - paperView.height) > 0.02) throw new Error(`Unexpected selected-paper size: ${pageNumber}`);
      const image = await raster(page, page.rotate, numberRect);
      const pixels = numberRect ? context(image).getImageData(0, 0, image.width, image.height).data : thumbnail(image);
      const scores = templates.map((template) => ({ page: template.page, rotation: template.rotation, error: distance(pixels, template.pixels) })).sort((left, right) => left.error - right.error);
      image.width = image.height = 0;
      const best = scores[0]!;
      const sample = { page: pageNumber, sourceRotation: original.rotate, outputRotation: page.rotate, outputPoints: [view.width / 2, view.height / 2], match: best, runnerUp: scores[1] ?? null };
      samples.push(sample);
      Object.assign(window, { printCandidateProgress: { fixture, repetition: 0, phase: "verifying-output", preparedPages: pageNumber } });
      if (best.page !== pageNumber || best.rotation !== original.rotate) throw new Error(`Output identity/rotation mismatch on page ${pageNumber}: ${JSON.stringify(sample)}`);
      if (best.error > 25 || (fixture === "fixture-B-blank.pdf" && best.error > 0.05)) throw new Error(`Output fidelity mismatch: ${JSON.stringify(sample)}`);
    }
    return { fixture, pageCount: source.numPages, outputPages: output.numPages, samples, failure: null };
  } finally { await Promise.all([sourceTask.destroy(), outputTask.destroy()]); }
}
