import { createRecordingContext } from "../lib/svg-recorder.js";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { attachFontRealNames } from "../lib/pdf-mirror.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import {
  INK_AA_TOLERANCE,
  boxArea,
  buildFormulaSvg,
  countExtraInk,
  countMissingInk,
  diffStats,
  foreignGlyphBoxes,
  lumaOf,
  maskFromBoxes,
  overlapArea,
  pageBox,
  svgSecurityIssues,
  textItemNormBox
} from "../lib/formula-svg.js";

GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

const DEBUG = new URLSearchParams(location.search).get("debug") === "1";
const DOCS = DEBUG
  ? [{ id: "1706.03762", label: "attention", file: "1706.03762.pdf", pages: [4] }]
  : [
    {
      id: "1706.03762",
      label: "attention",
      file: "1706.03762.pdf",
      pages: [4, 5]
    },
    {
      id: "2006.11239",
      label: "ddpm",
      file: "2006.11239.pdf",
      pages: [2, 3, 4]
    }
  ];

const ZOOMS = [1, 1.5, 2];
const NAMED = new Set(["p3-b16", "p4-b14", "p4-b15"]);

function status(text) {
  const node = document.getElementById("status");
  if (node) node.textContent = text;
  console.log(text);
}

function blockText(block, items, viewport) {
  const parts = [];
  for (const item of items || []) {
    if (!String(item?.str || "").trim()) continue;
    const box = textItemNormBox(item, viewport);
    const area = boxArea(box);
    if (!(area > 0)) continue;
    const owned = (block.glyphBoxes || []).some((glyph) => overlapArea(box, glyph) / area > 0.5);
    if (owned) parts.push({ x: box[0], y: box[1], str: item.str });
  }
  parts.sort((a, b) => a.y - b.y || a.x - b.x);
  return parts.map((part) => part.str).join("").replace(/\s+/g, " ");
}

function gateFor(doc, block, text) {
  if (doc.id === "1706.03762" && block.id === "p4-b8") return "G-a";
  if (doc.id === "2006.11239" && block.id === "p2-b19") return "G-b";
  if (doc.id === "1706.03762" && block.id === "p4-b10") return "G-c";
  if (doc.id === "1706.03762" && /Attention\(Q/.test(text) && block.page === 4) return "G-a";
  if (doc.id === "2006.11239" && /∑/.test(text) && /\(3\)/.test(text)) return "G-b";
  return "";
}

async function loadPdf(doc, bytes, disableFontFace) {
  const copy = bytes.slice(0);
  const task = getDocument({
    data: copy,
    disableFontFace,
    verbosity: 0,
    isOffscreenCanvasSupported: false
  });
  return task.promise;
}

async function renderCanvas(page, zoom) {
  const viewport = page.getViewport({ scale: zoom });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  await page.render({ canvasContext: context, viewport }).promise;
  return { canvas, context };
}

async function recordPage(page) {
  const viewport = page.getViewport({ scale: 1 });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const measureCanvas = document.createElement("canvas");
  const measure = measureCanvas.getContext("2d", { willReadFrequently: true });
  const context = createRecordingContext(width, height, { measure });
  const started = performance.now();
  await page.render({ canvasContext: context, viewport }).promise;
  return {
    context,
    ms: performance.now() - started,
    viewport
  };
}

function cropOf(rendered, view, zoom) {
  const canvas = rendered.canvas;
  const width = Math.max(1, Math.round(view.width * zoom));
  const height = Math.max(1, Math.round(view.height * zoom));
  const sx = Math.max(0, Math.round(view.x * zoom));
  const sy = Math.max(0, Math.round(view.y * zoom));
  const sw = Math.min(width, canvas.width - sx);
  const sh = Math.min(height, canvas.height - sy);
  const image = rendered.context.getImageData(sx, sy, Math.max(1, sw), Math.max(1, sh));
  if (sw === width && sh === height) return { image: image.data, width, height, sx, sy };
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  for (let y = 0; y < sh; y += 1) {
    data.set(image.data.subarray(y * sw * 4, (y + 1) * sw * 4), y * width * 4);
  }
  return { image: data, width, height, sx, sy };
}

function rasterSvg(svg, width, height) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const data = context.getImageData(0, 0, width, height).data;
      URL.revokeObjectURL(url);
      resolve(data);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("svg image failed"));
    };
    image.src = url;
  });
}

function toCropBox(box, sx, sy, zoom) {
  return [box[0] * zoom - sx, box[1] * zoom - sy, box[2] * zoom - sx, box[3] * zoom - sy];
}

