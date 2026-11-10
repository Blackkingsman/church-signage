#!/usr/bin/env node
// One-off migration: upload one of the signage VM's media folders through the
// backend and write the matching appContent document:
//   --kind slides       media/slides        -> appContent/signageSlides      (targetId "slides")
//   --kind photo-slides media/photo-slides  -> appContent/signagePhotoSlides (targetId "photo-slides")
//   --kind photo-wall   media/photos        -> appContent/signagePhotoWall   (targetId "photo-wall")
// Runs on a laptop, NOT on the VM. See README "Migrating the existing slides".

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { cert, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const require = createRequire(import.meta.url);
const { originalStem, readImageSize, sortByOriginalName } = require("../lib/signage_lib.js");

const KINDS = {
  "slides": { doc: "signageSlides", targetId: "slides", cacheDir: "media/slides" },
  "photo-slides": { doc: "signagePhotoSlides", targetId: "photo-slides", cacheDir: "media/photo-slides" },
  "photo-wall": { doc: "signagePhotoWall", targetId: "photo-wall", cacheDir: "media/photos" }
};

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

function usage() {
  console.error(`Usage: node scripts/migrate_slides_to_backend.mjs <dir> --kind slides|photo-slides|photo-wall --service-account <key.json> [--dry-run]

  <dir>               local copy of the matching VM folder (slides -> media/slides,
                      photo-slides -> media/photo-slides, photo-wall -> media/photos):
                      scp -r awesomechurch@192.168.2.18:photowall/media/{slides,photo-slides,photos} ./export/
  --kind              which list to migrate (default: slides)
  --service-account   Firebase Admin service account JSON (writes the kind's appContent doc)
  --dry-run           print the plan; upload and write nothing

Environment:
  API_URL             backend base URL (required unless --dry-run)
  ADMIN_ID_TOKEN      Firebase ID token of a church admin (required unless --dry-run)
                      Get one: sign in to the website admin, open DevTools console and run
                        (await firebase.auth().currentUser.getIdToken())
                      or, in the app bundle's modular SDK:
                        await getAuth().currentUser.getIdToken(true)
                      Tokens last 1 hour; no firebase login:ci needed.`);
  process.exit(2);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const saIndex = args.indexOf("--service-account");
const serviceAccountPath = saIndex >= 0 ? args[saIndex + 1] : "";
const kindIndex = args.indexOf("--kind");
const kindName = kindIndex >= 0 ? args[kindIndex + 1] : "slides";
const kind = KINDS[kindName];
const dir = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--service-account" && args[i - 1] !== "--kind");
if (!dir || !serviceAccountPath || !kind) usage();
const isPhoto = kindName !== "slides";

const apiUrl = (process.env.API_URL || "").replace(/\/+$/, "");
const token = process.env.ADMIN_ID_TOKEN || "";
if (!dryRun && (!apiUrl || !token)) {
  console.error("API_URL and ADMIN_ID_TOKEN are required (or use --dry-run).");
  process.exit(2);
}

const files = sortByOriginalName(
  fs.readdirSync(dir).filter(name => MIME[path.extname(name).toLowerCase()])
);
if (!files.length) {
  console.error(`No images found in ${dir}`);
  process.exit(1);
}

const app = initializeApp({ credential: cert(JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"))) });
const firestore = getFirestore(app);
const docRef = firestore.collection("appContent").doc(kind.doc);
const existing = (await docRef.get()).data()?.slides || [];
const present = new Set(existing.map(slide => slide.title));

async function upload(fileName) {
  const buffer = fs.readFileSync(path.join(dir, fileName));
  const form = new FormData();
  form.set("kind", "signage");
  form.set("targetId", kind.targetId);
  form.set("file", new Blob([buffer], { type: MIME[path.extname(fileName).toLowerCase()] }), fileName);
  const response = await fetch(`${apiUrl}/upload/content-image`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  if (!response.ok) throw new Error(`upload ${fileName}: HTTP ${response.status} ${await response.text()}`);
  const data = await response.json();
  // Field names vary slightly between backend revisions; accept the known aliases.
  const url = data.url || data.imageUrl;
  const key = data.key || data.imageKey;
  if (!url || !key) throw new Error(`upload ${fileName}: response had no url/key: ${JSON.stringify(data)}`);
  return {
    url,
    key,
    thumbUrl: data.thumbUrl || data.thumbnailUrl || null,
    thumbKey: data.thumbKey || data.thumbnailKey || null
  };
}

const added = [];
for (const fileName of files) {
  const title = originalStem(fileName);
  if (present.has(title)) {
    console.log(`skip (already present): ${title}`);
    continue;
  }
  if (dryRun) {
    console.log(`would upload: ${fileName} -> title "${title}"`);
    continue;
  }
  const uploaded = await upload(fileName);
  // Photos also store width/height when the header is readable (orientation).
  const parsed = isPhoto ? readImageSize(fs.readFileSync(path.join(dir, fileName))) : null;
  const size = parsed ? { width: parsed.width, height: parsed.height } : {};
  console.log(`uploaded: ${title}`);
  added.push({
    id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    ...uploaded,
    title,
    enabled: true,
    startAt: null,
    endAt: null,
    ...(isPhoto ? size : { durationSec: null })
  });
}

if (dryRun) {
  console.log(`dry run: ${files.length - files.filter(f => present.has(originalStem(f))).length} new, ${existing.length} already in Firestore. Nothing written.`);
} else if (added.length) {
  await docRef.set({
    slides: [...existing, ...added],
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: "migrate_slides_to_backend"
  }, { merge: true });
  console.log(`wrote appContent/${kind.doc}: ${existing.length + added.length} items (${added.length} new).`);
} else {
  console.log("nothing new to write.");
}
process.exit(0);
