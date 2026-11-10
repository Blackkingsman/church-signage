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

test("sanitizeWelcomeNames keeps only firstName, visitDate, partySize and a family name for parties", () => {
  const out = lib.sanitizeWelcomeNames([
    { firstName: " Zoe ", lastName: "Kim", email: "a@b.c", phone: "1", notes: "x", id: "9", visitDate: new Date("2026-11-15T00:00:00+09:00") },
    { firstName: "<b>Amy</b>", visitDate: { seconds: Date.parse("2026-11-15T00:00:00+09:00") / 1000 } },
    { firstName: "", visitDate: new Date() },
    { firstName: "Bad", visitDate: "nope" },
    { firstName: "Ben", visitDate: new Date("2026-11-08T00:00:00+09:00") },
    { firstName: "Min", lastName: " <i>Lee</i> ", partySize: 4, visitDate: new Date("2026-11-15T00:00:00+09:00") },
    { firstName: "Sol", lastName: "", partySize: 3, visitDate: new Date("2026-11-15T00:00:00+09:00") }
  ]);
  assert.deepEqual(out, [
    { firstName: "Ben", visitDate: "2026-11-08", partySize: 1 },
    { firstName: "Amy", visitDate: "2026-11-15", partySize: 1 },
    { firstName: "Min", visitDate: "2026-11-15", partySize: 4, family: "Lee" },
    { firstName: "Sol", visitDate: "2026-11-15", partySize: 3 },
    { firstName: "Zoe", visitDate: "2026-11-15", partySize: 1 }
  ]);
  // A single visitor never carries a last name; a party does, only as `family`.
  for (const item of out) {
    assert.ok(!("lastName" in item));
    assert.deepEqual(Object.keys(item).sort(),
      item.family ? ["family", "firstName", "partySize", "visitDate"] : ["firstName", "partySize", "visitDate"]);
  }
});

test("welcomeRange covers today to now+7d, starting today in KST", () => {
  const { startMs, endMs } = lib.welcomeRange(NOW);
  assert.equal(lib.formatKstDate(startMs), "2026-11-10");
  assert.equal(endMs, NOW + 7 * 24 * 60 * 60 * 1000);
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

test("normalizeWelcomeHeading accepts strings and {en, ko}", () => {
  assert.deepEqual(lib.normalizeWelcomeHeading("Hi <b>all</b>"), { en: "Hi all", ko: "" });
  assert.deepEqual(lib.normalizeWelcomeHeading({ en: " Hello ", ko: "안녕" }), { en: "Hello", ko: "안녕" });
  assert.deepEqual(lib.normalizeWelcomeHeading({ en: "", ko: "" }), { en: "Welcome!", ko: "환영합니다" });
  assert.deepEqual(lib.normalizeWelcomeHeading(undefined), { en: "Welcome!", ko: "환영합니다" });
  assert.equal(lib.normalizeWelcomeHeading({ en: "x".repeat(200) }).en.length, 60);
});

// ---- image header parser and backend lists ----

const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const gif = (w, h) => {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
};
// SOI, an APP0 segment to skip, then SOF (default baseline SOF0).
const jpeg = (w, h, sof = 0xc0) => {
  const app = Buffer.from([0xff, 0xe0, 0x00, 0x06, 1, 2, 3, 4]);
  const frame = Buffer.alloc(19);
  frame[0] = 0xff; frame[1] = sof;
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(h, 5);
  frame.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, frame]);
};
const riff = (fourcc, body) => {
  const b = Buffer.alloc(20 + body.length);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(12 + body.length, 4);
  b.write("WEBP", 8, "latin1");
  b.write(fourcc, 12, "latin1");
  b.writeUInt32LE(body.length, 16);
  body.copy(b, 20);
  return b;
};
const webpLossy = (w, h) => {
  const body = Buffer.alloc(10);
  body[3] = 0x9d; body[4] = 0x01; body[5] = 0x2a;
  body.writeUInt16LE(w, 6);
  body.writeUInt16LE(h, 8);
  return riff("VP8 ", body);
};
const webpLossless = (w, h) => {
  const body = Buffer.alloc(5);
  body[0] = 0x2f;
  body.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1);
  return riff("VP8L", body);
};
const webpExtended = (w, h) => {
  const body = Buffer.alloc(10);
  body.writeUIntLE(w - 1, 4, 3);
  body.writeUIntLE(h - 1, 7, 3);
  return riff("VP8X", body);
};

