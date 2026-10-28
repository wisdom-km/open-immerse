import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const pageTokens = readFileSync(join(root, "ui/tokens.css"), "utf8");

const EXTENSION_PAGES = [
  "popup/popup.html",
  "options/options.html",
  "pdf/viewer.html",
  "documents/documents.html",
  "learning/learning.html"
];

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function splitTopLevel(input, separator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function readBlock(src, openBrace) {
  let depth = 0;
  let quote = "";
  for (let i = openBrace; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { inner: src.slice(openBrace + 1, i), end: i + 1 };
    }
  }
  throw new Error("unclosed CSS block");
}

function findPreludeEnd(src, start) {
  let depth = 0;
  let quote = "";
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if ((ch === "{" || ch === ";") && depth === 0) return i;
  }
  return src.length;
}

function styleRules(css) {
  const src = stripComments(css);
  const out = [];
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (i >= src.length) break;
    if (src[i] === "@") {
      const headerEnd = findPreludeEnd(src, i);
      const header = src.slice(i, headerEnd).trim().toLowerCase();
      if (src[headerEnd] === "{") {
        const block = readBlock(src, headerEnd);
        const name = header.split(/[\s({]/)[0];
        if (name === "@media" || name === "@supports" || name === "@layer" || name === "@container") {
          out.push(...styleRules(block.inner));
        }
        i = block.end;
        continue;
      }
      i = headerEnd < src.length ? headerEnd + 1 : src.length;
      continue;
    }
    const headerEnd = findPreludeEnd(src, i);
    if (src[headerEnd] !== "{") break;
    const selector = src.slice(i, headerEnd).trim();
    const block = readBlock(src, headerEnd);
    if (selector) out.push({ selector, body: block.inner });
    i = block.end;
  }
  return out;
}

function subjectOf(selector) {
  let depth = 0;
  let quote = "";
  let lastBreak = -1;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ">" || ch === "+" || ch === "~")) lastBreak = i;
    else if (depth === 0 && /\s/.test(ch)) {
      let j = i;
      while (j < selector.length && /\s/.test(selector[j])) j += 1;
      if (j < selector.length && !">+~".includes(selector[j])) lastBreak = j - 1;
      i = j - 1;
    }
  }
  return selector.slice(lastBreak + 1).trim();
}

function isHostSubject(subject) {
  const selector = subject.trim();
  if (!selector) return false;
  if (/^(html|body)(?![-\w])/.test(selector)) return true;
  if (/(^|[^-\w]):root(?![-\w])/.test(selector)) return true;
  const wrapped = selector.match(/^:(?:is|where|matches)\(([\s\S]*)\)$/);
  if (!wrapped) return false;
  return splitTopLevel(wrapped[1], ",").some((part) => isHostSubject(part));
}

function declarations(body) {
  const names = [];
  for (const part of splitTopLevel(body, ";")) {
    const text = part.trim();
    if (!text) continue;
    const colon = text.indexOf(":");
    if (colon === -1) continue;
    names.push(text.slice(0, colon).trim());
  }
  return names;
}

function hostLeaks(css) {
  const leaks = [];
  for (const rule of styleRules(css)) {
    for (const selector of splitTopLevel(rule.selector, ",")) {
      const subject = subjectOf(selector);
      if (!isHostSubject(subject)) continue;
      leaks.push({
        selector: selector.trim(),
        subject,
        properties: declarations(rule.body)
      });
    }
  }
  return leaks;
}

function customProps(body) {
  const props = {};
  for (const part of splitTopLevel(body, ";")) {
    const text = part.trim();
    if (!text.startsWith("--")) continue;
    const colon = text.indexOf(":");
    const name = text.slice(0, colon).trim();
    props[name] = text.slice(colon + 1).trim().replace(/\s+/g, " ");
  }
  return props;
}

function contentScriptCss(doc) {
  return (doc.content_scripts || []).flatMap((block) => block.css || []);
}

