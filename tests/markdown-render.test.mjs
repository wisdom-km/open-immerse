// Shared Markdown for Ask AI and notes. No network: the vendored UMD is local.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import "./helpers/load-markdown-it.mjs";
import { abortSyncHang, renderGuarded } from "./helpers/render-guard.mjs";
import {
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

test("L-03 headings", () => {
  const node = page(renderMarkdown("# 标题\n\n段中 # 不是标题"));
  assert.equal(node.querySelector("h1").textContent, "标题");
  assert.equal(node.querySelector("h2, h3"), null);
  assert.match(node.textContent, /# 不是标题/);
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

test("L-08 tables keep alignment", () => {
  const html = renderMarkdown("| 左 | 右 |\n| --- | ---: |\n| 1 | 2 |");
  const node = page(html);
  assert.equal(node.querySelectorAll("td").length, 2);
  assert.equal(node.querySelectorAll("th")[1].getAttribute("style"), "text-align:right");
  assert.equal(node.querySelectorAll("td")[1].getAttribute("style"), "text-align:right");
  assert.equal(html.includes("javascript:"), false);
});

test("L-09 links are http, https, or mailto and open in a new tab", () => {
  const node = page(renderMarkdown("见 https://example.com/a 与 [文档](http://example.com/b) 和 <mailto:hi@example.com>"));
  const links = [...node.querySelectorAll("a")];
  assert.equal(links.length, 3);
  assert.deepEqual(links.map((el) => el.getAttribute("href")), [
    "https://example.com/a",
    "http://example.com/b",
    "mailto:hi@example.com"
  ]);
  for (const link of links) {
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  }
});

test("L-10 javascript, data, and ftp are not anchors", () => {
  const node = page(renderMarkdown("[x](javascript:alert(1)) [y](data:text/html,hi) [z](ftp://example.com) //example.com"));
  assert.equal(node.querySelector("a"), null);
  assert.match(node.textContent, /javascript:alert\(1\)/);
  assert.match(node.textContent, /ftp:\/\/example.com/);
  assert.equal(node.innerHTML.includes("<a"), false);
});

test("L-11 raw HTML is text", () => {
  const html = renderMarkdown("<script>alert(1)</script> <b onclick=\"x\">粗</b>");
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("<b"), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const node = page(html);
  assert.equal(node.querySelector("script, b"), null);
  assert.match(node.textContent, /<script>alert\(1\)<\/script>/);
});

test("L-12 images are not loaded", () => {
  const html = renderMarkdown("![示意图](https://cdn.example/a.png) ![](javascript:alert(1))");
  const node = page(html);
  assert.equal(node.querySelector("img"), null);
  assert.equal(html.includes("cdn.example"), false);
  assert.equal(html.includes("src="), false);
  assert.match(node.textContent, /图片：示意图/);
  assert.match(node.textContent, /!\[\]\(javascript:alert\(1\)\)/);
});

test("L-13 display and inline math render, unsafe commands stay text", () => {
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

test("L-14 and D1 a display formula stays inside the list item", () => {
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

test("L-15 streaming prefixes do not throw or emit an active tag", () => {
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

test("L-16 five thousand characters render in under 16ms", () => {
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
  assert.match(html, /<a href="https:\/\/example.com\/a" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, /<code class="language-js">/);
  assert.match(html, /<input type="checkbox" disabled checked>/);
  assert.equal(html.includes("onclick"), false);
  assert.equal(html.includes("onmouseover"), false);
  assert.equal(/<a\b[^>]*javascript/i.test(html), false);
  assert.match(html, /&lt;a href=&quot;javascript:alert\(1\)&quot;&gt;/);
  assert.equal(/<input[^>]*type="text"/.test(html), false);
  assert.match(html, /&lt;input type=&quot;text&quot;/);
});

test("A1 a synchronous infinite loop is aborted by terminating the worker", async () => {
  const elapsed = await abortSyncHang(400);
  assert.ok(elapsed < 2000, `hang lived ${elapsed.toFixed(0)}ms`);
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
