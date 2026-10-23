// Reader drawer in headless Chrome. The Attention fixture is served locally.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const TMP_PREFIXES = ["oi-f8-pr3b-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(TMP_PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json"
};

function serveRepo() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = resolve(root, name);
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
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done(server));
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
    "--window-size=1680,1050",
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
    let end = this.buf.indexOf(0);
    while (end >= 0) {
      const raw = this.buf.slice(0, end).toString("utf8");
      this.buf = this.buf.slice(end + 1);
      end = this.buf.indexOf(0);
      const message = JSON.parse(raw);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.done(message.result || {});
      }
    }
  }

  dispose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("cdp disposed"));
    }
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

test("阅读页抽屉：停靠、目录、页签、最近和窄屏", { timeout: 180000 }, async (t) => {
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-f8-pr3b-"));
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
      await cleanupChrome({ t, child: handle.child, server, ownedDir, userDataDir });
    }
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Target.activateTarget", { targetId });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__oiBoot = "";
      window.addEventListener("error", (event) => { window.__oiBoot = String((event.error && event.error.stack) || event.message || "error"); });
      window.addEventListener("unhandledrejection", (event) => { window.__oiBoot = "reject " + String(event.reason && (event.reason.stack || event.reason)); });
      const bag = {};
      const storageArea = {
        get(key) {
          if (typeof key === "string") return Promise.resolve({ [key]: bag[key] });
          const out = {};
          for (const name of key || []) if (name in bag) out[name] = bag[name];
          return Promise.resolve(out);
        },
        set(entries) { Object.assign(bag, entries || {}); return Promise.resolve(); },
        remove(keys) { for (const key of keys || []) delete bag[key]; return Promise.resolve(); }
      };
      window.chrome = {
        runtime: { id: "oi-test", sendMessage() { return Promise.resolve({ ok: true, settings: { provider: "mymemory", pdfAutoTranslate: false, targetLang: "zh-CN" } }); }, onMessage: { addListener() {} }, getURL(path) { const name = String(path || ""); if (name.includes("pdf.worker")) return new URL("/pdf/vendor/pdf.worker.min.mjs", location.origin).href; return new URL(name.replace(/^\\//, ""), location.origin + "/").href; } },
        storage: { local: storageArea, sync: storageArea, onChanged: { addListener() {} } },
        tabs: { getCurrent(cb) { if (cb) cb({ id: 1 }); } }
      };`
  }, sessionId);

  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(detail || JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  };
  const waitFor = async (expression, step, timeoutMs = 20000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(100);
    }
    const boot = await evaluate(`window.__oiBoot || ""`).catch((error) => `eval ${error}`);
    const status = await evaluate(`document.getElementById("status")?.textContent || ""`).catch((error) => `eval ${error}`);
    const where = await evaluate(`window.__oiTrack || JSON.stringify({ href: location.href, ready: document.readyState, pages: document.querySelectorAll("#pages .pdf-page").length, status: document.getElementById("status")?.textContent || "" })`).catch((error) => `eval ${error}`);
    throw new Error(`${step} timed out. status=${status} boot=${boot} where=${where} last=${JSON.stringify(last)}`);
  };
  const setWidth = async (width, height = 900) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    }, sessionId);
    await evaluate(`window.dispatchEvent(new Event("resize"))`);
    await sleep(50);
  };
  const key = async (name, extra = {}) => {
    await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify({
      key: name,
      bubbles: true,
      ...extra
    })}))`);
  };

  const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;
  await cdp.send("Page.navigate", { url: `${origin}/pdf/viewer.html?src=${encodeURIComponent(src)}` }, sessionId);
  await waitFor(`(() => {
    const title = document.getElementById("docTitle")?.textContent || "";
    if (!title.includes("Attention")) return "";
    if (!document.querySelector("#pages .pdf-page[data-page='4']")) return "";
    return "open";
  })()`, "打开 Attention", 40000);

  await setWidth(2200);
  const sourceBefore = await evaluate(`document.getElementById("pdfPane").getBoundingClientRect().width`);
  await evaluate(`document.getElementById("tocButton").click()`);
  const docked = JSON.parse(await waitFor(`(() => {
    const root = document.querySelector(".oi-drawer");
    const item = document.querySelector(".oi-toc-item[data-level='3']");
    if (!root || root.closest("#drawerSlot")?.hidden) return "";
    if (document.querySelector("[data-toc-source]")?.getAttribute("data-toc-source") !== "outline") return "";
    if (!item || !item.textContent.includes("3.2.1") || !item.textContent.includes("Scaled Dot-Product Attention")) return "";
    const workspace = document.querySelector(".workspace");
    if (!workspace.hasAttribute("data-drawer-docked")) return "";
    const drawer = document.getElementById("drawerSlot").getBoundingClientRect();
    const pane = document.getElementById("pdfPane").getBoundingClientRect();
    const translate = document.querySelector(".pane-translate").getBoundingClientRect();
    const flow = document.getElementById("readerFlow");
    let textX = flow ? flow.getBoundingClientRect().x : translate.x;
    if (flow) {
      const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (String(node.textContent || "").trim()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const box = range.getBoundingClientRect();
          if (box.width > 0 && box.height > 0) {
            textX = box.x;
            break;
          }
        }
        node = walker.nextNode();
      }
    }
    const pad = getComputedStyle(item).paddingInlineStart || getComputedStyle(item).paddingLeft;
    return JSON.stringify({
      role: root.getAttribute("role"),
      modal: root.getAttribute("aria-modal"),
      pressed: document.getElementById("tocButton").getAttribute("aria-pressed"),
      controls: document.getElementById("tocButton").getAttribute("aria-controls"),
      toastHidden: document.getElementById("tbToast").hidden,
      width: Math.round(drawer.width),
      pad,
      sourceBefore: ${sourceBefore},
      sourceAfter: pane.width,
      textX,
      drawerRight: drawer.right,
      translateX: translate.x,
      drawerX: drawer.x
    });
  })()`, "宽屏停靠并显示 3.2.1", 30000));
  assert.equal(docked.role, "complementary");
  assert.equal(docked.modal, null);
  assert.equal(docked.pressed, "true");
  assert.equal(docked.controls, "drawerSlot");
  assert.equal(docked.toastHidden, true);
  assert.equal(docked.width, 288);
  assert.equal(parseFloat(docked.pad), 34);
  assert.ok(Math.abs(docked.sourceAfter - docked.sourceBefore) <= 2, JSON.stringify(docked));
  assert.ok(docked.textX + 1 >= docked.drawerRight + 16, JSON.stringify(docked));
  assert.ok(Math.abs(docked.drawerRight - docked.translateX) <= 2, JSON.stringify(docked));

  await evaluate(`document.querySelector(".workspace").style.setProperty("--oi-drawer-source", "768px")`);
  await evaluate(`window.dispatchEvent(new Event("resize"))`);
  const repinned = await evaluate(`parseFloat(getComputedStyle(document.querySelector(".workspace")).getPropertyValue("--oi-drawer-source"))`);
  assert.ok(Math.abs(repinned - 768) > 40, `stale pin stayed ${repinned}`);

  await evaluate(`(() => {
    const pane = document.getElementById("pages");
    const page = document.querySelector("#pages .pdf-page[data-page='15']");
    if (pane && page) pane.scrollTop = page.offsetTop;
    pane?.dispatchEvent(new Event("scroll"));
  })()`);
  const lateCurrent = await waitFor(`document.querySelector(".oi-toc-item[aria-current='location']")?.textContent || ""`, "滚到文末后的当前项", 5000);
  await evaluate(`(() => {
    const pane = document.getElementById("pages");
    if (pane) {
      pane.scrollTop = 0;
      pane.dispatchEvent(new Event("scroll"));
    }
  })()`);
  await waitFor(`(() => {
    const text = document.querySelector(".oi-toc-item[aria-current='location']")?.textContent || "";
    if (text === ${JSON.stringify(lateCurrent)}) return "";
    return "moved";
  })()`, "滚回开头后当前项变化", 5000);

  const alignReading = async (page) => {
    await evaluate(`(() => {
      const pane = document.getElementById("pages");
      const node = document.querySelector("#pages .pdf-page[data-page='${page}']");
      if (!pane || !node) return;
      const paneBox = pane.getBoundingClientRect();
      const pageBox = node.getBoundingClientRect();
      pane.scrollTop += pageBox.top - (paneBox.top + pane.clientHeight / 3 - 5);
      pane.dispatchEvent(new Event("scroll"));
    })()`);
  };
  await alignReading(4);
  const topOfPage4 = await waitFor(`(() => {
    const num = document.querySelector(".oi-toc-item[aria-current='location'] .oi-toc-num")?.textContent || "";
    return num === "3.2.1" ? num : "";
  })()`, "第 4 页顶部当前节是 3.2.1", 5000);
  assert.equal(topOfPage4, "3.2.1");
  await alignReading(5);
  const topOfPage5 = await waitFor(`(() => {
    const num = document.querySelector(".oi-toc-item[aria-current='location'] .oi-toc-num")?.textContent || "";
    return num === "3.2.3" ? num : "";
  })()`, "第 5 页顶部当前节是 3.2.3", 5000);
  assert.equal(topOfPage5, "3.2.3");

  await evaluate(`document.getElementById("tocButton").click()`);
  await waitFor(`document.getElementById("drawerSlot").hidden ? "closed" : ""`, "关上抽屉", 5000);
  await alignReading(5);
  await evaluate(`document.getElementById("tocButton").click()`);
  const openedOn = await waitFor(`(() => {
    const active = document.activeElement;
    if (!active?.classList?.contains("oi-toc-item")) return "";
    const num = active.querySelector(".oi-toc-num")?.textContent || "";
    return num === "3.2.3" ? num : "";
  })()`, "打开抽屉时焦点在 3.2.3", 5000);
  assert.equal(openedOn, "3.2.3");

  const viewBefore = await evaluate(`document.querySelector(".workspace").dataset.view`);
  await key("t");
  const viewAfter = await evaluate(`document.querySelector(".workspace").dataset.view`);
  assert.notEqual(viewAfter, viewBefore);
  await key("t");
  await key("t");

  await key("s");
  const swapped = JSON.parse(await evaluate(`(() => {
    const drawer = document.getElementById("drawerSlot").getBoundingClientRect();
    const translate = document.querySelector(".pane-translate").getBoundingClientRect();
    const pdf = document.getElementById("pdfPane").getBoundingClientRect();
    return JSON.stringify({
      side: document.querySelector(".workspace").dataset.sourceSide || "",
      drawerRight: drawer.right,
      translateX: translate.x,
      pdfX: pdf.x,
      docked: document.querySelector(".workspace").hasAttribute("data-drawer-docked")
    });
  })()`));
  assert.equal(swapped.docked, true);
  assert.equal(swapped.side, "end");
  assert.ok(Math.abs(swapped.drawerRight - swapped.translateX) <= 2, JSON.stringify(swapped));
  assert.ok(swapped.pdfX > swapped.translateX, JSON.stringify(swapped));
  await key("s");

  await setWidth(1100);
  const floating = JSON.parse(await waitFor(`(() => {
    const workspace = document.querySelector(".workspace");
    if (workspace.hasAttribute("data-drawer-docked")) return "";
    const scrim = document.getElementById("drawerBackdrop");
    if (!scrim || scrim.hidden) return "";
    const root = document.querySelector(".oi-drawer");
    return JSON.stringify({
      role: root.getAttribute("role"),
      modal: root.getAttribute("aria-modal"),
      shadow: getComputedStyle(document.getElementById("drawerSlot")).boxShadow
    });
  })()`, "1100 浮动", 5000));
  assert.equal(floating.role, "dialog");
  assert.equal(floating.modal, "true");
  assert.notEqual(floating.shadow, "none");
  assert.equal(await evaluate(`document.querySelector(".oi-drawer").tagName`), "DIV");

  await evaluate(`(() => {
    const root = document.querySelector(".oi-drawer");
    const items = [...root.querySelectorAll("button")].filter((node) => !node.disabled && !node.hidden && node.tabIndex >= 0);
    items[items.length - 1].focus();
  })()`);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9
  }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9
  }, sessionId);
  const trapped = await evaluate(`(() => {
    const root = document.querySelector(".oi-drawer");
    const active = document.activeElement;
    const first = [...root.querySelectorAll("button")].find((node) => !node.disabled && !node.hidden && node.tabIndex >= 0);
    return Boolean(active && root.contains(active) && active === first);
  })()`);
  assert.equal(trapped, true);

  await evaluate(`document.querySelector(".oi-toc-item[data-page='4']").click()`);
  const jumped = JSON.parse(await waitFor(`(() => {
    const slot = document.getElementById("drawerSlot");
    if (slot && slot.hidden !== true) return "";
    const page = document.querySelector("#pages .pdf-page[data-page='4']");
    const pane = document.getElementById("pages");
    if (!page || !pane) return "";
    const pageBox = page.getBoundingClientRect();
    const paneBox = pane.getBoundingClientRect();
    return JSON.stringify({
      closed: slot.hidden,
      near: Math.abs(pageBox.top - paneBox.top) < 80,
      drawerPage: document.querySelector(".pane-translate")?.dataset.drawerPage || ""
    });
  })()`, "浮动目录跳到第 4 页", 5000));
  assert.equal(jumped.closed, true);
  assert.equal(jumped.near, true);
  assert.equal(jumped.drawerPage, "4");

  await evaluate(`document.getElementById("tocButton").click()`);
  await waitFor(`document.getElementById("drawerSlot")?.hidden === false ? "open" : ""`, "再次打开抽屉");

  await setWidth(1100, 560);
  await evaluate(`(() => {
    const scroller = document.querySelector(".oi-drawer-scroll");
    scroller.scrollTop = 36;
    document.querySelector("#oiDrawerTab-info").click();
    document.querySelector("#oiDrawerTab-toc").click();
  })()`);
  const kept = await evaluate(`document.querySelector(".oi-drawer-scroll").scrollTop`);
  assert.ok(kept >= 30, `scroll restored ${kept}`);
  await evaluate(`document.querySelector("#oiDrawerTab-recent").click()`);
  await evaluate(`document.getElementById("tocButton").click()`);
  await evaluate(`document.getElementById("tocButton").click()`);
  await waitFor(`document.querySelector("#oiDrawerTab-recent")?.getAttribute("aria-selected") === "true" ? "tab" : ""`, "回到最近页签");

  const seeded = JSON.parse(await evaluate(`(async () => {
    const { sharedLibraryStore } = await import("/lib/library-session.js");
    const store = sharedLibraryStore();
    const started = Date.now();
    let papers = [];
    while (Date.now() - started < 8000) {
      papers = await store.listPapers();
      if (papers.length) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    await store.touchPaper("drawer-other", { title: "另一篇论文", pageCount: 3, lastOpenedAt: Date.now() + 60000 });
    await store.putPage("drawer-other", 1, { pairs: [{ text: "Hello", translation: "你好", targetLang: "zh-CN" }] });
    const none = "drawer-missing";
    await store.touchPaper(none, { title: "没有副本", pageCount: 2, lastOpenedAt: Date.now() + 50000 });
    return JSON.stringify({ stored: papers.length, current: (document.getElementById("docTitle")?.textContent || "") });
  })()`));
  assert.ok(seeded.stored >= 1, JSON.stringify(seeded));
  assert.ok(seeded.current.trim().length > 0, JSON.stringify(seeded));
  await evaluate(`document.querySelector("#oiDrawerTab-info").click()`);
  await evaluate(`document.querySelector("#oiDrawerTab-recent").click()`);
  const recent = JSON.parse(await waitFor(`(() => {
    const rows = [...document.querySelectorAll(".oi-recent-row")];
    if (!rows.length) return "";
    const text = rows.map((row) => row.textContent).join("\\n");
    if (!text.includes("另一篇论文")) return "";
    return JSON.stringify({
      count: rows.length,
      text,
      meta: rows[0]?.querySelector(".oi-recent-meta")?.textContent || ""
    });
  })()`, "最近页签", 8000));
  assert.equal(recent.text.includes(seeded.current), false, recent.text);
  assert.equal(/MB|KB/.test(recent.meta), false, recent.meta);
  assert.equal(recent.count >= 1, true);

  await evaluate(`document.querySelector("[data-recent='drawer-missing']")?.click()`);
  const repick = JSON.parse(await waitFor(`(() => {
    const library = document.querySelector(".oi-library");
    const pick = library?.querySelector(".oi-lib-pick");
    if (!library || library.hidden || !pick) return "";
    return JSON.stringify({
      drawer: document.getElementById("drawerSlot").hidden !== true,
      text: library.textContent.includes("需要重新选一次"),
      focus: document.activeElement?.className || "",
      repick: Boolean(library.querySelector(".oi-lib-row.is-repick"))
    });
  })()`, "最近页签转去文献库选文件", 8000));
  assert.equal(repick.drawer, true);
  assert.equal(repick.text, true);
  assert.equal(repick.focus.includes("oi-lib-pick"), true);
  assert.equal(repick.repick, true);
  await evaluate(`document.querySelector(".oi-library .oi-lib-close")?.click()`);

  await evaluate(`document.querySelector(".oi-drawer-library")?.click()`);
  await waitFor(`document.querySelector(".oi-library")?.hidden === false ? "lib" : ""`, "打开文献库");
  assert.equal(await evaluate(`document.getElementById("drawerSlot").hidden !== true`), true);

  const info = await evaluate(`(() => {
    document.querySelector("#oiDrawerTab-info").click();
    return document.querySelector(".oi-drawer")?.textContent || "";
  })()`);
  await waitFor(`(() => {
    const text = document.querySelector("#oiDrawerPanel-info")?.textContent || "";
    if (!text.includes("已译") || !text.includes("本机保存")) return "";
    if (text.includes("mymemory") || text.includes("provider")) return "";
    return "info";
  })()`, "说明页签", 8000);
  assert.equal(info.includes("mymemory"), false);
  await evaluate(`document.querySelector(".oi-library .oi-lib-close")?.click()`);
  await waitFor(`document.querySelector(".oi-library")?.hidden !== false ? "shut" : ""`, "先关上文献库");

  await setWidth(860, 700);
  const sheet = JSON.parse(await waitFor(`(() => {
    const back = document.querySelector(".oi-drawer-back");
    if (!back) return "";
    const slot = document.getElementById("drawerSlot").getBoundingClientRect();
    return JSON.stringify({
      back: back.textContent,
      docked: document.querySelector(".workspace").hasAttribute("data-drawer-docked"),
      width: Math.round(slot.width),
      wrap: getComputedStyle(back).whiteSpace,
      height: back.getBoundingClientRect().height
    });
  })()`, "窄屏全屏", 5000));
  assert.equal(sheet.back, "← 返回译文");
  assert.equal(sheet.docked, false);
  assert.ok(sheet.width >= 800, JSON.stringify(sheet));
  assert.equal(sheet.wrap, "nowrap");
  assert.ok(sheet.height >= 28, JSON.stringify(sheet));
  await evaluate(`document.getElementById("libraryButton").click()`);
  const exclusive = JSON.parse(await waitFor(`(() => {
    const library = document.querySelector(".oi-library");
    const drawer = document.getElementById("drawerSlot");
    if (!library || library.hidden) return "";
    return JSON.stringify({ library: library.hidden === false, drawer: drawer.hidden === true });
  })()`, "窄屏和文献库互斥", 5000));
  assert.equal(exclusive.library, true);
  assert.equal(exclusive.drawer, true);

  await setWidth(320, 700);
  await evaluate(`document.getElementById("tocButton").click()`);
  const compact = JSON.parse(await waitFor(`(() => {
    const tab = document.querySelector(".oi-drawer-tab");
    if (!tab || !document.querySelector(".oi-drawer-back")) return "";
    const style = getComputedStyle(tab);
    return JSON.stringify({ size: style.fontSize, weight: style.fontWeight, wrap: style.whiteSpace });
  })()`, "340 以下页签", 5000));
  assert.equal(compact.size, "12px");
  assert.equal(compact.weight, "500");
  assert.equal(compact.wrap, "nowrap");

  await evaluate(`document.querySelector(".oi-drawer-tab").focus()`);
  await key("Escape");
  const focusId = await evaluate(`document.activeElement?.id || ""`);
  assert.equal(focusId, "tocButton");

  const openBeforeField = await evaluate(`document.getElementById("drawerSlot").hidden`);
  await evaluate(`(() => {
    const input = document.createElement("input");
    input.id = "drawerFieldProbe";
    document.body.append(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "T", shiftKey: true, bubbles: true }));
  })()`);
  assert.equal(await evaluate(`document.getElementById("drawerSlot").hidden`), openBeforeField);
  await evaluate(`document.getElementById("drawerFieldProbe")?.remove()`);

  await evaluate(`(() => {
    const box = document.getElementById("aaSingleKey");
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await key("T", { shiftKey: true });
  assert.equal(await evaluate(`document.getElementById("drawerSlot").hidden`), true);
  await evaluate(`(() => {
    const box = document.getElementById("aaSingleKey");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await key("T", { shiftKey: true });
  await waitFor(`document.getElementById("drawerSlot")?.hidden === false ? "shift" : ""`, "Shift+T 打开");
  await key("T", { shiftKey: true });
  await waitFor(`document.getElementById("drawerSlot")?.hidden === true ? "shut" : ""`, "Shift+T 关闭");
});
