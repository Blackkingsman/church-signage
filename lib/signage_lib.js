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

// The three lists mirrored from Firestore. All share the doc shape {slides: [...]}.
//   dir        folder under media/ (same as the Drive cache dir)
//   doc        Firestore document in the signage collection
//   stateKey   key in .signage-sync-state.json
//   manifestKey key in content.json
//   durations  whether items may carry a per-item durationSec
const BACKEND_LISTS = [
  { kind: "slides", dir: "slides", doc: "signageSlides", stateKey: "backendSlides", manifestKey: "slides", durations: true },
  { kind: "photo-slides", dir: "photo-slides", doc: "signagePhotoSlides", stateKey: "backendPhotoSlides", manifestKey: "photoSlides", durations: false },
  { kind: "photo-wall", dir: "photos", doc: "signagePhotoWall", stateKey: "backendPhotoWall", manifestKey: "photos", durations: false }
];

// `media.source` wins; the old `slides.source` key is still honoured.
// Returns {source: "drive"|"backend", warning?}.
function resolveMediaSource(config) {
  const cfg = config || {};
  const raw = (cfg.media && cfg.media.source) ?? (cfg.slides && cfg.slides.source);
  if (raw === undefined || raw === null || raw === "") return { source: "drive" };
  if (raw === "backend" || raw === "drive") return { source: raw };
  return { source: "drive", warning: `Unknown media.source "${raw}"; using "drive".` };
}

// Dimensions from an image header: PNG IHDR, JPEG SOF, GIF logical screen,
// WebP VP8/VP8L/VP8X. Returns {width, height} or null. Ignores EXIF rotation.
function readImageSize(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const valid = (width, height) => (width > 0 && height > 0 ? { width, height } : null);
  const len = buf.length;

  if (len >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a
    && buf.toString("latin1", 12, 16) === "IHDR") {
    return valid(buf.readUInt32BE(16), buf.readUInt32BE(20));
  }

  if (len >= 10 && buf.toString("latin1", 0, 4) === "GIF8") {
    return valid(buf.readUInt16LE(6), buf.readUInt16LE(8));
  }

  if (len >= 25 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8X" && len >= 30) {
      return valid(buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1);
    }
    if (chunk === "VP8L" && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === "VP8 " && len >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return valid(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    }
    return null;
  }

  if (len >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= len) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      const marker = buf[offset + 1];
      if (marker === 0xff) { offset++; continue; }            // fill byte
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const segment = buf.readUInt16BE(offset + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (offset + 9 > len) return null;
        return valid(buf.readUInt16BE(offset + 7), buf.readUInt16BE(offset + 5));
      }
      if (segment < 2) return null;
      offset += 2 + segment;
    }
  }
  return null;
}

function orientationFromSize(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return null;
  return h > w ? "portrait" : "landscape";
}

// Manifest item the TV consumes, same shape as the Drive path with slideId
// in place of driveId. `size` is {width, height} or null (-> landscape).
function buildBackendManifestItem(list, item, { relativePath, position, size, globalDurationSec }) {
  const orientation = (size && orientationFromSize(size.width, size.height)) || "landscape";
  const explicitDuration = list.durations ? clampDuration(item.durationSec) : null;
  return {
    caption: typeof item.title === "string" && item.title ? item.title : item.id,
    image: encodeURI(relativePath),
    slideId: item.id,
    artIndex: position,
    ...(list.kind === "slides" ? {} : { orientation }),
    ...(explicitDuration ? { durationSec: pickDurationSec(explicitDuration, globalDurationSec) } : {})
  };
}

module.exports = {
  BACKEND_LISTS,
  buildBackendManifestItem,
  orientationFromSize,
  readImageSize,
  resolveMediaSource,
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