test("host-selector detector flags rules on :root, html, and body", () => {
  const sample = [
    ":root { color-scheme: dark; --oi-bg: #12151c; }",
    "html, body { margin: 0; }",
    "html.oi-ext { color-scheme: dark; }",
    ":is(:root, .oi-fab) { color-scheme: dark; }",
    "@media (min-width: 1px) { body.oi-settings { color-scheme: light; } }",
    "html[data-oi-style=\"line\"] .oi-translation { color: red; }",
    ".oi-translation:not(.oi-inline) + :is(p, blockquote, figure) { margin-top: 0; }"
  ].join("\n");
  const leaks = hostLeaks(sample);
  assert.deepEqual(leaks.map((leak) => leak.subject), [
    ":root",
    "html",
    "body",
    "html.oi-ext",
    ":is(:root, .oi-fab)",
    "body.oi-settings"
  ]);
  assert.equal(leaks[0].properties.includes("color-scheme"), true);
  assert.equal(leaks.some((leak) => leak.subject.startsWith(".oi-translation")), false);
});

test("content-script CSS does not set color-scheme or other rules on :root, html, or body", () => {
  const files = contentScriptCss(manifest);
  assert.deepEqual(files, ["ui/tokens-content.css", "content/content.css"]);
  for (const rel of files) {
    const css = readFileSync(join(root, rel), "utf8");
    const leaks = hostLeaks(css);
    assert.deepEqual(leaks, [], rel);
    for (const rule of styleRules(css)) {
      for (const selector of splitTopLevel(rule.selector, ",")) {
        assert.equal(isHostSubject(subjectOf(selector)), false, `${rel}: ${selector.trim()}`);
      }
      if (declarations(rule.body).includes("color-scheme")) {
        assert.equal(/^(html|body|:root)\b/.test(rule.selector.trim()), false, rel);
      }
    }
  }
});

test("content tokens scope color-scheme to extension chrome and match page tokens", () => {
  const pageRoot = styleRules(pageTokens).find((rule) => rule.selector.trim() === ":root");
  assert.ok(pageRoot);
  assert.match(pageRoot.body, /color-scheme:\s*dark/);
  const host = readFileSync(join(root, "ui/tokens-content.css"), "utf8");
  const rules = styleRules(host);
  assert.equal(rules.length, 1);
  assert.deepEqual(
    splitTopLevel(rules[0].selector, ",").map((selector) => selector.trim()),
    [".oi-fab", ".oi-toast", ".oi-selection-card", ".oi-caption"]
  );
  assert.match(rules[0].body, /color-scheme:\s*dark/);
  assert.equal(hostLeaks(host).length, 0);
  // --oi-fab-slot is runtime-set on <html> by content/toolbar.js (syncFabSlot).
  // Copying the 72px token onto .oi-toast / .oi-selection-card overrides that
  // inline value, so a dragged FAB leaves the toast at the fallback. content.css
  // already uses var(--oi-fab-slot, 72px) when <html> has not set it.
  const pageProps = customProps(pageRoot.body);
  const hostProps = customProps(rules[0].body);
  delete pageProps["--oi-fab-slot"];
  assert.deepEqual(hostProps, pageProps);
  assert.equal(host.includes(".mark"), false);
  assert.equal(declaresRuntimeSlot(host), false);
});

function declaresRuntimeSlot(css) {
  return styleRules(css).some((rule) => Object.hasOwn(customProps(rule.body), "--oi-fab-slot"));
}

test("content tokens never declare runtime-owned --oi-fab-slot so html values inherit", () => {
  const host = readFileSync(join(root, "ui/tokens-content.css"), "utf8");
  assert.equal(declaresRuntimeSlot(host), false);
  assert.equal(/--oi-fab-slot\s*:/.test(stripComments(host)), false);
});

test("extension pages still load the :root token sheet", () => {
  for (const rel of EXTENSION_PAGES) {
    const html = readFileSync(join(root, rel), "utf8");
    assert.match(html, /href="(?:\.\.\/)?ui\/tokens\.css"/, rel);
    assert.equal(html.includes("tokens-content.css"), false, rel);
  }
  assert.equal(contentScriptCss(manifest).includes("ui/tokens.css"), false);
});
