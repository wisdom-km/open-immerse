/**
 * Contact sheet: left outline crop | baseline SVG | diff.
 *
 *   node scripts/contact-sheet.mjs --paper 1706.03762 --page 4
 *
 * PNGs go to labels/sheets/, which is gitignored.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildFormulaRuns, buildFormulaSvg, foreignGlyphBoxes, pageBox } from "../lib/formula-svg.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { countMissingInkFullCrop } from "../lib/label-checks.js";
import { openDocuments, rasterPage, readPageContent, recordOutline } from "./m1-pdf.mjs";

const require = createRequire(import.meta.url);
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function unitBox(unit, byId) {
  const boxes = unit.elementIds.map((id) => byId.get(id)?.bbox).filter(Boolean);
  return [
    Math.min(...boxes.map((box) => box[0])) - 2,
    Math.min(...boxes.map((box) => box[1])) - 2,
    Math.max(...boxes.map((box) => box[2])) + 2,
    Math.max(...boxes.map((box) => box[3])) + 2
  ];
}

function darkAt(data, width, x, y) {
  if (x < 0 || y < 0) return false;
  const height = data.length / 4 / width;
  if (x >= width || y >= height) return false;
  const offset = (y * width + x) * 4;
  const luma = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
  return luma < 210;
}

export async function renderContactSheet({ paperId, pageNumber, pdfPath, label }) {
  const { createCanvas, loadImage } = require("@napi-rs/canvas");
  const bytes = readFileSync(pdfPath);
  const { face, outline } = await openDocuments(bytes);
  try {
    const facePage = await face.getPage(pageNumber);
    const content = await readPageContent(facePage);
    const recorded = await recordOutline(await outline.getPage(pageNumber));
    const raster = await rasterPage(await outline.getPage(pageNumber), 1);
    const built = textLayerToBlocks({
      items: content.text.items,
      viewport: content.viewport,
      images: { fnArray: content.ops.fnArray, argsArray: content.ops.argsArray },
      page: pageNumber
    });
    const blocks = (built.blocks || []).filter((block) => block.label === "formula");
    const svgs = [];
    for (const block of blocks) {
      const svg = buildFormulaSvg(recorded.context, {
        ...block,
        foreignBoxes: foreignGlyphBoxes(block, content.text.items, content.viewport),
        runs: buildFormulaRuns(content.text.items, content.viewport, block),
        pageWidth: content.viewport.width,
        pageHeight: content.viewport.height
      });
      svgs.push({ block, svg });
    }
    const byId = new Map(label.elements.map((element) => [element.id, element]));
    const dir = join(root, "labels/sheets", paperId);
    mkdirSync(dir, { recursive: true });
    const files = [];
    let index = 0;
    for (const unit of label.units) {
      index += 1;
      const box = unitBox(unit, byId);
      const x0 = Math.max(0, Math.floor(box[0]));
      const y0 = Math.max(0, Math.floor(box[1]));
      const x1 = Math.min(raster.width, Math.ceil(box[2]));
      const y1 = Math.min(raster.height, Math.ceil(box[3]));
      const width = Math.max(1, x1 - x0);
      const height = Math.max(1, y1 - y0);
      if (width * height > 1_500_000) continue;
      let best = null;
      let bestArea = 0;
      for (const entry of svgs) {
        const blockBox = pageBox(entry.block.bbox, content.viewport.width, content.viewport.height);
        const overlapW = Math.min(blockBox[2], box[2]) - Math.max(blockBox[0], box[0]);
        const overlapH = Math.min(blockBox[3], box[3]) - Math.max(blockBox[1], box[1]);
        const area = overlapW > 0 && overlapH > 0 ? overlapW * overlapH : 0;
        if (area > bestArea) {
          bestArea = area;
          best = entry;
        }
      }
      const left = raster.context.getImageData(x0, y0, width, height);
      const svgCanvas = createCanvas(width, height);
      const svgCtx = svgCanvas.getContext("2d");
      svgCtx.fillStyle = "#ffffff";
      svgCtx.fillRect(0, 0, width, height);
      if (best?.svg.svg && best.svg.viewBox?.width > 0) {
        const image = await loadImage(Buffer.from(best.svg.svg));
        svgCtx.drawImage(image, best.svg.viewBox.x - x0, best.svg.viewBox.y - y0, best.svg.viewBox.width, best.svg.viewBox.height);
      }
      const right = svgCtx.getImageData(0, 0, width, height);
      const diff = createCanvas(width, height);
      const diffCtx = diff.getContext("2d");
      const image = diffCtx.createImageData(width, height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          const leftDark = left.data[offset] < 160;
          let covered = false;
          if (leftDark) {
            for (let dy = -1; dy <= 1 && !covered; dy += 1) {
              for (let dx = -1; dx <= 1; dx += 1) {
                if (darkAt(right.data, width, x + dx, y + dy)) {
                  covered = true;
                  break;
                }
              }
            }
          }
          const svgDark = right.data[offset] < 160;
          image.data[offset + 3] = 255;
          if (leftDark && !covered) {
            image.data[offset] = 220;
            image.data[offset + 1] = 40;
            image.data[offset + 2] = 40;
          } else if (svgDark && !leftDark) {
            image.data[offset] = 40;
            image.data[offset + 1] = 90;
            image.data[offset + 2] = 220;
          } else {
            image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = leftDark ? 20 : 255;
          }
        }
      }
      diffCtx.putImageData(image, 0, 0);
      const sheet = createCanvas(width * 3 + 16, height);
      const ctx = sheet.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, sheet.width, sheet.height);
      const leftCanvas = createCanvas(width, height);
      leftCanvas.getContext("2d").putImageData(left, 0, 0);
      ctx.drawImage(leftCanvas, 0, 0);
      ctx.drawImage(svgCanvas, width + 8, 0);
      ctx.drawImage(diff, width * 2 + 16, 0);
      const name = `page-${String(pageNumber).padStart(3, "0")}-u${String(index).padStart(3, "0")}.png`;
      const dest = join(dir, name);
      writeFileSync(dest, sheet.toBuffer("image/png"));
      const ink = countMissingInkFullCrop(left.data, right.data, width, height);
      files.push({ file: dest, unitId: unit.id, missing: ink.missing, solid: ink.solid });
    }
    return files;
  } finally {
    await face.destroy();
    await outline.destroy();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const paperId = arg("--paper");
  const pageNumber = Number(arg("--page") || "1");
  const pdfPath = join(root, "corpus/pdfs", `${paperId}.pdf`);
  const labelPath = join(root, "labels/prelabel", paperId, `page-${String(pageNumber).padStart(3, "0")}.json`);
  renderContactSheet({
    paperId,
    pageNumber,
    pdfPath,
    label: JSON.parse(readFileSync(labelPath, "utf8"))
  }).then((files) => {
    console.log(files.map((file) => file.file).join("\n"));
  }).catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
