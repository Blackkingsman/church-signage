"use strict";

const fs = require("fs");
const path = require("path");
const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const root = __dirname;
const configPath = path.join(root, "signage.config.json");
const defaultBackgroundMusicUrl = "https://www.youtube.com/watch?v=rtgVcSu7IY8";
const modes = new Set(["wall", "slides", "photo", "live"]);

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function normalizeSermon(doc) {
  const sermon = { id: doc.id, ...doc.data() };
  const videoId = sermon.youtubeVideoId || sermon.videoId || "";
  const videoUrl = sermon.videoUrl || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
  const title = sermon.title || sermon.fullTitle || "Sunday Worship";
  const metaParts = [sermon.speaker, sermon.displayDate].filter(Boolean);

  return {
    liveUrl: videoUrl,
    liveTitle: title,
    liveBody: sermon.description || "",
    liveMeta: metaParts.join(" | "),
    liveSource: "sermons",
    liveSourceSermonId: sermon.id,
    liveThumbnailUrl: sermon.thumbnailUrl || ""
  };
}

async function findLatestSermon(firestore, firestoreConfig) {
  const sermonsCollection = firestoreConfig.sermonsCollection || "sermons";
  const orderBy = firestoreConfig.sermonOrderBy || "scheduledStart";
  const queryLimit = Number(firestoreConfig.sermonQueryLimit) || 20;
  const snapshot = await firestore
    .collection(sermonsCollection)
    .orderBy(orderBy, "desc")
    .limit(queryLimit)
    .get();

  return snapshot.docs.find(doc => {
    const sermon = doc.data();
    return sermon.isPublished !== false && sermon.isSermon !== false;
  });
}

async function main() {
  const config = readJson(configPath);
  if (!config) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  const keyPath = resolveFromRoot(config.serviceAccountKey || "./serviceAccountKey.json");
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Service account key not found: ${keyPath}`);
  }

  const serviceAccount = readJson(keyPath);
  const app = getApps()[0] || initializeApp({
    credential: cert(serviceAccount)
  });
  const firestore = getFirestore(app);
  const firestoreConfig = config.firestore || {};
  const signageDocument = firestore
    .collection(firestoreConfig.signageCollection || firestoreConfig.collection || "appContent")
    .doc(firestoreConfig.signageDocument || firestoreConfig.document || "signage");

  const sermonDoc = await findLatestSermon(firestore, firestoreConfig);
  if (!sermonDoc) {
    throw new Error("No published sermon found to seed liveUrl.");
  }

  const sermon = normalizeSermon(sermonDoc);
  if (!sermon.liveUrl) {
    throw new Error(`Latest sermon ${sermonDoc.id} does not have videoUrl, youtubeVideoId, or videoId.`);
  }

  const requestedMode = process.argv[2];
  const mode = modes.has(requestedMode) ? requestedMode : "wall";
  const payload = {
    mode,
    ...sermon,
    backgroundMusicUrl: process.env.BACKGROUND_MUSIC_URL || defaultBackgroundMusicUrl,
    musicEnabled: true,
    musicVolume: Number(process.env.MUSIC_VOLUME) || 55,
    updatedAt: FieldValue.serverTimestamp()
  };

  await signageDocument.set(payload, { merge: true });

  console.log(`Updated ${signageDocument.path}`);
  console.log(`mode=${payload.mode}`);
  console.log(`liveUrl=${payload.liveUrl}`);
  console.log(`backgroundMusicUrl=${payload.backgroundMusicUrl}`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
