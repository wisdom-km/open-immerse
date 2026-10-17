// F6UI-33 / F6UI-34. Measures the answer action row in Chrome.
// 360px column: 复制 · ✓ 已添加 · 查看笔记 → share one 28px line.
// Container <280px, and data-icons="1": 28×28 icons, names kept.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const PREFIXES = ["oi-ask-actions-chrome-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".js": "text/javascript; charset=utf-8"
};

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
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
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
    "--window-size=800,900",
    "--no-first-run",
    "--no-default-browser-check"
  ], {
    detached: true,
    env: { ...process.env, TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir },
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

function near(actual, expected, tol = 0.51) {
  return Math.abs(actual - expected) <= tol;
}

function rgbaClose(value, [r, g, b, a]) {
  const match = String(value || "").match(/rgba?\(([^)]+)\)/);
  if (!match) return false;
  const parts = match[1].split(",").map((part) => Number(part.trim()));
  if (parts.length < 3) return false;
  const alpha = parts.length > 3 ? parts[3] : 1;
  return Math.abs(parts[0] - r) <= 1
    && Math.abs(parts[1] - g) <= 1
    && Math.abs(parts[2] - b) <= 1
    && Math.abs(alpha - a) <= 0.02;
}

const MEASURE = `(() => {
  function box(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      whiteSpace: style.whiteSpace,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      radius: style.borderRadius,
      background: style.backgroundColor,
      color: style.color,
      outline: style.outline,
      outlineOffset: style.outlineOffset,
      display: style.display,
      flexWrap: style.flexWrap,
      gap: style.columnGap || style.gap,
      position: style.position
    };
  }
  function rowInfo(root) {
    const row = root.querySelector(".oi-ask-actions");
    const buttons = [...row.querySelectorAll(".oi-ask-act")].map((el) => {
      const text = el.querySelector(".oi-ask-act-text");
      const icon = el.querySelector(".oi-ask-act-icon svg");
      const iconBox = icon.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(text);
      return {
        label: text.textContent,
        aria: el.getAttribute("aria-label"),
        title: el.getAttribute("title"),
        disabled: el.disabled,
        className: el.className,
        lines: range.getClientRects().length,
        stroke: icon.getAttribute("stroke-width") || icon.querySelector("[stroke-width]")?.getAttribute("stroke-width") || "",
        icon: { width: iconBox.width, height: iconBox.height },
        textBox: box(text),
        box: box(el)
      };
    });
    const rowBox = box(row);
    const disclaimer = root.querySelector(".oi-ask-disclaimer");
    return {
      bubble: root.getBoundingClientRect().width,
      row: rowBox,
      buttons,
      disclaimer: disclaimer ? { ...box(disclaimer), text: disclaimer.textContent, parent: disclaimer.parentElement === row ? "row" : disclaimer.previousElementSibling === row ? "after" : "other" } : null,
      debug: root.textContent.includes("已写入本机笔记")
    };
  }
  return {
    wide: rowInfo(document.querySelector("#wide-bubble")),
    at279: rowInfo(document.querySelector("#at279 .oi-ask-bubble")),
    at280: rowInfo(document.querySelector("#at280 .oi-ask-bubble")),
    icons: rowInfo(document.querySelector("#icons-attr .oi-ask-bubble"))
  };
})()`;

