import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MESSAGES,
  hasMessage,
  localeForLanguage,
  normalizeLanguage,
  resolveLanguage,
  translate,
} from "../web/i18n.mjs";
import {
  createStartPlanStatus,
  resolveStartPlanStatus,
} from "../web/startplan-status.mjs";

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.resolve(TEST_ROOT, "..", "web", "index.html");
const APP_PATH = path.resolve(TEST_ROOT, "..", "web", "app.js");

test("English and Simplified Chinese dictionaries expose identical keys", () => {
  const english = Object.keys(MESSAGES.en).sort();
  const chinese = Object.keys(MESSAGES["zh-CN"]).sort();
  assert.deepEqual(chinese, english);
  assert.ok(english.length > 100);
});

test("language normalization, browser fallback, locale, and interpolation are deterministic", () => {
  assert.equal(normalizeLanguage("zh"), "zh-CN");
  assert.equal(normalizeLanguage("zh-Hans-CN"), "zh-CN");
  assert.equal(normalizeLanguage("en-GB"), "en");
  assert.equal(normalizeLanguage("fr"), null);
  assert.equal(resolveLanguage(null, "zh-CN"), "zh-CN");
  assert.equal(resolveLanguage("en", "zh-CN"), "en");
  assert.equal(resolveLanguage("unsupported", "fr-FR"), "en");
  assert.equal(localeForLanguage("zh-CN"), "zh-CN");
  assert.equal(localeForLanguage("en"), "en-US");
  assert.equal(
    translate("zh-CN", "profiler.findingCount", { count: 3 }),
    "3 项发现",
  );
  assert.equal(
    translate("en", "profiler.findingCount", { count: 3 }),
    "3 findings",
  );
});

test("missing keys fall back to English or expose the key without inventing content", () => {
  assert.equal(hasMessage("zh-CN", "profiler.title"), true);
  assert.equal(hasMessage("zh-CN", "not.a.real.key"), false);
  assert.equal(translate("fr", "profiler.title"), "Token Profiler");
  assert.equal(translate("zh-CN", "not.a.real.key"), "not.a.real.key");
});

test("all declarative interface translation keys exist in both dictionaries", () => {
  const html = readFileSync(HTML_PATH, "utf8");
  const keys = new Set();
  for (const match of html.matchAll(/\bdata-i18n="([^"]+)"/gu)) keys.add(match[1]);
  for (const match of html.matchAll(/\bdata-i18n-placeholder="([^"]+)"/gu)) keys.add(match[1]);
  for (const match of html.matchAll(/\bdata-i18n-aria-label="([^"]+)"/gu)) keys.add(match[1]);
  for (const match of html.matchAll(/\bdata-i18n-title="([^"]+)"/gu)) keys.add(match[1]);
  assert.ok(keys.size > 80);
  for (const key of keys) {
    assert.equal(hasMessage("en", key), true, `missing English key: ${key}`);
    assert.equal(hasMessage("zh-CN", key), true, `missing Chinese key: ${key}`);
  }
});

test("all static translator calls in the Web application resolve in both languages", () => {
  const source = readFileSync(APP_PATH, "utf8");
  const keys = new Set();
  for (const match of source.matchAll(/\bt\("([^"]+)"/gu)) keys.add(match[1]);
  assert.ok(keys.size > 40);
  for (const key of keys) {
    assert.equal(hasMessage("en", key), true, `missing English key: ${key}`);
    assert.equal(hasMessage("zh-CN", key), true, `missing Chinese key: ${key}`);
  }
});

test("Start Plan loading and captured states survive language switches with the right freshness", () => {
  const source = readFileSync(APP_PATH, "utf8");
  assert.match(source, /function setStartPlanStatus\(/u);
  assert.match(source, /function applyStartPlanStatus\(/u);
  assert.match(source, /setStartPlanStatus\("startplan\.readingBalance"/u);
  assert.match(source, /setStartPlanStatus\("startplan\.refreshFailed"/u);
  assert.match(source, /preserveStatus: true/u);
  assert.doesNotMatch(source, /\$\("#startplan-state"\)\.textContent\s*=/u);

  const loading = createStartPlanStatus("startplan.readingBalance", null, {
    freshness: { key: "startplan.loading", className: "tag" },
    preserve: true,
  });
  const loadingZh = resolveStatus(loading, "zh-CN");
  assert.equal(loadingZh.stateText, "正在读取官方 billing/balance...");
  assert.equal(loadingZh.freshness.text, "加载中");

  const capturedAt = "2026-11-19T08:00:00.000Z";
  const captured = createStartPlanStatus("startplan.captured", { at: capturedAt }, {
    freshness: { text: "FRESH", className: "tag pass", reason: "WITHIN_WINDOW" },
    preserve: true,
  });
  const capturedEn = resolveStatus(captured, "en");
  const capturedZh = resolveStatus(captured, "zh-CN");
  assert.match(capturedEn.stateText, /^Official snapshot captured Nov 19, 2026/u);
  assert.match(capturedZh.stateText, /^官方快照已采集：2026年11月19日/u);
  assert.equal(capturedEn.freshness.text, "FRESH");
  assert.equal(capturedZh.freshness.text, "FRESH");
  assert.equal(capturedEn.freshness.className, "tag pass");
  assert.equal(loadingZh.freshness.text === capturedZh.freshness.text, false);
});

function resolveStatus(status, language) {
  return resolveStartPlanStatus(status, {
    translate: (key, parameters) => translate(language, key, parameters),
    formatTime: (value) => new Intl.DateTimeFormat(
      localeForLanguage(language),
      { dateStyle: "medium", timeStyle: "short" },
    ).format(new Date(value)),
    translateReason: (reason) => reason ?? null,
  });
}
