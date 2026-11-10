"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../lib/signage_lib");

const NOW = Date.parse("2026-11-10T03:00:00Z");

test("isSlideActive honours enabled and window", () => {
  assert.equal(lib.isSlideActive({ enabled: false }, NOW), false);
  assert.equal(lib.isSlideActive({ enabled: true }, NOW), true);
  assert.equal(lib.isSlideActive({ enabled: true, startAt: { seconds: NOW / 1000 + 60 } }, NOW), false);
  assert.equal(lib.isSlideActive({ enabled: true, endAt: { toMillis: () => NOW - 1 } }, NOW), false);
  assert.equal(lib.isSlideActive({ enabled: true, startAt: null, endAt: new Date(NOW + 5) }, NOW), true);
  assert.equal(lib.isSlideActive({ enabled: true, startAt: "2026-11-01T00:00:00Z", endAt: "2026-11-30T00:00:00Z" }, NOW), true);
});

test("sanitizeWelcomeNames keeps only firstName and visitDate", () => {
  const out = lib.sanitizeWelcomeNames([
    { firstName: " Zoe ", lastName: "Kim", email: "a@b.c", phone: "1", notes: "x", id: "9", visitDate: new Date("2026-11-15T00:00:00+09:00") },
    { firstName: "<b>Amy</b>", visitDate: { seconds: Date.parse("2026-11-15T00:00:00+09:00") / 1000 } },
    { firstName: "", visitDate: new Date() },
    { firstName: "Bad", visitDate: "nope" },
    { firstName: "Ben", visitDate: new Date("2026-11-08T00:00:00+09:00") }
  ]);
  assert.deepEqual(out, [
    { firstName: "Ben", visitDate: "2026-11-08" },
    { firstName: "Amy", visitDate: "2026-11-15" },
    { firstName: "Zoe", visitDate: "2026-11-15" }
  ]);
  for (const item of out) assert.deepEqual(Object.keys(item).sort(), ["firstName", "visitDate"]);
});

test("welcomeRange covers today through day 7 in KST", () => {
  const { startMs, endMs } = lib.welcomeRange(NOW);
  assert.equal(lib.formatKstDate(startMs), "2026-11-10");
  assert.equal(lib.formatKstDate(endMs), "2026-11-18");
});

test("natural order uses original names, not the cache suffix", () => {
  const sorted = lib.sortByOriginalName([
    "Slide-10-AbCdEfGhIj-0123456789.jpg",
    "Slide-2-ZZZZZZZZZZ-ffffffffff.jpg",
    "Slide-1-QQQQQQQQQQ-aaaaaaaaaa.png"
  ]);
  assert.deepEqual(sorted.map(lib.originalStem), ["Slide-1", "Slide-2", "Slide-10"]);
});

test("pickDurationSec prefers per-slide, then global, then 9", () => {
  assert.equal(lib.pickDurationSec(20, 12), 20);
  assert.equal(lib.pickDurationSec(null, 12), 12);
  assert.equal(lib.pickDurationSec(undefined, undefined), 9);
  assert.equal(lib.pickDurationSec(0, "abc"), 9);
  assert.equal(lib.pickDurationSec(1, 9), 3);
  assert.equal(lib.pickDurationSec(9999, 9), 300);
});
