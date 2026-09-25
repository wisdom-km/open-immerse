/**
 * Shared PDF open/record/prelabel/check path for the M1 scripts.
 * Requires the optional MIT package @napi-rs/canvas (npm ci).
 * pdf/vendor is used as-is and is not modified.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { installRecordingPath2D, createRecordingContext } from "../lib/svg-recorder.js";
import { attachFontRealNames, fontNameForFormula } from "../lib/pdf-mirror.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import {
  buildFormulaRuns,
  buildFormulaSvg,
  foreignGlyphBoxes,
  pageBox
} from "../lib/formula-svg.js";
import { assemblePageElements, matchPaintToLabel, textItemBaseline, textItemPageBox } from "../lib/page-elements.js";
import { prelabelElements } from "../lib/prelabel.js";
import { LABEL_SCHEMA } from "../lib/label-schema.js";
import {
  countMissingInkFullCrop,
  fallbackRate,
  neighbourContent,
  round3,
  unitAccuracy
} from "../lib/label-checks.js";

const require = createRequire(import.meta.url);

export function loadCanvas() {
  try {
    return require("@napi-rs/canvas");
  } catch {
    throw new Error("缺少 @napi-rs/canvas。在仓库根目录运行 npm ci 后再执行本脚本。");
  }
}

let pdfjsPromise;
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const canvas = loadCanvas();
      installRecordingPath2D(canvas.Path2D);
      const pdfjs = await import("../pdf/vendor/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
      installRecordingPath2D(canvas.Path2D);
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * SHA-256 of page count, media-box size, and pdf.js text items.
 * The Info dictionary, XMP metadata, and trailer /ID are not included,
 * so a publisher download stamp does not change the fingerprint.
 */
