// 顶栏中线硬规则（TBR-01 / 02 / 03 / 04 / 08 / 11）。
//
// 新按钮上栏前的 4 条检查（也写在 CONTRIBUTING.md）：
// 1. 归入 data-tb=icon | text | status，高 30、相对顶栏 top 9。
// 2. 盒子中线 y=24±0.5；DPR1 下 left/top/width/height 为整数。带文字的宽度在挂载和 fonts loadingdone 时向上取整。
// 3. 同组（类型 + 字号 + 光学修正）文字基线差 ≤ 0.5。页码 .pager-ink 的 -1.5px 单独成组。
// 4. 焦点框不被 overflow 裁切，且完整落在视口内。
//
// 本测试遍历 .toolbar 下所有可见控件，不写 id 允许名单。
// 临时把底线改回 border-bottom:1px 且栏高仍是 48 时，top 会变成 8.5，这里必须失败。
//
// Local gitignored fixture: tests/fixtures/Attention_Is_All_You_Need.pdf
// arXiv v7 (15 pages), https://arxiv.org/pdf/1706.03762v7
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const TOPBAR_TMP_PREFIXES = ["oi-topbar-chrome-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(TOPBAR_TMP_PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
const THEMES = ["warm", "white", "sepia", "green"];
const WIDTHS = [1440, 1100];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json"
};

const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[data-tb]",
  "[role='button']",
  "[role='switch']",
  "[role='menuitem']",
  "[role='status']"
].join(", ");

function serveRepo() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = resolve(root, rel);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "content-type": MIME[extname(file)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function launchChrome(userDataDir, scratchDir) {
  const child = spawn("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-pipe",
    "--force-device-scale-factor=1",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,900",
    "--no-first-run",
    "--no-default-browser-check"
  ], {
    detached: true,
    env: {
      ...process.env,
      TMPDIR: scratchDir,
      TMP: scratchDir,
      TEMP: scratchDir
    },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]
  });
  child.stderr.on("data", () => {});
  child.stdio[3].on("error", () => {});
  child.stdio[4].on("error", () => {});
  return child;
}

class PipeCdp {
  constructor(writeStream, readStream) {
    this.writeStream = writeStream;
    this.readStream = readStream;
    this.buf = Buffer.alloc(0);
    this.next = 1;
    this.pending = new Map();
    readStream.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
  }

  drain() {
    while (this.buf.length) {
      const end = this.buf.indexOf(0);
      if (end < 0) return;
      const text = this.buf.subarray(0, end).toString("utf8");
      this.buf = this.buf.subarray(end + 1);
      if (!text) continue;
      const message = JSON.parse(text);
      if (message.id && this.pending.has(message.id)) {
        const { done, reject, timer } = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
        else done(message.result);
      }
    }
  }

  dispose() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const body = Buffer.from(`${JSON.stringify(payload)}\0`, "utf8");
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, { done, reject, timer });
      this.writeStream.write(body);
    });
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function wholePx(value) {
  return Math.abs(value - Math.round(value)) <= 0.05;
}

function geometryProblems(sample) {
  const problems = [];
  const { bar, controls, dpr } = sample;
  if (dpr !== 1) problems.push(`devicePixelRatio ${dpr}`);
  if (Math.abs(bar.top) > 0.05) problems.push(`toolbar top ${bar.top}`);
  if (Math.abs(bar.height - 48) > 0.05) problems.push(`toolbar height ${bar.height}, want 48`);
  if (bar.borderBottomWidth !== "0px") problems.push(`toolbar border-bottom ${bar.borderBottomWidth}, want 0`);
  if (!/inset/.test(bar.boxShadow || "")) problems.push(`toolbar box-shadow missing inset hairline: ${bar.boxShadow}`);
  if (controls.length < 11) problems.push(`visible controls ${controls.length}, want at least 11 including the fake button`);
  if (!controls.some((row) => row.text === "假按钮")) problems.push("fake button was not discovered");
  if (controls.some((row) => row.id === "stopTranslate")) problems.push("hidden stop button was measured");
  if (controls.some((row) => row.id === "file")) problems.push("clipped file input was measured");

  const groups = new Map();
  for (const row of controls) {
    const where = row.id || row.text || row.tb || "control";
    if (Math.abs(row.top - 9) > 0.05) problems.push(`${where} top ${row.top}, want 9`);
    if (Math.abs(row.height - 30) > 0.05) problems.push(`${where} height ${row.height}, want 30`);
    const center = row.top + row.height / 2;
    if (Math.abs(center - 24) > 0.5) problems.push(`${where} centerline ${center}, want 24±0.5`);
    for (const key of ["left", "top", "width", "height"]) {
      if (!wholePx(row[key])) problems.push(`${where} ${key} ${row[key]} is not a whole pixel`);
    }
    if (row.baseline == null && row.text) problems.push(`${where} has text but no baseline`);
    if (row.baseline != null) {
      const list = groups.get(row.group) || [];
      list.push(row);
      groups.set(row.group, list);
    }
  }
  for (const [group, rows] of groups) {
    if (rows.length < 2) continue;
    const values = rows.map((row) => row.baseline);
    const spread = Math.max(...values) - Math.min(...values);
    if (spread > 0.5) {
      const detail = rows.map((row) => `${row.id || row.text}=${row.baseline.toFixed(2)}`).join(", ");
      problems.push(`baseline spread ${spread.toFixed(2)} in ${group}: ${detail}`);
    }
  }
  const fake = controls.find((row) => row.text === "假按钮");
  const peers = fake ? controls.filter((row) => row.group === fake.group && row.baseline != null) : [];
  if (!fake || peers.length < 2) problems.push("fake button is not in a text group with another labeled control");
  return problems;
}