function diffImage(reference, svg, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const refInk = lumaOf(reference, i * 4) < INK_AA_TOLERANCE.referenceInkLuma;
    const svgInk = lumaOf(svg, i * 4) < INK_AA_TOLERANCE.referenceInkLuma;
    const offset = i * 4;
    if (refInk && svgInk) {
      out[offset] = 20;
      out[offset + 1] = 20;
      out[offset + 2] = 20;
    } else if (refInk) {
      out[offset] = 220;
      out[offset + 1] = 32;
      out[offset + 2] = 32;
    } else if (svgInk) {
      out[offset] = 32;
      out[offset + 1] = 92;
      out[offset + 2] = 220;
    } else {
      out[offset] = out[offset + 1] = out[offset + 2] = 245;
    }
    out[offset + 3] = 255;
  }
  return out;
}

function sheetPng(left, mid, right, width, height) {
  const gap = 6;
  const label = 16;
  const canvas = document.createElement("canvas");
  canvas.width = width * 3 + gap * 2;
  canvas.height = height + label;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const paint = (data, x) => {
    const image = new ImageData(new Uint8ClampedArray(data), width, height);
    context.putImageData(image, x, label);
  };
  paint(left, 0);
  paint(mid, width + gap);
  paint(right, (width + gap) * 2);
  context.fillStyle = "#222";
  context.font = "12px sans-serif";
  context.fillText("left", 2, 12);
  context.fillText("svg", width + gap + 2, 12);
  context.fillText("diff", (width + gap) * 2 + 2, 12);
  return canvas.toDataURL("image/png");
}

async function postSheet(name, png) {
  await fetch("/__sheet__", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, png })
  });
}

