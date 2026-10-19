// Shared Markdown for Ask AI and notes. No network: the vendored UMD is local.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import "./helpers/load-markdown-it.mjs";
import { abortWorker, openHangWorker, renderGuarded } from "./helpers/render-guard.mjs";
import {
  markdownItSetup,
  renderAskAnswer,
  renderMarkdown,
  sanitizeMarkdownHtml
} from "../lib/ask-render.js";
import { renderNoteMarkdown } from "../lib/notes-view-model.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function page(html) {
  const parsed = parseHTML(`<!doctype html><body><div id="o">${html}</div></body>`);
  return parsed.document.getElementById("o");
}

function contrastRatio(foreground, background) {
  const channel = (hex, offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  const lighter = Math.max(lum(foreground), lum(background));
  const darker = Math.min(lum(foreground), lum(background));
  return (lighter + 0.05) / (darker + 0.05);
}

test("L-01 paragraphs keep a blank line and turn a single newline into br", () => {
  const node = page(renderMarkdown("第一段\n还在这一段\n\n第二段"));
  assert.equal(node.querySelectorAll("p").length, 2);
  assert.match(node.querySelector("p").innerHTML, /第一段<br>\s*还在这一段/);
  assert.match(node.querySelectorAll("p")[1].textContent, /第二段/);
});

test("L-02 bold, italic, and strikethrough", () => {
  const node = page(renderMarkdown("**粗** *斜* ~~删~~"));
  assert.equal(node.querySelector("strong").textContent, "粗");
  assert.equal(node.querySelector("em").textContent, "斜");
  assert.equal(node.querySelector("s").textContent, "删");
});

test("L-03 headings, including ###, are 15px/600", () => {
  const node = page(renderMarkdown("# 一级\n\n## 二级\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级\n\n段中 # 不是标题"));
  for (const [level, text] of [[1, "一级"], [2, "二级"], [3, "三级"], [4, "四级"], [5, "五级"], [6, "六级"]]) {
    assert.equal(node.querySelector(`h${level}`).textContent, text);
  }
  assert.match(node.textContent, /# 不是标题/);
  for (const [file, scope] of [["pdf/ask-panel.css", ".oi-ask-answer"], ["pdf/notes-panel.css", ".oi-note-body"]]) {
    const css = readFileSync(join(root, file), "utf8");
    for (let level = 1; level <= 6; level += 1) {
      assert.match(
        css,
        new RegExp(`${scope.replace(".", "\\.")} h${level}\\s*\\{[^}]*font-size:\\s*15px;[^}]*font-weight:\\s*600`),
        `${file} h${level}`
      );
    }
  }
});

test("L-04 lists keep a start number", () => {
  const html = renderMarkdown("3. 三\n4. 四");
  assert.match(html.replace(/>\s+</g, "><"), /<ol start="3"><li>三<\/li><li>四<\/li><\/ol>/);
  const one = renderMarkdown("1. 一\n2. 二\n\n- 无序");
  assert.match(one.replace(/>\s+</g, "><"), /<ol><li>一<\/li><li>二<\/li><\/ol>/);
  assert.equal(page(one).querySelectorAll("ul li").length, 1);
});

test("L-05 task lists", () => {
  const node = page(renderMarkdown("- [ ] 待办\n- [x] 完成"));
  const boxes = [...node.querySelectorAll("input")];
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].getAttribute("type"), "checkbox");
  assert.equal(boxes[0].hasAttribute("disabled"), true);
  assert.equal(boxes[0].hasAttribute("checked"), false);
  assert.equal(boxes[1].hasAttribute("checked"), true);
  assert.match(node.textContent, /待办/);
  assert.match(node.textContent, /完成/);
});

test("L-06 blockquotes", () => {
  const node = page(renderMarkdown("> 引用一句"));
  assert.equal(node.querySelector("blockquote").textContent.trim(), "引用一句");
});

test("L-07 fences and inline code are not math", () => {
  const node = page(renderMarkdown("行内 `$5` 与\n\n```\nconst price = $5;\n```"));
  assert.equal(node.querySelector("code").textContent, "$5");
  const pre = node.querySelector("pre");
  assert.match(pre.textContent, /\$5/);
  assert.equal(pre.querySelector(".katex, .oi-note-math"), null);
  assert.equal(node.querySelector(".katex, .oi-note-math"), null);
  assert.equal(pre.textContent.includes("```"), false);
});