function ringProblems(row) {
  if (!row.focusable) return [];
  const where = row.id || row.text || "control";
  const problems = [];
  if (!(row.outlineWidth >= 1)) problems.push(`${where} outline-width ${row.outlineWidthRaw}`);
  const outset = row.outlineWidth + Math.max(row.outlineOffset, 0);
  const box = {
    top: row.topAbs - outset,
    left: row.left - outset,
    right: row.left + row.width + outset,
    bottom: row.topAbs + row.height + outset
  };
  if (box.top < -0.5 || box.left < -0.5 || box.right > row.vw + 0.5 || box.bottom > row.vh + 0.5) {
    problems.push(`${where} focus ring leaves the viewport (${box.left.toFixed(1)},${box.top.toFixed(1)})–(${box.right.toFixed(1)},${box.bottom.toFixed(1)})`);
  }
  for (const clip of row.clips || []) {
    if (box.top < clip.top - 0.5 || box.left < clip.left - 0.5 || box.right > clip.right + 0.5 || box.bottom > clip.bottom + 0.5) {
      problems.push(`${where} focus ring clipped by ${clip.tag}${clip.id ? `#${clip.id}` : ""}`);
    }
  }
  return problems;
}

test("toolbar controls share the y=24 centerline across themes and widths", { timeout: 180000 }, async (t) => {
  assert.equal(existsSync(fixture), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-topbar-chrome-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const handle = { child: null, cdp: null };
  t.after(async () => {
    try {
      handle.cdp?.dispose();
    } finally {
      await cleanupChrome({
        t,
        child: handle.child,
        server,
        ownedDir,
        userDataDir
      });
    }
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;
  const viewer = `${origin}/pdf/viewer.html?src=${encodeURIComponent(src)}`;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("DOM.enable", {}, sessionId);
  await cdp.send("CSS.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  }, sessionId);
  await cdp.send("Page.navigate", { url: viewer }, sessionId);

  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  };

  const waitFor = async (expression, label, timeoutMs = 30000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(200);
    }
    const status = await evaluate(`document.getElementById("status")?.textContent || ""`).catch(() => "");
    throw new Error(`${label} timed out. status=${status} last=${JSON.stringify(last)}`);
  };

  await waitFor(`(() => {
    const pager = document.getElementById("sourcePageLabel")?.textContent || "";
    const doc = document.querySelector("#docStatus .doc-text")?.textContent || "";
    const bar = document.querySelector(".toolbar");
    return /\\/\\s*15/.test(pager) && /已译|全文已译/.test(doc) && !bar.querySelector("#pager, #prev, #next") ? pager + "|" + doc : "";
  })()`, "Attention PDF open");

  await evaluate(`(() => {
    const actions = document.querySelector(".tb-group[data-grp='settings']");
    const fake = document.createElement("button");
    fake.type = "button";
    fake.className = "btn-ghost";
    fake.textContent = "假按钮";
    actions.appendChild(fake);
    return true;
  })()`);

  const measureExpr = `(() => {
    const selector = ${JSON.stringify(CONTROL_SELECTOR)};
    const barEl = document.querySelector(".toolbar");
    const barBox = barEl.getBoundingClientRect();
    const barStyle = getComputedStyle(barEl);
    const controls = [...barEl.querySelectorAll(selector)].filter((el) => {
      if (el.getAttribute("aria-hidden") === "true") return false;
      if (el.closest("[hidden]")) return false;
      const ancestor = el.parentElement && el.parentElement.closest(selector);
      if (ancestor && barEl.contains(ancestor)) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 1 && rect.height >= 1;
    });
    controls.forEach((el, index) => el.setAttribute("data-tb-probe", String(index)));
    const rows = controls.map((el, index) => {
      const rect = el.getBoundingClientRect();
      const textHost = el.querySelector(".pager-ink, .doc-text") || el;
      const text = (textHost.textContent || "").replace(/\\s+/g, " ").trim();
      const fontSize = getComputedStyle(textHost).fontSize;
      const ink = el.querySelector(".pager-ink");
      const nudge = ink ? getComputedStyle(ink).top : "0px";
      const tb = el.dataset.tb || (el.matches("button, a[href], input, select, textarea") ? "text" : "control");
      let baseline = null;
      if (text) {
        const probe = document.createElement("span");
        probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline;padding:0;margin:0;border:0;overflow:hidden;line-height:0;";
        textHost.appendChild(probe);
        baseline = probe.getBoundingClientRect().bottom - barBox.top;
        probe.remove();
      }
      const focusable = el.matches("button, a[href], input, select, textarea");
      return {
        probe: index,
        id: el.id || "",
        text,
        tb,
        group: tb + "|" + fontSize + "|" + nudge,
        left: rect.left,
        top: rect.top - barBox.top,
        topAbs: rect.top,
        width: rect.width,
        height: rect.height,
        baseline,
        focusable
      };
    });
    return {
      dpr: window.devicePixelRatio,
      bar: {
        top: barBox.top,
        height: barBox.height,
        borderBottomWidth: barStyle.borderBottomWidth,
        boxShadow: barStyle.boxShadow
      },
      controls: rows
    };
  })()`;

  const readRings = async (controls) => {
    const doc = await cdp.send("DOM.getDocument", { depth: 0 }, sessionId);
    const rings = [];
    for (const row of controls) {
      if (!row.focusable) {
        rings.push({ ...row, outlineWidth: 0, outlineOffset: 0, outlineWidthRaw: "", clips: [], vw: 0, vh: 0 });
        continue;
      }
      const selector = `[data-tb-probe="${row.probe}"]`;
      const found = await cdp.send("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector
      }, sessionId);
      if (!found.nodeId) throw new Error(`missing probe ${selector}`);
      await cdp.send("CSS.forcePseudoState", {
        nodeId: found.nodeId,
        forcedPseudoClasses: ["focus", "focus-visible"]
      }, sessionId);
      const measured = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const style = getComputedStyle(el);
        const clips = [];
        for (let node = el.parentElement; node; node = node.parentElement) {
          const mode = getComputedStyle(node);
          if (/(hidden|clip|scroll|auto)/.test(mode.overflowX + " " + mode.overflowY)) {
            const box = node.getBoundingClientRect();
            clips.push({ tag: node.tagName, id: node.id || "", top: box.top, left: box.left, right: box.right, bottom: box.bottom });
          }
        }
        return {
          outlineWidth: parseFloat(style.outlineWidth),
          outlineOffset: parseFloat(style.outlineOffset),
          outlineWidthRaw: style.outlineWidth,
          clips,
          vw: window.innerWidth,
          vh: window.innerHeight
        };
      })()`);
      await cdp.send("CSS.forcePseudoState", {
        nodeId: found.nodeId,
        forcedPseudoClasses: []
      }, sessionId);
      rings.push({ ...row, ...measured });
    }
    return rings;
  };

  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      }, sessionId);
      await evaluate(`(() => {
        for (const el of document.querySelectorAll("[data-reader-theme]")) el.dataset.readerTheme = ${JSON.stringify(theme)};
        window.dispatchEvent(new Event("resize"));
        return new Promise((done) => {
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)));
        });
      })()`);
      const sample = await evaluate(measureExpr);
      const label = `${theme} @ ${width}`;
      const problems = geometryProblems(sample);
      const rings = await readRings(sample.controls);
      for (const row of rings) problems.push(...ringProblems(row));
      assert.equal(problems.length, 0, `${label}\n${problems.join("\n")}\n${JSON.stringify(sample.controls.map((row) => ({
        id: row.id,
        text: row.text,
        tb: row.tb,
        group: row.group,
        left: row.left,
        top: row.top,
        width: row.width,
        height: row.height,
        baseline: row.baseline
      })))}`);
      const ring = await evaluate(`(() => {
        const status = document.getElementById("docStatus");
        const svg = status.querySelector(".doc-ring");
        const barEl = document.querySelector(".toolbar");
        const host = status.getBoundingClientRect();
        const barBox = barEl.getBoundingClientRect();
        const style = getComputedStyle(status);
        const svgStyle = getComputedStyle(svg);
        const box = svgStyle.display === "none" ? null : svg.getBoundingClientRect();
        const mark = getComputedStyle(status, "::before");
        const markW = parseFloat(mark.width) || 0;
        const markH = parseFloat(mark.height) || 0;
        const usingMark = !box;
        return {
          clipped: style.overflowX !== "visible" || style.overflowY !== "visible",
          inside: usingMark
            ? markW >= 13 && markH >= 13
            : box.top >= host.top - 0.5 && box.bottom <= host.bottom + 0.5 && box.left >= host.left - 0.5 && box.right <= host.right + 0.5,
          inBar: usingMark
            ? true
            : box.top >= barBox.top - 0.5 && box.bottom <= barBox.bottom + 0.5,
          w: usingMark ? markW : box.width,
          h: usingMark ? markH : box.height
        };
      })()`);
      assert.equal(ring.clipped, false, `${label} status clips the ring`);
      assert.equal(ring.inside, true, `${label} ring leaves the status slot`);
      assert.equal(ring.inBar, true, `${label} ring leaves the toolbar`);
      assert.ok(ring.w >= 13 && ring.h >= 13, `${label} ring ${ring.w}x${ring.h}`);
    }
  }

  const spacing = await evaluate(`(() => {
    const bar = document.querySelector(".toolbar");
    const selector = ${JSON.stringify(CONTROL_SELECTOR)};
    const controls = [...bar.querySelectorAll(selector)].filter((el) => {
      if (el.getAttribute("aria-hidden") === "true") return false;
      if (el.closest("[hidden]")) return false;
      const ancestor = el.parentElement && el.parentElement.closest(selector);
      if (ancestor && bar.contains(ancestor)) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 1 && rect.height >= 1;
    }).map((el) => {
      const rect = el.getBoundingClientRect();
      return { id: el.id || el.textContent.trim().slice(0, 8), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }).sort((a, b) => a.left - b.left);
    const rules = [...bar.querySelectorAll(".toolbar-rule")].filter((el) => getComputedStyle(el).display !== "none").map((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    });
    const gaps = [];
    for (let i = 0; i < controls.length - 1; i += 1) {
      const a = controls[i];
      const b = controls[i + 1];
      const rule = rules.find((item) => item.left >= a.right - 0.5 && item.right <= b.left + 0.5);
      gaps.push({
        from: a.id,
        to: b.id,
        gap: b.left - a.right,
        rule: rule ? { before: rule.left - a.right, width: rule.width, after: b.left - rule.right } : null
      });
    }
    const barBox = bar.getBoundingClientRect();
    return {
      gaps,
      overflow: bar.scrollWidth - bar.clientWidth,
      height: barBox.height,
      padStart: getComputedStyle(bar).paddingLeft,
      padEnd: getComputedStyle(bar).paddingRight
    };
  })()`);
  assert.equal(spacing.padStart, "9px");
  assert.equal(spacing.padEnd, "12px");
  assert.ok(spacing.overflow <= 1, `toolbar overflow ${spacing.overflow}`);
  for (const row of spacing.gaps) {
    if (row.rule) {
      assert.ok(Math.abs(row.rule.before - 6) <= 0.6, `${row.from}→rule ${row.rule.before}`);
      assert.ok(Math.abs(row.rule.width - 1) <= 0.6, `${row.from} rule width ${row.rule.width}`);
      assert.ok(Math.abs(row.rule.after - 6) <= 0.6, `rule→${row.to} ${row.rule.after}`);
    } else {
      const near = Math.abs(row.gap - 2) <= 0.6;
      const zone = row.gap >= 16 - 0.6;
      assert.ok(near || zone, `${row.from}→${row.to} gap ${row.gap} is not 2 or ≥16`);
    }
  }

  const locked = await evaluate(`(() => {
    const button = document.getElementById("translatePage");
    const neighbor = document.getElementById("translateMenuButton");
    const read = () => neighbor.getBoundingClientRect().left;
    const origin = read();
    const labels = ["翻译全文", "停止", "继续翻译", "翻译"];
    const shifts = labels.map((label) => {
      button.textContent = label;
      return { label, dx: Math.abs(read() - origin), width: button.getBoundingClientRect().width };
    });
    return shifts;
  })()`);
  for (const row of locked) {
    assert.ok(row.dx <= 0.5, `${row.label} moved the chevron by ${row.dx}`);
    assert.ok(row.width >= 86 - 0.5, `${row.label} width ${row.width} < 86`);
  }

  await evaluate(`document.activeElement?.blur()`);
  const viewCycle = await evaluate(`(() => {
    const workspace = document.querySelector(".workspace");
    const blocks = document.querySelectorAll("#readerFlow .rf-block").length;
    const fire = (key) => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    const seen = [workspace.dataset.view || "zh"];
    for (let i = 0; i < 3; i += 1) {
      fire("t");
      seen.push(workspace.dataset.view || "");
    }
    return { seen, blocks, after: document.querySelectorAll("#readerFlow .rf-block").length };
  })()`);
  assert.deepEqual(viewCycle.seen, ["zh", "bi", "src", "zh"]);
  assert.equal(viewCycle.after, viewCycle.blocks);
  assert.ok(viewCycle.blocks > 0, "view cycle kept the reader flow");

  const paged = await evaluate(`(async () => {
    const label = () => document.getElementById("sourcePageLabel").textContent;
    const fire = (key) => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    const before = label();
    fire("]");
    await new Promise((done) => setTimeout(done, 250));
    const next = label();
    fire("[");
    await new Promise((done) => setTimeout(done, 250));
    return { before, next, back: label(), prevDisabled: document.getElementById("sourcePrev").disabled };
  })()`);
  assert.match(paged.before, /^1 \//);
  assert.match(paged.next, /^2 \//);
  assert.match(paged.back, /^1 \//);
  assert.equal(paged.prevDisabled, true);

  for (const width of [1440, 1280, 1100, 900, 600]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    }, sessionId);
    const band = await evaluate(`(() => new Promise((done) => {
      window.dispatchEvent(new Event("resize"));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const bar = document.querySelector(".toolbar");
        const style = getComputedStyle(bar);
        const shown = (id) => {
          const el = document.getElementById(id);
          if (!el || el.closest("[hidden]")) return false;
          for (let node = el; node; node = node.parentElement) {
            const css = getComputedStyle(node);
            if (css.display === "none" || css.visibility === "hidden") return false;
          }
          const box = el.getBoundingClientRect();
          return box.width >= 1 && box.height >= 1;
        };
        done({
          band: bar.dataset.band,
          height: bar.getBoundingClientRect().height,
          overflow: bar.scrollWidth - bar.clientWidth,
          wrap: style.flexWrap,
          retranslate: shown("retranslatePage"),
          notes: shown("notesButton"),
          aa: shown("aaButton"),
          more: shown("moreButton"),
          translate: shown("translatePage"),
          toc: shown("tocButton"),
          viewParent: document.getElementById("viewSeg")?.parentElement?.id || "",
          narrow: shown("sourceModeNarrow"),
          menu: shown("sourceModeMenu"),
          segment: shown("sourceModeSeg") === false ? false : getComputedStyle(document.getElementById("sourceModeSeg")).display !== "none",
          swapHidden: document.getElementById("swapPanes").hidden,
          notesMenu: document.getElementById("menuNotes").hidden === false,
          noteKey: document.querySelector("#menuNotes .menu-key")?.textContent || ""
        });
      }));
    }))()`);
    assert.equal(band.height, 48, `${width} toolbar height ${band.height}`);
    assert.equal(band.wrap, "nowrap", `${width} toolbar wrapped`);
    assert.ok(band.overflow <= 1, `${width} overflow ${band.overflow}`);
    assert.equal(band.toc, true, `${width} ≡ collapsed`);
    assert.equal(band.translate, true, `${width} primary collapsed`);
    assert.equal(band.more, true, `${width} ··· collapsed`);
    assert.equal(band.noteKey, "m");
    if (width >= 1200) {
      assert.equal(band.band, "wide");
      assert.equal(band.retranslate, true);
      assert.equal(band.notes, true);
      assert.equal(band.aa, true);
      assert.equal(band.viewParent, "tbZoneCenter");
      assert.equal(band.segment, true);
      assert.equal(band.swapHidden, false);
      assert.equal(band.notesMenu, false);
    } else if (width >= 900) {
      assert.equal(band.band, "mid");
      assert.equal(band.retranslate, false);
      assert.equal(band.notes, false);
      assert.equal(band.aa, false);
      assert.equal(band.viewParent, "tbZoneCenter");
      assert.equal(band.menu, true);
      assert.equal(band.swapHidden, false);
      assert.equal(band.notesMenu, true);
    } else {
      assert.equal(band.band, "narrow");
      assert.equal(band.retranslate, false);
      assert.equal(band.viewParent, "tbSubbar");
      assert.equal(band.narrow, true);
      assert.equal(band.swapHidden, true);
      assert.equal(band.notesMenu, true);
    }
  }
});