test("readImageSize parses PNG, JPEG, GIF and all WebP flavours", () => {
  assert.deepEqual(lib.readImageSize(png(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(lib.readImageSize(jpeg(800, 1200)), { width: 800, height: 1200 });
  assert.deepEqual(lib.readImageSize(jpeg(640, 480, 0xc2)), { width: 640, height: 480 });
  assert.deepEqual(lib.readImageSize(gif(320, 240)), { width: 320, height: 240 });
  assert.deepEqual(lib.readImageSize(webpLossy(1000, 1500)), { width: 1000, height: 1500 });
  assert.deepEqual(lib.readImageSize(webpLossless(4000, 3000)), { width: 4000, height: 3000 });
  assert.deepEqual(lib.readImageSize(webpExtended(16384, 9)), { width: 16384, height: 9 });
});

test("readImageSize returns null for junk and truncated data", () => {
  assert.equal(lib.readImageSize(Buffer.alloc(0)), null);
  assert.equal(lib.readImageSize(Buffer.from("not an image at all, really")), null);
  assert.equal(lib.readImageSize(png(10, 10).subarray(0, 20)), null);
  assert.equal(lib.readImageSize(jpeg(10, 10).subarray(0, 12)), null);
  assert.equal(lib.readImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xc4, 0, 2])), null);
  assert.equal(lib.readImageSize(null), null);
});

test("orientationFromSize: taller is portrait, otherwise landscape, bad is null", () => {
  assert.equal(lib.orientationFromSize(100, 200), "portrait");
  assert.equal(lib.orientationFromSize(200, 100), "landscape");
  assert.equal(lib.orientationFromSize(100, 100), "landscape");
  assert.equal(lib.orientationFromSize(0, 100), null);
  assert.equal(lib.orientationFromSize(undefined, undefined), null);
});

test("BACKEND_LISTS maps the three docs to folders and manifest keys", () => {
  const byKind = Object.fromEntries(lib.BACKEND_LISTS.map(l => [l.kind, l]));
  assert.deepEqual(Object.keys(byKind), ["slides", "photo-slides", "photo-wall"]);
  assert.equal(byKind.slides.doc, "signageSlides");
  assert.equal(byKind.slides.dir, "slides");
  assert.equal(byKind.slides.manifestKey, "slides");
  assert.equal(byKind["photo-slides"].doc, "signagePhotoSlides");
  assert.equal(byKind["photo-slides"].dir, "photo-slides");
  assert.equal(byKind["photo-slides"].manifestKey, "photoSlides");
  assert.equal(byKind["photo-wall"].doc, "signagePhotoWall");
  assert.equal(byKind["photo-wall"].dir, "photos");
  assert.equal(byKind["photo-wall"].manifestKey, "photos");
  assert.equal(new Set(lib.BACKEND_LISTS.map(l => l.stateKey)).size, 3);
});

test("resolveMediaSource: media.source wins, slides.source is the fallback", () => {
  assert.deepEqual(lib.resolveMediaSource({}), { source: "drive" });
  assert.deepEqual(lib.resolveMediaSource({ media: { source: "backend" } }), { source: "backend" });
  assert.deepEqual(lib.resolveMediaSource({ slides: { source: "backend" } }), { source: "backend" });
  assert.deepEqual(lib.resolveMediaSource({ media: { source: "drive" }, slides: { source: "backend" } }), { source: "drive" });
  const bad = lib.resolveMediaSource({ media: { source: "s3" } });
  assert.equal(bad.source, "drive");
  assert.match(bad.warning, /s3/);
});

test("buildBackendManifestItem emits the Drive-shaped item per list", () => {
  const [slides, photoSlides, wall] = lib.BACKEND_LISTS;
  const item = { id: "abc", title: "Easter", durationSec: 20 };
  assert.deepEqual(
    lib.buildBackendManifestItem(slides, item, { relativePath: "media/slides/a b.jpg", position: 2, size: { width: 1, height: 9 }, globalDurationSec: 9 }),
    { caption: "Easter", image: "media/slides/a%20b.jpg", slideId: "abc", artIndex: 2, durationSec: 20 }
  );
  assert.deepEqual(
    lib.buildBackendManifestItem(photoSlides, item, { relativePath: "media/photo-slides/x.jpg", position: 0, size: { width: 1, height: 9 } }),
    { caption: "Easter", image: "media/photo-slides/x.jpg", slideId: "abc", artIndex: 0, orientation: "portrait" }
  );
  assert.deepEqual(
    lib.buildBackendManifestItem(wall, { id: "p1" }, { relativePath: "media/photos/y.png", position: 1, size: null }),
    { caption: "p1", image: "media/photos/y.png", slideId: "p1", artIndex: 1, orientation: "landscape" }
  );
});