test("L-09 tables keep alignment", () => {
  const html = renderMarkdown("| 左 | 右 |\n| --- | ---: |\n| 1 | 2 |");
  const node = page(html);
  assert.equal(node.querySelectorAll("td").length, 2);
  assert.equal(node.querySelectorAll("th")[1].getAttribute("style"), "text-align:right");
  assert.equal(node.querySelectorAll("td")[1].getAttribute("style"), "text-align:right");
  assert.equal(html.includes("javascript:"), false);
  for (const file of ["pdf/ask-panel.css", "pdf/notes-panel.css"]) {
    const css = readFileSync(join(root, file), "utf8");
    assert.match(css, /padding:\s*6px 10px/, file);
    assert.match(css, /font-size:\s*13px/, file);
    assert.match(css, /overflow-x:\s*auto/, file);
    assert.match(css, /th\s*\{[^}]*background:\s*var\(--oi-reader-well\)/, file);
  }
});

test("L-08 links keep the original URL and open in a new tab", () => {
  const url = "https://x.com/a%20b?a=1&b=2#frag";
  const node = page(renderMarkdown(`见 ${url} 与 [文档](http://example.com/b) 和 <mailto:hi@example.com>`));
  const links = [...node.querySelectorAll("a")];
  assert.equal(links.length, 3);
  assert.equal(links[0].href, url);
  assert.equal(links[0].getAttribute("href"), url);
  assert.equal(links[0].getAttribute("title"), url);
  assert.deepEqual(links.slice(1).map((el) => el.getAttribute("href")), [
    "http://example.com/b",
    "mailto:hi@example.com"
  ]);
  for (const link of links) {
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer nofollow");
    assert.equal(link.getAttribute("title"), link.getAttribute("href"));
  }
  const blocked = page(renderMarkdown("[x](javascript:alert(1)) [y](data:text/html,hi) [z](ftp://example.com) //example.com"));
  assert.equal(blocked.querySelector("a"), null);
  assert.match(blocked.textContent, /javascript:alert\(1\)/);
  assert.match(blocked.textContent, /ftp:\/\/example.com/);
});

test("L-10 raw HTML is text", () => {
  const html = renderMarkdown("<script>alert(1)</script> <b onclick=\"x\">粗</b>");
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("<b"), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const node = page(html);
  assert.equal(node.querySelector("script, b"), null);
  assert.match(node.textContent, /<script>alert\(1\)<\/script>/);
});

test("L-11 images are links and are not loaded", () => {
  const html = renderMarkdown("![示意图](https://cdn.example/a.png) ![](javascript:alert(1))");
  const node = page(html);
  const link = node.querySelector("a");
  assert.equal(node.querySelector("img"), null);
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes("src="), false);
  assert.equal(link.getAttribute("href"), "https://cdn.example/a.png");
  assert.equal(link.getAttribute("title"), "https://cdn.example/a.png");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer nofollow");
  assert.equal(link.textContent, "图片：示意图");
  assert.match(node.textContent, /!\[\]\(javascript:alert\(1\)\)/);
  const notes = page(renderNoteMarkdown("![示意图](https://cdn.example/a.png)"));
  assert.equal(notes.querySelector("img"), null);
  assert.equal(notes.querySelector("a").getAttribute("href"), "https://cdn.example/a.png");
});

test("math inside a URL stays in the href", () => {
  const cases = ["[t](http://x.com/$a$)", "<http://x.com/$a$b>"];
  for (const source of cases) {
    for (const html of [renderMarkdown(source), renderNoteMarkdown(source)]) {
      const node = page(html);
      const link = node.querySelector("a");
      assert.ok(link, source);
      const href = link.getAttribute("href");
      assert.equal(href.includes("<"), false, `${source} href=${href}`);
      assert.equal(href.includes("span"), false, `${source} href=${href}`);
      assert.match(href, /\$a\$/, `${source} href=${href}`);
      assert.equal(node.querySelector("a span"), null, source);
      assert.equal(node.querySelectorAll("a").length, 1, source);
    }
  }
  const shown = page(renderMarkdown("[$x$](https://example.com/a)"));
  assert.equal(shown.querySelector("a").getAttribute("href"), "https://example.com/a");
  assert.match(shown.querySelector("a").innerHTML, /oi-note-math|katex/);
});

test("L-12 display and inline math render, unsafe commands stay text", () => {
  const engine = {
    renderToString(tex, options) {
      return `<span class="katex${options.displayMode ? "-display" : ""}">${tex}</span>`;
    }
  };
  const html = renderMarkdown("行内 $x$ 与\n\n$$\ny\n$$", engine);
  assert.match(html, /<span class="katex">x<\/span>/);
  assert.match(html, /<span class="katex-display">\s*y\s*<\/span>/);
  const blocked = renderMarkdown("$\\href{https://example.com}{x}$", engine);
  assert.equal(blocked.includes("class=\"katex\""), false);
  assert.match(blocked, /\\href\{https:\/\/example.com\}\{x\}/);
});