test("F6UI-33/34 action row stays one line at 360 and icons under 280", { timeout: 60000 }, async (t) => {
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-ask-actions-chrome-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const handle = { child: null, cdp: null };
  t.after(async () => {
    try { handle.cdp?.dispose(); } finally {
      await cleanupChrome({ t, child: handle.child, server, ownedDir, userDataDir });
    }
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
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
    width: 800,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  }, sessionId);
  await cdp.send("Page.navigate", { url: `${origin}/tests/fixtures/ask-actions-row.html` }, sessionId);
  const evaluate = async (expression) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < 10000) {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true
      }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "evaluate failed");
      last = result.result?.value;
      if (last) return last;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`measure timed out: ${JSON.stringify(last)}`);
  };
  await evaluate(`document.documentElement.dataset.ready === "1" ? true : null`);
  const sample = await evaluate(MEASURE);

  const problems = [];
  const wide = sample.wide;
  if (!near(wide.bubble, 316)) problems.push(`wide bubble ${wide.bubble}, want 316`);
  if (wide.row.flexWrap !== "nowrap") problems.push(`wide flex-wrap ${wide.row.flexWrap}`);
  if (wide.row.whiteSpace !== "nowrap") problems.push(`wide white-space ${wide.row.whiteSpace}`);
  if (wide.row.gap !== "4px") problems.push(`wide gap ${wide.row.gap}`);
  if (wide.buttons.map((button) => button.label).join("|") !== "复制|已添加|查看笔记") {
    problems.push(`wide labels ${wide.buttons.map((button) => button.label).join("|")}`);
  }
  const tops = wide.buttons.map((button) => button.box.top);
  if (Math.max(...tops) - Math.min(...tops) > 0.51) problems.push(`wide tops differ ${tops.join(",")}`);
  for (const button of wide.buttons) {
    if (!near(button.box.height, 28)) problems.push(`${button.label} height ${button.box.height}`);
    if (button.box.whiteSpace !== "nowrap") problems.push(`${button.label} wraps via white-space`);
    if (button.lines !== 1) problems.push(`${button.label} line count ${button.lines}`);
    if (button.box.fontSize !== "12px") problems.push(`${button.label} font ${button.box.fontSize}`);
    if (button.box.fontWeight !== "500") problems.push(`${button.label} weight ${button.box.fontWeight}`);
    if (button.box.paddingLeft !== "10px" || button.box.paddingRight !== "10px") {
      problems.push(`${button.label} padding ${button.box.paddingLeft} ${button.box.paddingRight}`);
    }
    if (button.box.radius !== "7px") problems.push(`${button.label} radius ${button.box.radius}`);
    if (!near(button.icon.width, 14) || !near(button.icon.height, 14)) {
      problems.push(`${button.label} icon ${button.icon.width}x${button.icon.height}`);
    }
    if (button.stroke !== "1.4") problems.push(`${button.label} stroke ${button.stroke}`);
    if (!button.aria || button.title !== button.aria) problems.push(`${button.label} missing name`);
  }
  const added = wide.buttons[1];
  const view = wide.buttons[2];
  if (!near(added.box.width, 96)) problems.push(`added width ${added.box.width}`);
  if (!added.disabled || added.aria !== "✓ 已添加") problems.push("added is still actionable");
  if (!rgbaClose(added.box.color, [122, 74, 134, 1])) problems.push(`added color ${added.box.color}`);
  if (!rgbaClose(added.box.background, [0, 0, 0, 0])) problems.push(`added background ${added.box.background}`);
  if (!rgbaClose(view.box.color, [42, 102, 112, 1])) problems.push(`view color ${view.box.color}`);
  if (!rgbaClose(wide.buttons[0].box.background, [0, 0, 0, 0])) problems.push(`copy background ${wide.buttons[0].box.background}`);
  if (!near(added.box.left - wide.buttons[0].box.left - wide.buttons[0].box.width, 4)) problems.push("copy/added gap");
  if (!near(view.box.left - added.box.left - added.box.width, 4)) problems.push("added/view gap");
  const right = view.box.left + view.box.width;
  const rowRight = wide.row.left + wide.row.width;
  if (right > rowRight + 0.51) problems.push("view overflows the row");
  if (!wide.disclaimer || wide.disclaimer.text !== "模型回答，可能有误") problems.push("disclaimer missing");
  if (wide.disclaimer.parent !== "after") problems.push(`disclaimer parent ${wide.disclaimer?.parent}`);
  if (wide.disclaimer.top + 0.51 < added.box.top + added.box.height) problems.push("disclaimer shares the button line");
  if (wide.disclaimer.fontSize !== "11px") problems.push(`disclaimer size ${wide.disclaimer.fontSize}`);
  if (wide.disclaimer.paddingLeft !== "10px") problems.push(`disclaimer indent ${wide.disclaimer.paddingLeft}`);
  if (!rgbaClose(wide.disclaimer.color, [101, 95, 84, 1])) problems.push(`disclaimer color ${wide.disclaimer.color}`);
  if (wide.debug) problems.push("debug line is still present");

  function expectIcons(name, info) {
    if (info.buttons.length < 2) problems.push(`${name} missing buttons`);
    const heights = info.buttons.map((button) => button.box.top);
    if (Math.max(...heights) - Math.min(...heights) > 0.51) problems.push(`${name} wrapped`);
    for (const button of info.buttons) {
      if (!near(button.box.width, 28) || !near(button.box.height, 28)) {
        problems.push(`${name} ${button.label} box ${button.box.width}x${button.box.height}`);
      }
      if (button.textBox.position !== "absolute") problems.push(`${name} ${button.label} text still in flow`);
      if (!button.aria || button.title !== button.aria) problems.push(`${name} ${button.label} missing accessible name`);
    }
  }
  expectIcons("279", sample.at279);
  expectIcons("data-icons", sample.icons);
  if (sample.at279.bubble >= 280) problems.push(`279 probe is ${sample.at279.bubble}`);
  for (const button of sample.at280.buttons) {
    if (button.textBox.position === "absolute") problems.push(`280 collapsed ${button.label}`);
    if (!near(button.box.height, 28)) problems.push(`280 ${button.label} height ${button.box.height}`);
    if (button.box.width <= 28.5) problems.push(`280 ${button.label} is icon-only (${button.box.width})`);
  }

  const doc = await cdp.send("DOM.getDocument", {}, sessionId);
  const copy = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#wide .is-copy" }, sessionId);
  const viewNode = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#wide .is-view" }, sessionId);
  const addedNode = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#wide .is-added" }, sessionId);
  await cdp.send("CSS.forcePseudoState", { nodeId: copy.nodeId, forcedPseudoClasses: ["hover", "focus-visible"] }, sessionId);
  await cdp.send("CSS.forcePseudoState", { nodeId: viewNode.nodeId, forcedPseudoClasses: ["hover"] }, sessionId);
  await cdp.send("CSS.forcePseudoState", { nodeId: addedNode.nodeId, forcedPseudoClasses: ["hover"] }, sessionId);
  const hover = await evaluate(`(() => {
    const copy = getComputedStyle(document.querySelector("#wide .is-copy"));
    const view = getComputedStyle(document.querySelector("#wide .is-view"));
    const added = getComputedStyle(document.querySelector("#wide .is-added"));
    return {
      copy: copy.backgroundColor,
      view: view.backgroundColor,
      added: added.backgroundColor,
      outline: copy.outlineStyle + " " + copy.outlineWidth + " " + copy.outlineColor,
      offset: copy.outlineOffset
    };
  })()`);
  if (!rgbaClose(hover.copy, [34, 32, 28, 0.06])) problems.push(`copy hover ${hover.copy}`);
  if (!rgbaClose(hover.view, [42, 102, 112, 0.08])) problems.push(`view hover ${hover.view}`);
  if (!rgbaClose(hover.added, [0, 0, 0, 0])) problems.push(`added hover ${hover.added}`);
  if (!/solid/.test(hover.outline) || !/2px/.test(hover.outline)) problems.push(`focus ring ${hover.outline}`);
  if (hover.offset !== "1px") problems.push(`focus offset ${hover.offset}`);

  assert.deepEqual(problems, [], problems.join("\n"));
});