async function run() {
  if (!globalThis.Path2D?.__oiRecording) throw new Error("recording Path2D was not installed before pdf.js");
  const pages = [];
  const cases = [];
  const gateHits = [];
  for (const doc of DOCS) {
    status(`download ${doc.id}`);
    const bytes = new Uint8Array(await (await fetch(`/__pdf__/${doc.file}`)).arrayBuffer());
    const faceDoc = await loadPdf(doc, bytes, false);
    const outlineDoc = await loadPdf(doc, bytes, true);
    try {
      for (const pageNo of doc.pages) {
        status(`${doc.label} p${pageNo}`);
        const facePage = await faceDoc.getPage(pageNo);
        const outlinePage = await outlineDoc.getPage(pageNo);
        const viewport = facePage.getViewport({ scale: 1 });
        const content = await facePage.getTextContent();
        const ops = await facePage.getOperatorList();
        attachFontRealNames(content.items, facePage.commonObjs);
        const built = textLayerToBlocks({
          items: content.items,
          viewport,
          images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
          page: pageNo
        });
        const recorded = await recordPage(outlinePage);
        const formulas = built.blocks.filter((block) => block.label === "formula");
        const buildStarted = performance.now();
        const builtSvgs = formulas.map((block) => {
          const text = blockText({ ...block, page: pageNo }, content.items, viewport);
          const foreignBoxes = foreignGlyphBoxes(block, content.items, viewport);
          const svg = buildFormulaSvg(recorded.context, {
            ...block,
            foreignBoxes,
            pageWidth: viewport.width,
            pageHeight: viewport.height
          });
          return { block, text, svg, gate: gateFor(doc, { ...block, page: pageNo }, text) };
        });
        const buildMs = performance.now() - buildStarted;
        const provenance = {};
        for (const element of recorded.context.elements) {
          provenance[element.provenance] = (provenance[element.provenance] || 0) + 1;
        }
        if (DEBUG) {
          const focus = new Set(["p4-b6", "p4-b8", "p4-b10", "p4-b13"]);
          console.log(JSON.stringify({
            paths: recorded.context.elements.filter((element) => element.provenance === "path").map((element) => ({
              id: element.id,
              op: element.op,
              bbox: element.bbox.map((value) => Math.round(value * 10) / 10),
              lineWidth: element.lineWidth,
              d: element.d.slice(0, 120)
            })),
            focus: builtSvgs.filter((entry) => focus.has(entry.block.id)).map((entry) => ({
              id: entry.block.id,
              text: entry.text,
              bbox: entry.block.bbox,
              glyphBoxes: entry.block.glyphBoxes,
              view: entry.svg.viewBox,
              selected: entry.svg.elements,
              rejected: entry.svg.rejected,
              warnings: entry.svg.warnings
            }))
          }, null, 2));
        }
        pages.push({
          doc: doc.id,
          label: doc.label,
          page: pageNo,
          recordMs: Math.round(recorded.ms * 10) / 10,
          buildMs: Math.round(buildMs * 10) / 10,
          formulaCount: formulas.length,
          elementCount: recorded.context.elements.length,
          svgBytes: builtSvgs.reduce((sum, entry) => sum + entry.svg.bytes, 0),
          unsupported: recorded.context.unsupportedCounts(),
          provenance
        });
        if (DEBUG) continue;
        const faceCanvas = {};
        const outlineCanvas = {};
        for (const zoom of ZOOMS) {
          faceCanvas[zoom] = await renderCanvas(facePage, zoom);
          outlineCanvas[zoom] = await renderCanvas(outlinePage, zoom);
        }
        for (const entry of builtSvgs) {
          const view = entry.svg.viewBox;
          const security = svgSecurityIssues(entry.svg.svg);
          for (const zoom of ZOOMS) {
            const face = cropOf(faceCanvas[zoom], view, zoom);
            const outline = cropOf(outlineCanvas[zoom], view, zoom);
            let svgPixels = null;
            let rasterError = "";
            try {
              svgPixels = await rasterSvg(entry.svg.svg, face.width, face.height);
            } catch (error) {
              rasterError = String(error && error.message || error);
              svgPixels = new Uint8ClampedArray(face.width * face.height * 4);
              svgPixels.fill(255);
            }
            const glyphs = (entry.block.glyphBoxes || [])
              .map((box) => pageBox(box, viewport.width, viewport.height))
              .filter(Boolean)
              .map((box) => toCropBox(box, face.sx, face.sy, zoom));
            const foreign = foreignGlyphBoxes(entry.block, content.items, viewport)
              .map((box) => pageBox(box, viewport.width, viewport.height))
              .map((box) => toCropBox(box, face.sx, face.sy, zoom));
            const glyphMask = maskFromBoxes(face.width, face.height, glyphs, foreign);
            const geometry = (entry.svg.elements || [])
              .map((element) => {
                const pad = element.op === "stroke" ? (Number(element.lineWidth) || 1) / 2 + 0.35 : 0.35;
                const box = element.bbox;
                return [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
              })
              .map((box) => toCropBox(box, face.sx, face.sy, zoom));
            const allowed = maskFromBoxes(face.width, face.height, geometry.length ? geometry : [[0, 0, 0, 0]]);
            const missing = countMissingInk(face.image, svgPixels, face.width, face.height, glyphMask);
            const extra = countExtraInk(svgPixels, face.width, face.height, allowed);
            const outlineDiff = diffStats(face.image, outline.image, face.width, face.height, glyphMask);
            const svgVsOutline = countMissingInk(outline.image, svgPixels, face.width, face.height, glyphMask);
            const row = {
              doc: doc.id,
              label: doc.label,
              page: pageNo,
              id: entry.block.id,
              gate: entry.gate || (NAMED.has(entry.block.id) && doc.id === "2006.11239" ? "report" : ""),
              text: entry.text.slice(0, 180),
              zoom,
              display: entry.block.display !== false && !entry.block.inlineOf,
              missing: missing.missing,
              referenceInk: missing.referenceInk,
              extra: extra.extra,
              svgInk: extra.svgInk,
              outlineMax: Math.round(outlineDiff.max * 10) / 10,
              outlineMean: Math.round(outlineDiff.mean * 100) / 100,
              svgVsOutlineMissing: svgVsOutline.missing,
              bytes: entry.svg.bytes,
              elements: entry.svg.elementCount,
              domElements: entry.svg.domElementCount,
              warnings: entry.svg.warnings,
              security,
              rasterError,
              recordMs: Math.round(recorded.ms * 10) / 10,
              buildMs: Math.round(buildMs * 10) / 10
            };
            cases.push(row);
            if (row.gate) gateHits.push(`${row.gate}:${row.id}`);
            const wantSheet = row.gate || row.missing > 0 || row.extra > 0 || zoom === 1.5;
            if (wantSheet && face.width > 1 && face.height > 1 && face.width * face.height < 2_000_000) {
              const diff = diffImage(face.image, svgPixels, face.width, face.height);
              const png = sheetPng(face.image, svgPixels, diff, face.width, face.height);
              const name = `${doc.label}-p${pageNo}-${entry.block.id}-z${Math.round(zoom * 100)}.png`;
              await postSheet(name, png);
              row.sheet = name;
            }
          }
        }
        for (const zoom of ZOOMS) {
          faceCanvas[zoom].canvas.width = 0;
          faceCanvas[zoom].canvas.height = 0;
          outlineCanvas[zoom].canvas.width = 0;
          outlineCanvas[zoom].canvas.height = 0;
        }
      }
    } finally {
      await faceDoc.destroy();
      await outlineDoc.destroy();
    }
  }
  const result = {
    tolerance: INK_AA_TOLERANCE,
    pages,
    cases,
    gateHits: [...new Set(gateHits)],
    path2d: Boolean(globalThis.Path2D?.__oiRecording)
  };
  status("posting result");
  await fetch("/__result__", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result)
  });
  window.__M0_DONE = true;
  status(`done cases ${cases.length}`);
}

run().catch(async (error) => {
  const message = String(error && error.stack || error);
  console.error(message);
  status(message);
  await fetch("/__result__", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: message })
  });
  window.__M0_DONE = true;
});