test("L-13 and D1 a display formula stays inside the list item", () => {
  const html = renderMarkdown("1. 第一\n\n$$\na\n$$\n2. 第二");
  const node = page(html);
  const items = [...node.querySelectorAll("ol li")];
  assert.equal(items.length, 2);
  assert.match(items[0].innerHTML, /oi-note-math|katex/);
  assert.match(items[0].textContent, /第一/);
  assert.match(items[1].textContent, /第二/);
  assert.equal(node.querySelector("ol").getAttribute("start"), null);
  const unpaired = page(renderMarkdown("前文 $$ 后文\n\n价格 $5 没有配对"));
  assert.match(unpaired.textContent, /\$\$/);
  assert.match(unpaired.textContent, /\$5/);
  assert.equal(unpaired.querySelector(".oi-note-math, .katex"), null);
});

test("L-14 streaming prefixes do not throw or emit an active tag", () => {
  const doc = [
    "看 https://example.com",
    "",
    "- [ ] 任务",
    "",
    "$$",
    "x",
    "$$",
    "",
    "```",
    "$5",
    "```",
    "",
    "![图](https://cdn.example/a.png)"
  ].join("\n");
  for (let index = 0; index <= doc.length; index += 1) {
    const html = renderMarkdown(doc.slice(0, index));
    assert.equal(/<\s*(?:script|img|iframe|object|embed)\b/i.test(html), false, `prefix ${index}`);
    assert.equal(/javascript\s*:/i.test(html), false, `prefix ${index}`);
  }
});

test("L-15 five thousand characters render in under 16ms", () => {
  let chunk = "段落 **粗体** 与 [链接](https://example.com/a)。\n\n| 左 | 右 |\n| --- | ---: |\n| 1 | 2 |\n\n";
  while (chunk.length < 5000) chunk += chunk;
  chunk = chunk.slice(0, 5000);
  assert.equal(chunk.length, 5000);
  renderMarkdown(chunk);
  const times = [];
  for (let index = 0; index < 7; index += 1) {
    const started = performance.now();
    renderMarkdown(chunk);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const median = times[3];
  assert.ok(median < 16, `median ${median.toFixed(2)}ms from ${times.map((n) => n.toFixed(2)).join(", ")}`);
});

test("Ask and notes share one renderer, including a fence and an ordered start", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.html"), "utf8");
  assert.match(viewer, /vendor\/markdown-it\/markdown-it\.min\.js/);
  const source = "3. 从三开始\n4. 四\n\n```\nconst x = 1;\n```\n\n[去](https://example.com)";
  assert.equal(renderNoteMarkdown(source), renderAskAnswer(source));
  const node = page(renderNoteMarkdown(source));
  assert.equal(node.querySelector("ol").getAttribute("start"), "3");
  assert.equal(node.querySelectorAll("ol li").length, 2);
  assert.match(node.querySelector("pre").textContent, /const x = 1;/);
  assert.equal(node.querySelector("pre").textContent.includes("```"), false);
  assert.equal(node.querySelector("a").getAttribute("href"), "https://example.com");
});

test("A1 structural tags keep safe attributes and drop handlers", () => {
  const html = sanitizeMarkdownHtml([
    '<ol start="3" onclick="alert(1)"><li>三</li></ol>',
    '<th style="text-align:right" onmouseover="x">右</th>',
    '<a href="https://example.com/a" onclick="alert(1)">文档</a>',
    '<a href="javascript:alert(1)">坏</a>',
    '<code class="language-js" onclick="x">let x</code>',
    '<input type="checkbox" checked>',
    '<input type="text" value="no">'
  ].join(""));
  assert.match(html, /<ol start="3">/);
  assert.match(html, /<th style="text-align:right">/);
  assert.match(html, /<a href="https:\/\/example.com\/a" target="_blank" rel="noopener noreferrer nofollow">/);
  assert.match(html, /<code class="language-js">/);
  assert.match(html, /<input type="checkbox" disabled checked>/);
  assert.equal(html.includes("onclick"), false);
  assert.equal(html.includes("onmouseover"), false);
  assert.equal(/<a\b[^>]*javascript/i.test(html), false);
  assert.match(html, /&lt;a href=&quot;javascript:alert\(1\)&quot;&gt;/);
  assert.equal(/<input[^>]*type="text"/.test(html), false);
  assert.match(html, /&lt;input type=&quot;text&quot;/);
});

