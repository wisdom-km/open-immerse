import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { bindSecretInput, secretDraftError } from "../lib/secret-field.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "sk-live-key-1234";

function mount() {
  const { document } = parseHTML("<!doctype html><div id='host'></div>");
  const input = document.createElement("input");
  input.setAttribute("aria-label", "API 密钥");
  input.placeholder = "粘贴 API 密钥";
  document.getElementById("host").append(input);
  return { document, input };
}

function clearButton(document) {
  return document.querySelector("[aria-label='清空密钥']");
}

test("a saved key stays in the password field when focused", () => {
  const { document, input } = mount();
  let saved = KEY;
  const field = bindSecretInput(input, { getValue: () => saved });
  assert.equal(input.type, "password");
  assert.equal(input.getAttribute("autocomplete"), "off");
  assert.equal(input.getAttribute("spellcheck"), "false");
  assert.equal(input.value, KEY);
  assert.equal(input.value.includes("•"), false);
  assert.equal(input.value.includes("*"), false);
  input.focus();
  assert.equal(input.value, KEY);
  assert.equal(input.placeholder, "粘贴 API 密钥");
  input.value = "   ";
  const spaces = field.commit();
  assert.equal(spaces.ignored, true);
  assert.equal(input.value, KEY);
  assert.equal(saved, KEY);
  input.value = "";
  const cleared = field.commit();
  assert.equal(cleared.pendingClear, true);
  assert.equal(cleared.value, "");
  assert.equal(input.value, "");
  assert.equal(saved, KEY);
  assert.equal(document.querySelector("[aria-label='显示']"), null);
  assert.equal([...document.querySelectorAll("button")].some((button) => /显示|隐藏|眼睛/.test(button.textContent || "")), false);
});

test("removing the field drops its pagehide listener", async () => {
  const { document, input } = mount();
  const view = document.defaultView;
  const added = [];
  const removed = [];
  const add = view.addEventListener.bind(view);
  const drop = view.removeEventListener.bind(view);
  view.addEventListener = (type, fn, ...rest) => {
    if (type === "pagehide") added.push(fn);
    return add(type, fn, ...rest);
  };
  view.removeEventListener = (type, fn, ...rest) => {
    if (type === "pagehide") removed.push(fn);
    return drop(type, fn, ...rest);
  };
  bindSecretInput(input, { getValue: () => KEY });
  assert.equal(added.length, 1);
  input.parentElement.parentElement.remove();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(removed, added);
});

test("× clears immediately, keeps focus, and does not write a mask", () => {
  const { document, input } = mount();
  let saved = KEY;
  const writes = [];
  const bound = bindSecretInput(input, {
    getValue: () => saved,
    onClear: () => {
      writes.push(input.value);
      saved = "";
    }
  });
  input.value = "";
  input.dispatchEvent(new document.defaultView.Event("input", { bubbles: true }));
  assert.equal(clearButton(document), null);
  input.value = KEY;
  input.dispatchEvent(new document.defaultView.Event("input", { bubbles: true }));
  const button = clearButton(document);
  assert.equal(button.type, "button");
  assert.equal(button.getAttribute("aria-label"), "清空密钥");
  const down = new document.defaultView.Event("mousedown", { bubbles: true, cancelable: true });
  button.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  button.click();
  assert.equal(input.value, "");
  assert.equal(saved, "");
  assert.deepEqual(writes, [""]);
  assert.equal(writes.some((value) => /[•*]/.test(value)), false);
  assert.equal(clearButton(document), null);
  assert.equal(input.placeholder, "粘贴 API 密钥");
  input.dispatchEvent(new document.defaultView.Event("blur", { bubbles: true }));
  assert.equal(input.value, "");
  assert.equal(saved, "");
  assert.equal(document.body.textContent.includes("撤销"), false);
  assert.equal(document.body.textContent.includes(KEY), false);
  bound.paint();
  assert.equal(input.value, "");

  let again = KEY;
  const manualDelete = bindSecretInput(document.createElement("input"), {
    getValue: () => again,
    onClear: () => { again = ""; }
  });
  const fresh = manualDelete.root.querySelector("input");
  document.getElementById("host").append(manualDelete.root);
  fresh.value = "";
  const deleted = manualDelete.commit();
  assert.equal(deleted.ignored, true);
  assert.equal(again, "");
  assert.equal(fresh.value, "");
});

