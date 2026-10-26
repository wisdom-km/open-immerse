import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseHTML } from "linkedom";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { NOTES_DRAWER_DOCKED } from "../lib/notes-pane.js";
import {
  applyHeadingMatch,
  currentTocIndex,
  destinationTop,
  drawerShouldDock,
  flattenOutline,
  headingLevel,
  headingsToToc,
  numberBesideTitle,
  partialHint,
  sectionOffsets,
  titleNumber
} from "../lib/drawer-toc.js";
import { drawerInfoModel, formulaNote, recentMeta, recentPapers } from "../lib/drawer-info.js";
import { mountDrawerUi } from "../pdf/drawer-panel.js";
import { LIBRARY_COPY } from "../lib/library-copy.js";

const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);

function contrast(hexA, hexB) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (hex) => {
    const n = hex.replace("#", "");
    const r = lin(parseInt(n.slice(0, 2), 16) / 255);
    const g = lin(parseInt(n.slice(2, 4), 16) / 255);
    const b = lin(parseInt(n.slice(4, 6), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const hi = Math.max(lum(hexA), lum(hexB));
  const lo = Math.min(lum(hexA), lum(hexB));
  return (hi + 0.05) / (lo + 0.05);
}

function panelDom(width = 1440) {
  const parsed = parseHTML(`<!doctype html>
    <button id="tocButton">目录</button>
    <button id="moreButton">更多</button>
    <div id="drawerBackdrop" class="oi-drawer-scrim" hidden></div>
    <div id="drawerSlot" data-drawer hidden></div>`);
  parsed.window.innerWidth = width;
  let active = parsed.document.body;
  const proto = parsed.window.HTMLElement?.prototype;
  if (proto) {
    const orig = proto.focus;
    proto.focus = function focusShim() {
      active = this;
      if (typeof orig === "function") orig.call(this);
    };
  }
  Object.defineProperty(parsed.document, "activeElement", {
    configurable: true,
    get() { return active; }
  });
  return parsed;
}

function memorySession(initial) {
  const bag = new Map(Object.entries(initial || {}));
  return {
    getItem: (key) => (bag.has(key) ? bag.get(key) : null),
    setItem: (key, value) => bag.set(key, String(value))
  };
}

function fakeTimers() {
  let now = 0;
  let id = 1;
  const timeouts = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const handle = id++;
      timeouts.set(handle, { fn, at: now + (Number(ms) || 0) });
      return handle;
    },
    clearTimeout(handle) { timeouts.delete(handle); },
    setInterval() { return id++; },
    clearInterval() {},
    advance(ms) {
      now += ms;
      for (const [handle, item] of [...timeouts]) {
        if (item.at <= now) {
          timeouts.delete(handle);
          item.fn();
        }
      }
    }
  };
}