export async function contentFingerprint(bytes) {
  const { getDocument } = await loadPdfjs();
  const doc = await getDocument({
    data: new Uint8Array(bytes).slice(),
    disableFontFace: true,
    verbosity: 0,
    isEvalSupported: false
  }).promise;
  const lines = [`pages:${doc.numPages}`];
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      try {
        const view = page.view || [0, 0, 0, 0];
        const width = round2(view[2] - view[0]);
        const height = round2(view[3] - view[1]);
        lines.push(`page:${number}:${width}x${height}:rot${page.rotate || 0}`);
        const text = await page.getTextContent({ includeMarkedContent: false });
        for (const item of text.items || []) {
          if (!item || typeof item.str !== "string") continue;
          const transform = (item.transform || []).map(round2).join(",");
          lines.push(`${item.str}\t${transform}`);
        }
      } finally {
        page.cleanup?.();
      }
    }
  } finally {
    await doc.destroy();
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export async function openDocuments(bytes) {
  const { getDocument } = await loadPdfjs();
  const base = new Uint8Array(bytes);
  const face = await getDocument({ data: base.slice(), disableFontFace: false, verbosity: 0 }).promise;
  const outline = await getDocument({ data: base.slice(), disableFontFace: true, verbosity: 0 }).promise;
  return { face, outline };
}

function paintsOf(record) {
  const paints = [];
  const paths = [];
  const images = [];
  for (const element of record.elements || []) {
    if (!element || element.provenance === "background" || element.synthetic) continue;
    if (element.provenance === "glyph") paints.push(element);
    else if (element.provenance === "image" || element.op === "drawImage") images.push(element);
    else if (element.provenance === "path") paths.push(element);
  }
  return { paints, paths, images };
}

export async function readPageContent(page) {
  const viewport = page.getViewport({ scale: 1 });
  const text = await page.getTextContent();
  const ops = await page.getOperatorList();
  attachFontRealNames(text.items, page.commonObjs);
  return { viewport, text, ops };
}

export function labelPageFromRecord({ paperId, pageNumber, viewport, text, record }) {
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const glyphs = [];
  for (const item of text.items || []) {
    const char = String(item?.str ?? "");
    if (!char.trim()) continue;
    const bbox = textItemPageBox(item, viewport);
    if (!(bbox[2] > bbox[0]) || !(bbox[3] > bbox[1])) continue;
    glyphs.push({
      char,
      font: fontNameForFormula(item),
      bbox,
      baseline: textItemBaseline(item, viewport),
      fontSize: Number(item.height) || (bbox[3] - bbox[1])
    });
  }
  const { paints, paths, images } = paintsOf(record);
  const elements = assemblePageElements({ glyphs, paints, paths, images });
  const labelled = prelabelElements(elements, viewport.width, viewport.height);
  return pageDocument({
    paperId,
    page: pageNumber,
    pageWidth: width,
    pageHeight: height,
    source: "prelabel",
    elements: labelled.elements,
    units: labelled.units
  });
}

export function pageDocument({ paperId, page, pageWidth, pageHeight, source, elements, units }) {
  return {
    schema: LABEL_SCHEMA,
    paperId,
    page,
    pageWidth,
    pageHeight,
    source,
    elements: elements.map(slimElement),
    units: units.map((unit) => ({
      id: unit.id,
      type: unit.type,
      equationNumber: unit.equationNumber === true,
      confidence: unit.confidence,
      fallback: unit.fallback === true,
      elementIds: unit.elementIds.slice()
    }))
  };
}

function slimElement(element) {
  const slim = {
    id: element.id,
    kind: element.kind,
    char: element.char,
    font: element.font,
    bbox: element.bbox,
    pathHash: element.pathHash || "",
    ordinal: element.ordinal,
    label: element.label,
    confidence: element.confidence,
    rule: element.rule || ""
  };
  if (element.source && element.source !== "text") slim.source = element.source;
  if (element.label === "formula") {
    slim.unitId = element.unitId;
    slim.unitType = element.unitType;
    slim.equationNumber = element.equationNumber === true;
  }
  return slim;
}

export async function recordOutline(page) {
  const viewport = page.getViewport({ scale: 1 });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const context = createRecordingContext(width, height);
  const started = performance.now();
  await page.render({ canvasContext: context, viewport }).promise;
  return { context, ms: performance.now() - started, viewport, width, height };
}

async function withNativePath2D(fn) {
  const recording = globalThis.Path2D;
  const native = globalThis.__oiNativePath2D;
  if (!native || native === recording) return fn();
  globalThis.Path2D = native;
  try {
    return await fn();
  } finally {
    globalThis.Path2D = recording;
  }
}

export async function rasterPage(page, scale = 1) {
  const { createCanvas } = loadCanvas();
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  await withNativePath2D(() => page.render({ canvasContext: context, viewport }).promise);
  return { canvas, context, width, height, scale };
}

function cropRect(raster, rect) {
  const scale = raster.scale || 1;
  const x0 = Math.max(0, Math.floor(rect[0] * scale));
  const y0 = Math.max(0, Math.floor(rect[1] * scale));
  const x1 = Math.min(raster.width, Math.ceil(rect[2] * scale));
  const y1 = Math.min(raster.height, Math.ceil(rect[3] * scale));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const image = raster.context.getImageData(x0, y0, width, height);
  return { data: image.data, width, height, x0, y0 };
}

async function rasterSvgOnCrop(svgText, view, crop) {
  const { createCanvas, loadImage } = loadCanvas();
  const canvas = createCanvas(crop.width, crop.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, crop.width, crop.height);
  if (!svgText || !(view?.width > 0) || !(view?.height > 0)) {
    return context.getImageData(0, 0, crop.width, crop.height).data;
  }
  const image = await loadImage(Buffer.from(svgText));
  const scale = 1;
  const dx = view.x * scale - crop.x0;
  const dy = view.y * scale - crop.y0;
  context.drawImage(image, dx, dy, view.width * scale, view.height * scale);
  return context.getImageData(0, 0, crop.width, crop.height).data;
}

function unitBox(unit, labels) {
  const boxes = unit.elementIds.map((id) => labels.get(id)?.bbox).filter(Boolean);
  if (!boxes.length) return null;
  return [
    Math.min(...boxes.map((box) => box[0])) - 2,
    Math.min(...boxes.map((box) => box[1])) - 2,
    Math.max(...boxes.map((box) => box[2])) + 2,
    Math.max(...boxes.map((box) => box[3])) + 2
  ];
}

function blockPageBox(block, viewport) {
  return pageBox(block.bbox, viewport.width, viewport.height);
}

export async function scoreBaselinePage({ paperId, pageNumber, facePage, outlinePage, labels }) {
  const content = await readPageContent(facePage);
  const recorded = await recordOutline(outlinePage);
  const buildStarted = performance.now();
  let blocks = [];
  let blockError = "";
  try {
    const built = textLayerToBlocks({
      items: content.text.items,
      viewport: content.viewport,
      images: { fnArray: content.ops.fnArray, argsArray: content.ops.argsArray },
      page: pageNumber
    });
    blocks = (built.blocks || []).filter((block) => block.label === "formula");
  } catch (error) {
    blockError = String(error && error.message || error);
  }
  const labelById = new Map(labels.elements.map((element) => [element.id, element]));
  const predicted = [];
  const neighbours = [];
  const identityConflicts = [];
  let svgBytes = 0;
  let empty = 0;
  const blockSvgs = [];
  for (const block of blocks) {
    const foreignBoxes = foreignGlyphBoxes(block, content.text.items, content.viewport);
    const runs = buildFormulaRuns(content.text.items, content.viewport, block);
    const formula = {
      ...block,
      foreignBoxes,
      runs,
      pageWidth: content.viewport.width,
      pageHeight: content.viewport.height
    };
    const svg = buildFormulaSvg(recorded.context, formula);
    svgBytes += svg.bytes;
    if (!svg.elementCount) empty += 1;
    const ids = [];
    for (const element of svg.elements || []) {
      const paint = (recorded.context.elements || []).find((item) => item.id === element.id) || element;
      const match = matchPaintToLabel(paint, labels.elements);
      if (match.conflict) {
        identityConflicts.push({ blockId: block.id, paintId: element.id });
        continue;
      }
      if (!match.label) continue;
      ids.push(match.label.id);
      if (match.label.label !== "formula") neighbours.push(match.label.id);
    }
    const unique = [...new Set(ids)];
    predicted.push(unique);
    blockSvgs.push({ block, svg, ids: unique });
  }
  const buildMs = performance.now() - buildStarted;
  const accuracy = unitAccuracy(labels.units, predicted);
  const neighbourHits = neighbourContent([...new Set(neighbours)], labelById);
  const baselineFallback = fallbackRate(
    blocks.map((block, index) => ({ id: block.id || String(index), confidence: 1, fallback: false })),
    { emptyIds: blockSvgs.filter((entry) => !entry.svg.elementCount).map((entry) => entry.block.id) }
  );
  const prelabelFallback = fallbackRate(labels.units);
  let missing = 0;
  let solid = 0;
  let crops = 0;
  // Reference ink is the outline render. It is the same paint the recorder
// saw, so a radical the selector dropped is dark on the left and absent
// in the SVG. Font-face hinting is a different question and is not A1.
const raster = labels.units.length ? await rasterPage(outlinePage, 1) : null;
  for (const unit of labels.units) {
    const box = unitBox(unit, labelById);
    if (!box || !raster) continue;
    let best = null;
    let bestArea = 0;
    const target = blockPageBox({ bbox: [
      box[0] / content.viewport.width,
      box[1] / content.viewport.height,
      box[2] / content.viewport.width,
      box[3] / content.viewport.height
    ] }, content.viewport);
    for (const entry of blockSvgs) {
      const blockBox = blockPageBox(entry.block, content.viewport);
      if (!blockBox || !target) continue;
      const width = Math.min(blockBox[2], target[2]) - Math.max(blockBox[0], target[0]);
      const height = Math.min(blockBox[3], target[3]) - Math.max(blockBox[1], target[1]);
      const area = width > 0 && height > 0 ? width * height : 0;
      if (area > bestArea) {
        bestArea = area;
        best = entry;
      }
    }
    const crop = cropRect(raster, box);
    if (crop.width * crop.height > 1_500_000) continue;
    const svgPixels = await rasterSvgOnCrop(best?.svg.svg || "", best?.svg.viewBox || null, crop);
    const ink = countMissingInkFullCrop(crop.data, svgPixels, crop.width, crop.height);
    missing += ink.missing;
    solid += ink.solid;
    crops += 1;
  }
  return {
    paperId,
    page: pageNumber,
    recordMs: round3(recorded.ms),
    buildMs: round3(buildMs),
    svgBytes,
    formulaUnits: labels.units.length,
    baselineBlocks: blocks.length,
    emptySvgs: empty,
    accuracy,
    neighbourCount: neighbourHits.filter((hit) => hit.problem === "neighbour").length,
    identityConflicts: identityConflicts.length,
    missing,
    solid,
    crops,
    prelabelFallback,
    baselineFallback,
    blockError,
    unsupported: recorded.context.unsupportedCounts()
  };
}

export async function prelabelOnePage({ paperId, pageNumber, facePage, outlinePage }) {
  const content = await readPageContent(facePage);
  const recorded = await recordOutline(outlinePage);
  const labels = labelPageFromRecord({
    paperId,
    pageNumber,
    viewport: content.viewport,
    text: content.text,
    record: recorded.context
  });
  return { labels, recordMs: recorded.ms, elementCount: recorded.context.elements.length };
}
