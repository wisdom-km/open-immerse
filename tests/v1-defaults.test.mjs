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
import { BLOCK_SELECTOR } from "../lib/page-scan.js";

test("default translateScope is article and settingsVersion is 3", () => {
  assert.equal(DEFAULT_SETTINGS.translateScope, "article");
  assert.equal(DEFAULT_SETTINGS.settingsVersion, SETTINGS_VERSION);
  assert.equal(SETTINGS_VERSION, 3);
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

test("migrateSettings forces article on old page-scope installs", () => {
  const stored = { settingsVersion: 1, translateScope: "page", features: { webpage: true } };
  const merged = { ...DEFAULT_SETTINGS, ...stored, translateScope: "page" };
  const { settings, changed } = migrateSettings(merged, stored);
  assert.equal(changed, true);
  assert.equal(settings.translateScope, "article");
  assert.equal(settings.settingsVersion, 3);
});

test("migrateSettings leaves an already-migrated page scope alone", () => {
  const stored = { settingsVersion: 3, translateScope: "page" };
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  const { settings, changed } = migrateSettings(merged, stored);
  assert.equal(changed, false);
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

test("isChromeMetaText covers Claude blog rail labels", () => {
  for (const label of ["Category", "Product", "Date", "Reading time", "Share", "Author", "Copy link", "5 min"]) {
    assert.equal(isChromeMetaText(label), true, label);
  }
  assert.equal(isChromeMetaText("Most AI tools and training are built for large companies"), false);
});