async function outlineOf(name) {
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const data = new Uint8Array(readFileSync(join(repo, "tests/fixtures", name)));
  const doc = await getDocument({ data, verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  const outline = await doc.getOutline();
  const flat = flattenOutline(outline);
  const cache = new Map();
  for (const entry of flat) {
    const dest = typeof entry.dest === "string" ? await doc.getDestination(entry.dest) : entry.dest;
    if (Array.isArray(dest) && dest[0]) entry.page = (await doc.getPageIndex(dest[0])) + 1;
    if (entry.page && !cache.has(entry.page)) {
      const page = await doc.getPage(entry.page);
      const text = await page.getTextContent();
      cache.set(entry.page, text.items || []);
    }
    const num = numberBesideTitle(cache.get(entry.page) || [], entry.title);
    if (num) entry.num = num;
  }
  const entries = flat.map(({ dest, ...rest }) => rest);
  const pages = doc.numPages;
  await doc.destroy();
  return { entries, pages };
}

test("Attention outline keeps 3.2.1 and does not invent 摘要 or 参考文献", async () => {
  const { entries } = await outlineOf("Attention_Is_All_You_Need.pdf");
  const scaled = entries.find((entry) => entry.title === "Scaled Dot-Product Attention");
  assert.ok(scaled, "missing Scaled Dot-Product Attention");
  assert.equal(scaled.level, 3);
  assert.equal(scaled.num, "3.2.1");
  assert.equal(scaled.page, 4);
  assert.equal(entries.some((entry) => entry.title === "摘要"), false);
  assert.equal(entries.some((entry) => /参考文献/.test(entry.title)), false);
  assert.equal(entries.some((entry) => entry.num), true);
});

test("DPO outline keeps a second level from the tree", async () => {
  const { entries } = await outlineOf("Direct_Preference_Optimization_2305.18290.pdf");
  assert.ok(entries.some((entry) => entry.level === 2), "DPO outline has no level 2");
  assert.equal(entries.some((entry) => entry.title === "摘要"), false);
});

test("heading levels follow the three prefixes, and 3.2 stays level 2", () => {
  const entries = headingsToToc([{
    page: 3,
    blocks: [
      { label: "heading", text: "3 Methods" },
      { label: "heading", text: "3.2 Attention" },
      { label: "heading", text: "3.2.1 Scaled Dot-Product Attention" },
      { label: "heading", text: "Abstract" },
      { label: "heading", text: "References" },
      { label: "heading", text: "A.1 Extra", translation: "附录补充" },
      { label: "text", text: "3.2 not a heading" }
    ]
  }]);
  assert.deepEqual(entries.map((entry) => [entry.num, entry.level, entry.title]), [
    ["3", 1, "Methods"],
    ["3.2", 2, "Attention"],
    ["3.2.1", 3, "Scaled Dot-Product Attention"],
    ["", 1, "Abstract"],
    ["", 1, "References"],
    ["A.1", 2, "附录补充"]
  ]);
  assert.equal(headingLevel("3.2"), 2);
  assert.equal(headingLevel("3.2.1"), 3);
  assert.equal(titleNumber("A.1 Extra"), "A.1");
});

test("outline numbers prefer the matched heading, then the title, otherwise stay empty", () => {
  const entries = applyHeadingMatch([
    { level: 3, title: "Scaled Dot-Product Attention", original: "Scaled Dot-Product Attention", page: 4, num: "" },
    { level: 1, title: "3 Background", original: "3 Background", page: 2, num: "" },
    { level: 1, title: "Thanks", original: "Thanks", page: 9, num: "" }
  ], [
    { page: 4, text: "3.2.1 Scaled Dot-Product Attention", translation: "缩放点积注意力" }
  ]);
  assert.equal(entries[0].num, "3.2.1");
  assert.equal(entries[0].title, "缩放点积注意力");
  assert.equal(entries[0].translated, true);
  assert.equal(entries[1].num, "3");
  assert.equal(entries[1].translated, false);
  assert.equal(entries[2].num, "");
});

test("current section treats the boundary as the entry that starts there", () => {
  const entries = [{ page: 2 }, { page: 4 }, { page: 6 }];
  assert.equal(currentTocIndex(entries, 4), 1);
  assert.equal(currentTocIndex(entries, 1), -1);
  assert.equal(currentTocIndex(entries, 9), 2);
  assert.equal(currentTocIndex([], 4), -1);
});

test("reading line stays on the previous section until the next heading", () => {
  const pages = [
    { page: 3, top: 200, height: 800 },
    { page: 4, top: 1000, height: 800 },
    { page: 5, top: 1800, height: 800 }
  ];
  const entries = [
    { page: 3, destY: 117.119, pageHeight: 792 },
    { page: 4, destY: 447.529, pageHeight: 792 },
    { page: 4, destY: 166.913, pageHeight: 792 },
    { page: 5, destY: 518.313, pageHeight: 792 },
    { page: 5, destY: 301.225, pageHeight: 792 },
    { page: 5, destY: 149.573, pageHeight: 792 }
  ];
  const placed = entries.map((entry, index) => ({ ...entry, offset: sectionOffsets(entries, pages)[index] }));
  assert.equal(currentTocIndex(placed, 1005), 0);
  assert.equal(currentTocIndex(placed, 1805), 2);
  const past = 1800 + ((792 - 518.313) / 792) * 800 + 4;
  assert.equal(currentTocIndex(placed, past), 3);
  assert.equal(destinationTop([{}, { name: "XYZ" }, 108, 447.529, null]), 447.529);
  assert.equal(destinationTop([{}, { name: "FitH" }, 720]), 720);
  assert.equal(destinationTop(["page"]), null);
});

test("title prefixes do not eat words, and a matched heading number wins", () => {
  assert.equal(titleNumber("A Simple Baseline"), "");
  assert.equal(titleNumber("A Closer Look at Attention"), "");
  assert.equal(titleNumber("2D Convolutions"), "");
  assert.equal(titleNumber("E. coli results"), "");
  assert.equal(titleNumber("I Introduction"), "");
  assert.equal(titleNumber("A. Appendix title"), "A");
  assert.equal(titleNumber("3.2.1 Scaled Dot-Product Attention"), "3.2.1");
  const unified = applyHeadingMatch([
    { level: 1, title: "A Unified View", original: "A Unified View", page: 3, num: "" }
  ], [
    { page: 3, text: "5 A Unified View", translation: "统一视角" }
  ]);
  assert.equal(unified[0].num, "5");
  assert.equal(unified[0].title, "统一视角");
  assert.equal(unified[0].translated, true);
  const overridden = applyHeadingMatch([
    { level: 1, title: "1 Methods", original: "1 Methods", page: 2, num: "9" }
  ], [
    { page: 2, text: "2 Methods", translation: "" }
  ]);
  assert.equal(overridden[0].num, "2");
  const kept = applyHeadingMatch([
    { level: 1, title: "A Simple Baseline", original: "A Simple Baseline", page: 3, lineNum: "4", lineMatched: true }
  ], []);
  assert.equal(kept[0].num, "4");
  assert.equal(kept[0].title, "A Simple Baseline");
  const blocked = applyHeadingMatch([
    { level: 1, title: "Thanks", original: "Thanks", page: 1, num: "9" }
  ], []);
  assert.equal(blocked[0].num, "");
  const afterHeading = applyHeadingMatch([
    { level: 1, title: "Thanks", original: "Thanks", page: 1, lineNum: "4" }
  ], [
    { page: 1, text: "Thanks" }
  ]);
  assert.equal(afterHeading[0].num, "4");
  const headingWins = applyHeadingMatch([
    { level: 1, title: "Thanks", original: "Thanks", page: 1, lineNum: "9", lineMatched: true }
  ], [
    { page: 1, text: "2 Thanks" }
  ]);
  assert.equal(headingWins[0].num, "2");
});

test("standalone same-line number shows, and (3) does not", () => {
  const title = "Scaled Dot-Product Attention";
  const y = 433;
  const titleItem = { str: title, x: 138, y, width: 126, height: 10 };
  assert.equal(numberBesideTitle([
    { str: "3.2.1", x: 108, y, width: 20, height: 10 },
    titleItem
  ], title), "3.2.1");
  assert.equal(numberBesideTitle([
    { str: "(3)", x: 108, y, width: 14, height: 10 },
    titleItem
  ], title, { pageHeight: 792 }), "");
  assert.equal(numberBesideTitle([
    { str: "IV", x: 108, y, width: 14, height: 10 },
    titleItem
  ], title), "");
  assert.equal(numberBesideTitle([
    { str: "I", x: 108, y, width: 8, height: 10 },
    titleItem
  ], title), "I");
  assert.equal(numberBesideTitle([
    { str: "C", x: 108, y, width: 8, height: 10 },
    titleItem
  ], title), "C");
  assert.equal(numberBesideTitle([
    { str: "D", x: 108, y, width: 8, height: 10 },
    titleItem
  ], title), "D");
  assert.equal(numberBesideTitle([
    { str: "II", x: 108, y, width: 12, height: 10 },
    titleItem
  ], title), "");
  assert.equal(numberBesideTitle([
    { str: "XI", x: 108, y, width: 12, height: 10 },
    titleItem
  ], title), "");
  assert.equal(numberBesideTitle([
    { str: "A.1", x: 108, y, width: 16, height: 10 },
    titleItem
  ], title), "A.1");
  assert.equal(numberBesideTitle([
    { str: "3.2.1.", x: 108, y, width: 24, height: 10 },
    { str: title, x: 140, y, width: 126, height: 10 }
  ], title), "3.2.1");
  assert.equal(numberBesideTitle([
    { str: "4", x: 108, y: 20, width: 8, height: 10 },
    { str: title, x: 138, y: 20, width: 126, height: 10 }
  ], title, { pageHeight: 792 }), "");
  assert.equal(numberBesideTitle([
    titleItem,
    { str: "(1)", x: 280, y, width: 14, height: 10 }
  ], title), "");
  assert.equal(numberBesideTitle([
    { str: "3.2.1", x: 108, y: y + 8, width: 20, height: 10 },
    titleItem
  ], title), "");
  assert.equal(numberBesideTitle([
    { str: "4", x: 300, y: 30, width: 8, height: 10 },
    { str: "3.2.1", x: 108, y: 400, width: 20, height: 10 },
    { str: title, x: 138, y: 400, width: 126, height: 10 }
  ], title, { pageHeight: 792 }), "3.2.1");
  const { document } = panelDom();
  const ui = mountDrawerUi({
    slot: document.getElementById("drawerSlot"),
    backdrop: document.getElementById("drawerBackdrop"),
    session: memorySession(),
    width: () => 1200,
    mode: () => "dock"
  });
  ui.open();
  ui.setToc({
    source: "outline",
    loading: false,
    partial: "",
    entries: [{ level: 3, num: "3.2.1", title, page: 4 }]
  });
  assert.equal(ui.root.classList.contains("is-unnumbered"), false);
  assert.equal(ui.root.querySelector(".oi-toc-num")?.textContent, "3.2.1");
});

test("partial hint names the unfinished pages and disappears when layout is done", () => {
  assert.equal(partialHint(7, 15), "后面的小节等页面排版好后出现（7 / 15 页）");
  assert.equal(partialHint(15, 15), "");
  assert.equal(partialHint(0, 0), "");
});

test("docking uses the live source width, a 24px hysteresis, and full screen below 900", () => {
  assert.equal(drawerShouldDock({ windowWidth: 2200, sourceWidth: 1096, sideSlot: 0, docked: false }), true);
  assert.equal(drawerShouldDock({ windowWidth: 1100, sourceWidth: 400, sideSlot: 0, docked: false }), false);
  assert.equal(drawerShouldDock({ windowWidth: 800, sourceWidth: 0, sideSlot: 0, docked: false }), false);
  const edge = { windowWidth: 1600, sourceWidth: 400, sideSlot: 360, docked: false };
  const openSpace = 1600 - 400 - 8 - 288 - (8 + 360);
  assert.equal(openSpace >= 618, drawerShouldDock(edge));
  assert.equal(drawerShouldDock({ windowWidth: 1313, sourceWidth: 400, sideSlot: 0, docked: false }), false);
  assert.equal(drawerShouldDock({ windowWidth: 1314, sourceWidth: 400, sideSlot: 0, docked: false }), true);
  assert.equal(drawerShouldDock({ windowWidth: 1290, sourceWidth: 400, sideSlot: 0, docked: true }), true);
  assert.equal(drawerShouldDock({ windowWidth: 1289, sourceWidth: 400, sideSlot: 0, docked: true }), false);
  assert.equal(drawerShouldDock({ windowWidth: 1290, sourceWidth: 400, sideSlot: 0, docked: false }), false);
});

test("info counts hide zero rows, surface multimodal, and never name a service", () => {
  const model = drawerInfoModel({
    pageCount: 15,
    pageStates: [{ state: "done" }, { state: "partial" }, { state: "queued" }, { state: "skipped" }],
    layouts: [
      { blocks: [{ label: "formula", formulaTier: "arxiv" }, { label: "formula", formulaTier: "arxiv" }] },
      { blocks: [{ label: "formula", formulaTier: "crop" }, { label: "text", text: "hello" }] },
      null
    ],
    storedPages: 4,
    bytes: 2 * 1024 * 1024,
    persisted: true,
    hasSource: false
  });
  assert.equal(model.progress, "已译 2/15 · 有页没译完");
  assert.deepEqual(model.formulaRows.map((row) => row.key), ["arxiv", "crop"]);
  assert.equal(model.formulaRows.find((row) => row.key === "arxiv").count, 2);
  assert.equal(model.note, "arXiv 源码的公式和原文一致；裁图和占位卡点一下就能看原文。");
  assert.equal(model.storage[1].text, "浏览器清理空间时：会保留");
  assert.equal(model.storage[2].text, "原 PDF 副本：没有");
  assert.equal(JSON.stringify(model).includes("provider"), false);
  assert.equal(JSON.stringify(model).includes("model"), false);
  const multi = drawerInfoModel({
    pageCount: 2,
    layouts: [{ blocks: [{ formulaTier: "multimodal" }, { formulaTier: "placeholder" }] }]
  });
  assert.deepEqual(multi.formulaRows.map((row) => row.key), ["multimodal", "placeholder"]);
  assert.equal(formulaNote({ arxiv: 2, multimodal: 0, crop: 0, placeholder: 0 }), "arXiv 源码的公式和原文一致。");
  assert.equal(formulaNote({ arxiv: 0, crop: 1, placeholder: 0 }), "裁图和占位卡点一下就能看原文。");
  assert.equal(formulaNote({ arxiv: 0, crop: 0, placeholder: 0, multimodal: 0 }), "");
  const empty = drawerInfoModel({ pageCount: 1, layouts: [{ blocks: [{ formulaTier: "arxiv" }] }], persisted: false, hasSource: true });
  assert.equal(empty.note, "arXiv 源码的公式和原文一致。");
  assert.equal(empty.storage[1].text.includes("可能被清理"), true);
  assert.equal(empty.storage[2].text.includes("已存在本机"), true);
});

test("recent papers keep 15 others, drop the current hash, and omit size", () => {
  const papers = [];
  for (let n = 0; n < 16; n += 1) {
    papers.push({ docHash: `h${n}`, title: `论文 ${n}`, lastOpenedAt: n, pageCount: 10, pagesTranslated: n, sourceSize: 99999 });
  }
  papers.push({ docHash: "current", title: "当前", lastOpenedAt: 100, pageCount: 10, sourceSize: 50 });
  papers.push({ docHash: "gone", title: "已删", lastOpenedAt: 90, deletedAt: 1 });
  const rows = recentPapers(papers, "current", 15);
  assert.equal(rows.length, 15);
  assert.equal(rows.some((row) => row.docHash === "current"), false);
  assert.equal(rows[0].docHash, "h15");
  assert.equal(rows.at(-1).docHash, "h1");
  const meta = recentMeta({ translated: 2, pageCount: 10, lastOpenedAt: Date.now(), sourceSize: 4096 });
  assert.equal(meta.includes("已译 2 / 10 页"), true);
  assert.equal(/MB|KB|字节|B\b/.test(meta), false);
  assert.equal(recentPapers([], "current").length, 0);
});

test("drawer tabs keep their own scroll and the session tab", () => {
  const { document, window } = panelDom();
  const session = memorySession();
  const ui = mountDrawerUi({
    slot: document.getElementById("drawerSlot"),
    backdrop: document.getElementById("drawerBackdrop"),
    session,
    width: () => 1440,
    mode: () => "dock"
  });
  ui.open({ trigger: document.getElementById("tocButton") });
  ui.setToc({
    source: "headings",
    loading: false,
    partial: partialHint(7, 15),
    entries: Array.from({ length: 12 }, (_, index) => ({ level: 1, num: "", title: `节 ${index}`, page: index + 1 }))
  });
  const scroller = ui.root.querySelector(".oi-drawer-scroll");
  scroller.scrollTop = 48;
  ui.setTab("info");
  assert.equal(ui.root.querySelector(".oi-drawer-scroll").scrollTop, 0);
  ui.setTab("toc");
  assert.equal(ui.scrollTop("toc"), 48);
  assert.match(ui.root.textContent, /后面的小节等页面排版好后出现（7 \/ 15 页）/);
  ui.setTab("recent");
  assert.equal(document.getElementById("tocButton").getAttribute("aria-pressed"), "true");
  ui.close();
  assert.equal(document.getElementById("tocButton").getAttribute("aria-pressed"), "false");
  const again = mountDrawerUi({
    slot: document.getElementById("drawerSlot"),
    backdrop: document.getElementById("drawerBackdrop"),
    session,
    width: () => 1440,
    mode: () => "float"
  });
  again.open();
  assert.equal(again.tab(), "recent");
  assert.equal(again.root.getAttribute("role"), "dialog");
  assert.equal(again.root.getAttribute("aria-modal"), "true");
  again.setMode("dock");
  assert.equal(again.root.getAttribute("role"), "complementary");
  assert.equal(again.root.hasAttribute("aria-modal"), false);
  again.close();
});

test("opening focuses the current section, and tab stays inside the dialog", () => {
  const parsed = parseHTML("<!doctype html><html><body></body></html>");
  const { document, window } = parsed;
  document.body.innerHTML = `<button id="tocButton">目录</button><button id="moreButton">更多</button><div id="drawerBackdrop" hidden></div><div id="workspace" class="workspace"><div id="pdfPane"></div><div id="drawerSlot"></div></div>`;
  let active = document.body;
  const proto = window.HTMLElement?.prototype;
  if (proto) {
    const orig = proto.focus;
    proto.focus = function focusShim() {
      active = this;
      if (typeof orig === "function") orig.call(this);
    };
  }
  Object.defineProperty(document, "activeElement", { configurable: true, get() { return active; } });
  const ui = mountDrawerUi({
    slot: document.getElementById("drawerSlot"),
    backdrop: document.getElementById("drawerBackdrop"),
    session: memorySession(),
    width: () => 1100,
    mode: () => "float",
    currentIndex: () => 1
  });
  ui.setToc({
    source: "outline",
    loading: false,
    partial: "",
    entries: [
      { level: 1, num: "3.2.1", title: "Scaled Dot-Product Attention", page: 4 },
      { level: 1, num: "3.2.3", title: "Applications of Attention in our Model", page: 5 }
    ]
  });
  ui.open({ trigger: document.getElementById("tocButton") });
  assert.equal(ui.root.tagName, "DIV");
  assert.equal(ui.root.getAttribute("role"), "dialog");
  assert.equal(document.activeElement?.getAttribute("data-toc-index"), "1");
  assert.equal(document.activeElement?.getAttribute("aria-current"), "location");
  assert.equal(document.getElementById("tocButton").inert, true);
  assert.equal(document.getElementById("pdfPane").inert, true);
  assert.equal(document.getElementById("drawerSlot").inert, false);
  const items = [...ui.root.querySelectorAll("button")].filter((node) => {
    if (node.disabled || node.hidden) return false;
    const attr = node.getAttribute("tabindex");
    return attr == null || Number(attr) >= 0;
  });
  const last = items[items.length - 1];
  const first = items[0];
  last.focus();
  const tab = new window.Event("keydown", { bubbles: true, cancelable: true });
  tab.key = "Tab";
  last.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(document.activeElement, first);
  ui.close();
  assert.equal(document.getElementById("tocButton").inert, false);
});

test("escape skips a toolbar button that is only hidden by CSS", () => {
  const { document, window } = panelDom();
  const button = document.getElementById("tocButton");
  const original = window.getComputedStyle?.bind(window);
  window.getComputedStyle = (node) => {
    if (node === button) return { display: "none", visibility: "visible" };
    return original ? original(node) : { display: "block", visibility: "visible" };
  };
  const ui = mountDrawerUi({
    slot: document.getElementById("drawerSlot"),
    backdrop: document.getElementById("drawerBackdrop"),
    session: memorySession(),
    width: () => 1100,
    mode: () => "float"
  });
  ui.open({ trigger: button });
  ui.consumeEscape();
  assert.equal(document.activeElement.id, "moreButton");
});

test("a papers refresh keeps the recent scroll and does not flash a skeleton", async () => {
  const { document } = panelDom();
  const timers = fakeTimers();
  let generation = 0;
  const ui = mountDrawerUi({
    slot: document.getElementById("drawerSlot"),
    backdrop: document.getElementById("drawerBackdrop"),
    session: memorySession({ "oi.drawer.tab": "recent" }),
    width: () => 1400,
    mode: () => "dock",
    timers,
    async recent() {
      generation += 1;
      return Array.from({ length: 12 }, (_, index) => ({
        docHash: `h${index}`,
        title: `论文 ${index} ${generation}`,
        pageCount: 8,
        translated: 1,
        lastOpenedAt: Date.UTC(2026, 9, 23, 8, index)
      }));
    },
    async openPaper() {
      return { status: "missing", hash: "h0" };
    }
  });
  ui.open();
  await new Promise((done) => setTimeout(done, 0));
  await new Promise((done) => setTimeout(done, 0));
  const scroller = ui.root.querySelector(".oi-drawer-scroll");
  scroller.scrollTop = 120;
  const before = generation;
  ui.refresh();
  ui.refresh();
  assert.equal(ui.root.querySelector(".oi-drawer-skel"), null);
  assert.equal(scroller.scrollTop, 120);
  assert.equal(generation, before);
  timers.advance(160);
  await new Promise((done) => setTimeout(done, 0));
  await new Promise((done) => setTimeout(done, 0));
  const next = ui.root.querySelector(".oi-drawer-scroll");
  assert.equal(ui.root.querySelector(".oi-drawer-skel"), null);
  assert.equal(next.scrollTop, 120);
  assert.equal(generation, before + 1);
  ui.root.querySelector(".oi-recent-row").click();
  await new Promise((done) => setTimeout(done, 0));
  assert.match(ui.root.textContent, /没能打开 PDF，稍后再试一次。/);
});

test("a closed drawer reloads info on open after papers change, without a skeleton", async () => {
  const { document } = panelDom();
  const timers = fakeTimers();
  let infoCalls = 0;
  let progress = "已译 1 / 10 页";
  const ui = mountDrawerUi({
    slot: document.getElementById("drawerSlot"),
    backdrop: document.getElementById("drawerBackdrop"),
    session: memorySession({ "oi.drawer.tab": "info" }),
    width: () => 1400,
    mode: () => "dock",
    timers,
    async info() {
      infoCalls += 1;
      return { progress, formulaRows: [], storage: [], note: "", laidOut: 2 };
    }
  });
  ui.open();
  await new Promise((done) => setTimeout(done, 0));
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(infoCalls, 1);
  assert.match(ui.root.textContent, /已译 1 \/ 10 页/);
  ui.close();
  progress = "已译 4 / 10 页";
  ui.refresh();
  timers.advance(160);
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(infoCalls, 1);
  assert.equal(ui.root.querySelector(".oi-drawer-skel"), null);
  ui.open();
  await new Promise((done) => setTimeout(done, 0));
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(infoCalls, 2);
  assert.equal(ui.root.querySelector(".oi-drawer-skel"), null);
  assert.match(ui.root.textContent, /已译 4 \/ 10 页/);
});

test("empty TOC copy, unnumbered column, and escape focus", () => {
  const { document } = panelDom();
  const ui = mountDrawerUi({
    slot: document.getElementById("drawerSlot"),
    backdrop: document.getElementById("drawerBackdrop"),
    session: memorySession(),
    width: () => 1200,
    mode: () => "float"
  });
  ui.open({ trigger: document.getElementById("tocButton") });
  ui.setToc({ source: "outline", entries: [], partial: "", loading: false });
  assert.match(ui.root.textContent, /这篇没有可用的目录/);
  assert.match(ui.root.textContent, /在原文里滚动阅读即可。/);
  ui.setToc({
    source: "outline",
    entries: [{ level: 1, num: "", title: "Introduction", page: 1 }],
    partial: "",
    loading: false
  });
  assert.equal(ui.root.classList.contains("is-unnumbered"), true);
  assert.equal(ui.root.querySelector(".oi-toc-num"), null);
  document.getElementById("tocButton").hidden = true;
  ui.consumeEscape();
  assert.equal(document.activeElement.id, "moreButton");
  assert.equal(ui.isOpen(), false);
});

test("recent row shows download and failure copy, and info blocks a closed store", async () => {
  const { document } = panelDom();
  const timers = fakeTimers();
  let openCalls = 0;
  const ui = mountDrawerUi({
    slot: document.getElementById("drawerSlot"),
    backdrop: document.getElementById("drawerBackdrop"),
    session: memorySession({ "oi.drawer.tab": "recent" }),
    width: () => 1400,
    mode: () => "dock",
    timers,
    now: () => Date.UTC(2026, 9, 23, 9, 0),
    async recent() {
      return [
        { docHash: "a", title: "甲", pageCount: 4, translated: 1, lastOpenedAt: Date.UTC(2026, 9, 23, 8, 0), sourceSize: 2048 },
        { docHash: "b", title: "乙", pageCount: 4, translated: 4, lastOpenedAt: Date.UTC(2026, 9, 22, 8, 0), sourceSize: 4096 }
      ];
    },
    async openPaper(hash, options) {
      openCalls += 1;
      options.onStatus?.({ status: "downloading", hash });
      return { status: "failed", hash };
    },
    async info() {
      const error = new Error("blocked");
      error.name = "BlockedError";
      throw error;
    }
  });
  ui.open();
  await new Promise((done) => setTimeout(done, 0));
  await new Promise((done) => setTimeout(done, 0));
  const text = ui.root.textContent;
  assert.match(text, /甲/);
  assert.match(text, /乙/);
  assert.equal(text.includes("2048"), false);
  assert.equal(/MB|KB/.test(ui.root.querySelector(".oi-recent-meta")?.textContent || ""), false);
  assert.equal(ui.root.querySelectorAll(".oi-recent-row").length, 2);
  ui.root.querySelector(".oi-recent-row").click();
  await new Promise((done) => setTimeout(done, 0));
  assert.match(ui.root.textContent, /没能打开 PDF，稍后再试一次。/);
  timers.advance(4000);
  assert.equal(/没能打开/.test(ui.root.querySelector(".oi-recent-meta")?.textContent || ""), false);
  assert.equal(openCalls, 1);
  ui.setTab("info");
  await new Promise((done) => setTimeout(done, 0));
  assert.match(ui.root.textContent, new RegExp(LIBRARY_COPY.blockedTitle));
});

test("drawer tokens match the notes hook and stay on reader colors", () => {
  const css = readFileSync(join(repo, "pdf/reader-tokens.css"), "utf8");
  const drawerCss = readFileSync(join(repo, "pdf/drawer-panel.css"), "utf8");
  const match = css.match(/--oi-reader-drawer-w:\s*(\d+)px/);
  assert.equal(Number(match?.[1]), NOTES_DRAWER_DOCKED);
  assert.equal(NOTES_DRAWER_DOCKED, 288);
  assert.match(css, /--oi-reader-drawer-scrim:\s*var\(--oi-reader-track\)/);
  assert.equal(css.match(/--oi-reader-fig-card-h:/g)?.length || 0, 1);
  assert.equal(css.match(/--oi-reader-fig-card-min-w:/g)?.length || 0, 1);
  assert.equal(/--oi-warn\b/.test(drawerCss), false);
  assert.equal(/body\.oi-settings/.test(drawerCss), false);
  const pick = (name) => {
    const found = css.match(new RegExp(`--oi-reader-${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(found, name);
    return found[1];
  };
  for (const theme of ["warm", "white", "sepia", "green"]) {
    const surface = pick(`${theme}-surface`);
    assert.ok(contrast(pick(`${theme}-muted`), surface) >= 4.5, theme);
    assert.ok(contrast(pick(`${theme}-ink-2`), surface) >= 4.5, theme);
  }
  const dark = css.slice(css.indexOf('[data-reader-theme="dark"]'));
  const darkHex = (name) => {
    const found = dark.match(new RegExp(`--oi-reader-${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(found, name);
    return found[1];
  };
  assert.ok(contrast(darkHex("muted"), darkHex("surface")) >= 4.5);
  assert.ok(contrast(darkHex("ink-2"), darkHex("surface")) >= 4.5);
});

test("viewer keeps init last and wires Shift+T beside the single-key switch", () => {
  const viewer = readFileSync(join(repo, "pdf/viewer.js"), "utf8");
  assert.equal(viewer.trimEnd().endsWith("init();"), true);
  const shift = viewer.slice(viewer.indexOf('event.key === "N"'), viewer.indexOf('event.key === "M"'));
  assert.match(shift, /event\.key === "T"/);
  assert.match(shift, /singleKey !== false/);
  const panels = viewer.slice(viewer.indexOf("function bindViewChrome"), viewer.indexOf("function readerWidth"));
  assert.match(panels, /drawerUi\?\.toggle/);
  assert.doesNotMatch(panels, /showSoonToast/);
  const library = readFileSync(join(repo, "lib/pdf-library.js"), "utf8").split("\n");
  assert.match(library[13], /diagLog/);
  assert.match(library[14], /libraryLoadedAt, libraryReviveAllowed, libraryWritesStopped/);
});