test("A1 a synchronous infinite loop is aborted by terminating the worker", { timeout: 5000 }, async (t) => {
  const worker = openHangWorker();
  let exited = false;
  worker.once("exit", () => { exited = true; });
  let settled = false;
  const stop = () => {
    if (settled) return Promise.resolve();
    settled = true;
    return worker.terminate();
  };
  t.after(stop);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("hang was not aborted within 2s")), 2000);
  });
  try {
    const elapsed = await Promise.race([abortWorker(worker, 400), deadline]);
    assert.ok(elapsed < 2000, `hang lived ${elapsed.toFixed(0)}ms`);
    if (!exited) await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(exited, true, "abort resolved without terminating the worker");
  } finally {
    clearTimeout(timer);
    await stop();
  }
});

test("markdown-it leaves HTML off and does not emit img", () => {
  const setup = markdownItSetup();
  assert.equal(setup.html, false);
  const html = setup.imageRule([{
    content: "示意图",
    attrGet(name) { return name === "src" ? "https://cdn.example/a.png" : ""; }
  }], 0);
  assert.equal(/<img\b/i.test(html), false);
  assert.match(html, /<a\b/);
  assert.match(html, /图片：示意图/);
});

test("L-16 links have color, hover, and focus in both panels", () => {
  const tokens = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");
  const darkStart = tokens.indexOf('.oi-reader-app[data-reader-theme="dark"]');
  const dark = tokens.slice(darkStart, tokens.indexOf(".oi-reader-app[data-reader-fs-band", darkStart));
  assert.match(tokens, /--oi-reader-link:\s*#0B4A8C/i);
  assert.match(tokens, /--oi-reader-link-hover:\s*#08366A/i);
  assert.match(dark, /--oi-reader-link:\s*#B7CFFF/i);
  assert.match(dark, /--oi-reader-link-hover:\s*#D6E4FF/i);
  for (const background of ["#FFFFFF", "#FCFAF6", "#F6F3EC", "#F4F0E9", "#F2F5F0"]) {
    assert.ok(contrastRatio("#0B4A8C", background) >= 4.5, background);
    assert.ok(contrastRatio("#08366A", background) >= 4.5, background);
  }
  for (const background of ["#232427", "#1C1D1F"]) {
    assert.ok(contrastRatio("#B7CFFF", background) >= 4.5, background);
    assert.ok(contrastRatio("#D6E4FF", background) >= 4.5, background);
  }
  for (const file of ["pdf/ask-panel.css", "pdf/notes-panel.css"]) {
    const css = readFileSync(join(root, file), "utf8");
    assert.match(css, /a:hover/, file);
    assert.match(css, /a:focus/, file);
    assert.match(css, /color:\s*var\(--oi-reader-link\)/, file);
    assert.match(css, /color:\s*var\(--oi-reader-link-hover\)/, file);
  }
});

test("A1 an unclosed tag and a long dollar run finish under the worker cap", async () => {
  const nasty = `${"<".repeat(20000)}${"$".repeat(8000)}\`\`\`${"x".repeat(2000)}`;
  const results = await renderGuarded([nasty], { totalMs: 4000 });
  assert.equal(results.length, 1);
  assert.equal(results[0].error, undefined);
  assert.equal(/<\s*(?:script|img)\b/i.test(results[0].html), false);
});

test("D2 dark pin and ghost hover text is paper on mine", () => {
  const css = readFileSync(join(root, "pdf/notes-panel.css"), "utf8");
  const tokens = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");
  const darkStart = tokens.indexOf('.oi-reader-app[data-reader-theme="dark"]');
  const dark = tokens.slice(darkStart, tokens.indexOf(".oi-reader-app[data-reader-fs-band", darkStart));
  assert.match(dark, /--oi-reader-paper:\s*#1C1D1F/i);
  assert.match(dark, /--oi-reader-mine:\s*#B98CC6/i);
  assert.match(css, /\.oi-note-pin:hover,\s*\.oi-note-ghost:hover\s*\{[^}]*color:\s*#fff/);
  assert.match(css, /\.oi-reader-app\[data-reader-theme="dark"\] \.oi-note-pin:hover[\s\S]*color:\s*var\(--oi-reader-paper\)/);
  assert.match(css, /\.oi-reader\[data-reader-theme="dark"\] \.oi-note-ghost:hover/);
  const hover = css.slice(css.indexOf(".oi-note-pin:hover"));
  const lightAt = hover.indexOf("color: #fff");
  const darkAt = hover.indexOf("color: var(--oi-reader-paper)");
  assert.ok(lightAt >= 0 && darkAt > lightAt);
  assert.ok(contrastRatio("#1C1D1F", "#B98CC6") >= 4.5);
});
