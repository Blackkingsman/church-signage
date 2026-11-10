"use strict";

// Pure helpers shared by signage_bridge.js and scripts/migrate_slides_to_backend.mjs.
// No I/O here so they can be unit-tested with `node --test`.

const crypto = require("crypto");

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_DURATION_SEC = 3;
const MAX_DURATION_SEC = 300;
const DEFAULT_DURATION_SEC = 9;
const MAX_NAME_LENGTH = 40;

// Accepts Firestore Timestamp, {seconds}/{_seconds}, Date, epoch ms or ISO string.
function toMillis(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value._seconds === "number") return value._seconds * 1000;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

// enabled and inside the optional [startAt, endAt] window.
function isSlideActive(slide, nowMs) {
  if (!slide || slide.enabled !== true) return false;
  const start = toMillis(slide.startAt);
  const end = toMillis(slide.endAt);
  if (start !== null && nowMs < start) return false;
  if (end !== null && nowMs > end) return false;
  return true;
}

// Per-slide duration wins, otherwise the global setting, otherwise 9 s.
function clampDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.max(MIN_DURATION_SEC, Math.min(MAX_DURATION_SEC, Math.round(number)));
}

function pickDurationSec(slideDurationSec, globalDurationSec) {
  return clampDuration(slideDurationSec) ?? clampDuration(globalDurationSec) ?? DEFAULT_DURATION_SEC;
}

// welcomeHeading may be a plain string (older docs) or {en, ko}. Always
// returns {en, ko}: plain text, trimmed, capped at 60 chars each; when both
// are empty the bilingual default is used.
function normalizeWelcomeHeading(value) {
  const clean = text => (typeof text === "string"
    ? text.normalize("NFC").replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f<>&"`]/g, "").replace(/\s+/g, " ").trim().slice(0, 60)
    : "");
  const source = typeof value === "string" ? { en: value, ko: "" } : (value && typeof value === "object" ? value : {});
  const en = clean(source.en);
  const ko = clean(source.ko);
  return en || ko ? { en, ko } : { en: "Welcome!", ko: "환영합니다" };
}

function kstDayStartMs(nowMs) {
  return Math.floor((nowMs + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
}

function formatKstDate(ms) {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// [start of today (KST), now + 7 days). visitDate is 00:00 KST on the Sunday,
// so a visitor shows all day on their Sunday and drops off after.
function welcomeRange(nowMs, days = 7) {
  return { startMs: kstDayStartMs(nowMs), endMs: nowMs + days * DAY_MS };
}

function sanitizeFirstName(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFC")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f<>&"`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

// Whitelist projection: ONLY firstName and visitDate ever leave this function.
// Sorted by visitDate then firstName; blank names and bad dates are dropped.
function sanitizeWelcomeNames(cards) {
  const names = [];
  for (const card of cards || []) {
    const firstName = sanitizeFirstName(card && card.firstName);
    const ms = toMillis(card && card.visitDate);
    if (!firstName || ms === null) continue;
    names.push({ firstName, visitDate: formatKstDate(ms) });
  }
  names.sort((a, b) =>
    a.visitDate.localeCompare(b.visitDate)
    || a.firstName.localeCompare(b.firstName, "en", { sensitivity: "base", numeric: true })
    || a.firstName.localeCompare(b.firstName));
  return names;
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}

// The Drive cache names files `<name>-<id10>-<md510>.<ext>`; recover `<name>`.
function originalStem(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, "");
  return stem.replace(/-[A-Za-z0-9_-]{10}-[A-Za-z0-9]{1,10}$/, "");
}

function sortByOriginalName(fileNames) {
  return [...fileNames].sort((a, b) => naturalCompare(originalStem(a), originalStem(b)) || naturalCompare(a, b));
}

function keyHash(key) {
  return crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 10);
}

module.exports = {
  DEFAULT_DURATION_SEC,
  clampDuration,
  formatKstDate,
  isSlideActive,
  keyHash,
  kstDayStartMs,
  naturalCompare,
  normalizeWelcomeHeading,
  originalStem,
  pickDurationSec,
  sanitizeFirstName,
  sanitizeWelcomeNames,
  sortByOriginalName,
  toMillis,
  welcomeRange
};
