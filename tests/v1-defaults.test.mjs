import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_FEATURES, resolveFeatures } from "../lib/features.js";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, migrateSettings } from "../lib/storage.js";
import {
  CHROME_CLASS_RE,
  HARD_SKIP_SELECTOR,
  classLooksChrome,
  isChromeMetaText,
  pickPreset
} from "../lib/site-presets.js";
import { BLOCK_SELECTOR, shouldCollectNode } from "../lib/page-scan.js";
import { isAlwaysBanned, isInMetaRail } from "../lib/site-presets.js";

function fakeNode({ className = "", hits = [], text = "Hello world about AI tools", left = 120, width = 480 } = {}) {
  const node = {
    tagName: "P",
    className,
    nextElementSibling: null,
    matches(sel) {
      return hits.some((hit) => sel.includes(hit));
    },
    closest(sel) {
      return hits.some((hit) => sel.includes(hit)) ? node : null;
    },
    querySelector() {
      return null;
    },
    getBoundingClientRect() {
      return { width, height: 40, left, right: left + width, top: 180 };
    },
    cloneNode() {
      return {
        querySelectorAll() {
          return { forEach() {} };
        },
        innerText: text,
        textContent: text
      };
    }
  };
  return node;
}

test("default translateScope is article and settingsVersion is 7", () => {
  assert.equal(DEFAULT_SETTINGS.translateScope, "article");
  assert.equal(DEFAULT_SETTINGS.settingsVersion, SETTINGS_VERSION);
  assert.equal(SETTINGS_VERSION, 7);
});

test("v1 features stay on; youtube/x stay off", () => {
  assert.equal(DEFAULT_FEATURES.webpage, true);
  assert.equal(DEFAULT_FEATURES.learning, true);
  assert.equal(DEFAULT_FEATURES.documents, true);
  assert.equal(DEFAULT_FEATURES.youtube, false);
  assert.equal(DEFAULT_FEATURES.x, false);
});

test("subtitleEnabled does not flip youtube/x on", () => {
  const features = resolveFeatures({ subtitleEnabled: true, features: { youtube: false, x: false } });
  assert.equal(features.youtube, false);
  assert.equal(features.x, false);
});

test("migrateSettings forces article when stored scope is page even without version", () => {
  const stored = { translateScope: "page" };
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  const { settings, changed } = migrateSettings(merged, stored);
  assert.equal(changed, true);
  assert.equal(settings.translateScope, "article");
  assert.equal(settings.settingsVersion, 7);
  assert.equal(settings.articleScopeMigrated, true);
});

test("migrateSettings forces article on old page-scope installs", () => {
  const stored = { settingsVersion: 1, translateScope: "page", features: { webpage: true } };
  const merged = { ...DEFAULT_SETTINGS, ...stored, translateScope: "page" };
  const { settings, changed } = migrateSettings(merged, stored);
  assert.equal(changed, true);
  assert.equal(settings.translateScope, "article");
  assert.equal(settings.settingsVersion, 7);
});

test("migrateSettings forces article for testers stuck on v5 page scope", () => {
  const stored = { settingsVersion: 5, translateScope: "page" };
  const merged = { ...DEFAULT_SETTINGS, ...stored, translateScope: "page" };
  const { settings, changed } = migrateSettings(merged, stored);
  assert.equal(changed, true);
  assert.equal(settings.translateScope, "article");
  assert.equal(settings.settingsVersion, 7);
  assert.equal(settings.articleScopeMigrated, true);
});

test("migrateSettings leaves a later user-picked page scope alone", () => {
  const stored = { settingsVersion: 7, translateScope: "page", articleScopeMigrated: true };
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  const { settings, changed } = migrateSettings(merged, stored);
  assert.equal(changed, false);
  assert.equal(settings.translateScope, "page");
});