test("a button card keeps the stored key until save, and a mask is refused", () => {
  const { document, input } = mount();
  let saved = KEY;
  const manual = bindSecretInput(input, { getValue: () => saved });
  clearButton(document).click();
  assert.equal(input.value, "");
  assert.equal(saved, KEY);
  const blurred = manual.commit();
  assert.equal(blurred.pendingClear, true);
  assert.equal(input.value, "");
  assert.equal(saved, KEY);
  assert.equal(input.placeholder, "粘贴 API 密钥");
  const reloaded = mount();
  bindSecretInput(reloaded.input, { getValue: () => saved });
  assert.equal(reloaded.input.value, KEY);
  assert.equal(clearButton(reloaded.document) != null, true);

  saved = input.value;
  const cleared = bindSecretInput(input, { getValue: () => saved });
  cleared.paint();
  assert.equal(saved, "");
  assert.equal(input.value, "");

  const again = mount();
  let stored = KEY;
  const field = bindSecretInput(again.input, {
    getValue: () => stored,
    onClear: () => { stored = again.input.value; }
  });
  again.input.value = `  ${KEY}  `;
  const trimmed = field.commit();
  assert.equal(trimmed.value, KEY);
  stored = trimmed.value;
  assert.equal(stored.includes("•"), false);
  again.input.value = "sk-live key";
  const spaced = field.commit();
  assert.equal(spaced.invalid, true);
  assert.equal(again.input.value, "sk-live key");
  assert.equal(stored, KEY);
  again.input.value = "ark••••a801";
  const masked = field.commit();
  assert.equal(masked.invalid, true);
  assert.equal(secretDraftError("ark••••a801").includes(KEY), false);
  assert.equal(again.input.value, "ark••••a801");
  assert.equal(stored, KEY);
  assert.equal(stored.includes("•"), false);
  assert.equal(stored.includes("*"), false);
  const chrome = `${again.input.getAttribute("placeholder")} ${again.input.getAttribute("aria-label")} ${again.input.getAttribute("title") || ""}`;
  assert.equal(chrome.includes(KEY), false);
  assert.equal(chrome.includes("•"), false);
});

test("key chrome uses tokens and every key slot clears the same way", () => {
  const css = readFileSync(join(root, "options/options.css"), "utf8");
  const rules = css.slice(css.indexOf(".oi-key-field {"), css.indexOf("body.oi-settings .set-key-line [data-secret-saved]"));
  assert.match(rules, /width:\s*24px/);
  assert.match(rules, /height:\s*24px/);
  assert.equal(/#[0-9a-fA-F]{3,8}/.test(rules), false);
  assert.match(rules, /var\(--oi-text-muted\)/);
  assert.match(rules, /var\(--oi-danger\)/);
  assert.match(rules, /var\(--oi-focus\)/);
  const options = readFileSync(join(root, "options/options.js"), "utf8");
  const formula = readFileSync(join(root, "lib/formula-settings-ui.js"), "utf8");
  assert.equal(options.includes("移除密钥"), false);
  assert.equal(formula.includes("移除密钥"), false);
  assert.equal(options.includes("bound.reveal"), false);
  assert.equal(formula.includes("bound.reveal"), false);
  assert.match(options, /onClear: \(\) => clearProviderKey/);
  assert.match(options, /onClear: \(\) => \{ void clearPdfCloud\(\); \}/);
  assert.match(formula, /onClear: \(\) => onRemove\?\.\(\)/);
  assert.equal(options.includes("已移除"), false);
  assert.equal(formula.includes("显示"), false);
});