test("migrateSettings remaps preview alias to title_lead without resetting page scope", () => {
  const stored = {
    settingsVersion: 7,
    translateScope: "page",
    articleScopeMigrated: true,
    translateLimit: "preview"
  };
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  const { settings, changed } = migrateSettings(merged, stored);
  assert.equal(changed, true);
  assert.equal(settings.translateLimit, "title_lead");
  assert.equal(settings.translateScope, "page");
});

test("claude preset skips hero details and aside rail", () => {
  const preset = pickPreset("www.claude.com");
  assert.ok(preset);
  assert.equal(preset.id, "claude");
  assert.ok(preset.skip.includes(".hero_blog_post_details"));
  assert.ok(preset.skip.includes("[data-aside-rail]"));
  assert.ok(HARD_SKIP_SELECTOR.includes("[data-aside-rail]"));
  assert.ok(HARD_SKIP_SELECTOR.includes("hero_blog_post_details"));
});

test("classLooksChrome matches nav chrome but not article body", () => {
  assert.equal(classLooksChrome("nav_desktop_layout"), true);
  assert.equal(classLooksChrome("u-rich-text-blog"), false);
  assert.equal(CHROME_CLASS_RE.test("hero_blog_post_content"), false);
});

test("scan uses block nodes only and never PAGE_EXTRA nav links", () => {
  assert.equal(BLOCK_SELECTOR.includes("nav"), false);
  assert.equal(BLOCK_SELECTOR.includes("header"), false);
  assert.ok(BLOCK_SELECTOR.includes("p"));
  assert.ok(BLOCK_SELECTOR.includes("h1"));
});

test("hard-ban skips Claude rail and nav even for page scope", () => {
  const rail = fakeNode({ hits: ["hero_blog_post_details", "data-aside-rail"], text: "Category" });
  const nav = fakeNode({ hits: ["nav_desktop_layout", "role='navigation'"], text: "Product" });
  const side = fakeNode({ text: "Enterprise AI", left: 768, width: 220 });
  const body = fakeNode({ text: "Most AI tools and training are built for large companies." });
  assert.equal(isAlwaysBanned(rail, "claude.com"), true);
  assert.equal(isAlwaysBanned(nav, "claude.com"), true);
  assert.equal(isAlwaysBanned(body, "claude.com"), false);
  assert.equal(shouldCollectNode(rail, { translateScope: "page", skipCode: true }, { hostname: "claude.com", innerWidth: 1280 }), false);
  assert.equal(shouldCollectNode(nav, { translateScope: "page", skipCode: true }, { hostname: "claude.com", innerWidth: 1280 }), false);
  assert.equal(shouldCollectNode(side, { translateScope: "page", skipCode: true }, { hostname: "claude.com", innerWidth: 1280 }), false);
  assert.equal(shouldCollectNode(body, { translateScope: "article", skipCode: true }, { hostname: "claude.com", innerWidth: 1280 }), true);
});

test("meta rail cluster skips values under Category/Author labels", () => {
  const item = fakeNode({
    className: "hero_blog_post_details_item",
    hits: ["hero_blog_post_details_item"],
    text: "Category Enterprise AI"
  });
  const value = fakeNode({ text: "Enterprise AI" });
  value.parentElement = item;
  value.closest = (sel) => (String(sel).includes("details") || String(sel).includes("li") ? item : null);
  assert.equal(isInMetaRail(item), true);
  assert.equal(isInMetaRail(value), true);
  assert.equal(
    shouldCollectNode(value, { translateScope: "page", skipCode: true }, { hostname: "claude.com", innerWidth: 1280 }),
    false
  );
  assert.ok(HARD_SKIP_SELECTOR.includes(".hero_blog_post_details_item"));
  assert.ok(HARD_SKIP_SELECTOR.includes(".hero_blog_post_details_list"));
});

test("isChromeMetaText covers Claude blog rail labels", () => {
  for (const label of ["Category", "Product", "Date", "Reading time", "Share", "Author", "Copy link", "5 min"]) {
    assert.equal(isChromeMetaText(label), true, label);
  }
  assert.equal(isChromeMetaText("Most AI tools and training are built for large companies"), false);
});
