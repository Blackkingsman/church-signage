"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { pipeline } = require("stream/promises");
const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { google } = require("googleapis");

const root = __dirname;
const configPath = path.join(root, "signage.config.json");
const contentPath = path.join(root, "content.json");
const controlPath = path.join(root, "control.json");
const statePath = path.join(root, ".signage-sync-state.json");
const mediaRoot = path.join(root, "media");
const modes = new Set(["wall", "slides", "photo", "live"]);
const imageTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"]
]);

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, data) {
  const temporary = `${filePath}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, filePath);
}

async function writeJsonIfChanged(filePath, data) {
  const next = `${JSON.stringify(data, null, 2)}\n`;
  try {
    const current = await fsp.readFile(filePath, "utf8");
    if (current === next) return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const temporary = `${filePath}.tmp`;
  await fsp.writeFile(temporary, next, "utf8");
  await fsp.rename(temporary, filePath);
  return true;
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function validateConfig(config) {
  const errors = [];
  const keyPath = resolveFromRoot(config.serviceAccountKey || "");

  if (!fs.existsSync(keyPath)) {
    errors.push(`service account key not found: ${keyPath}`);
  }
  if (errors.length) {
    throw new Error(`Configuration is incomplete:\n- ${errors.join("\n- ")}`);
  }

  return keyPath;
}

function safeName(name, fallback) {
  const stem = path.parse(name).name;
  const cleaned = stem
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return (cleaned || fallback).slice(0, 100);
}

function canonicalYouTubeUrl(value) {
  if (typeof value !== "string" || !value) return "";

  try {
    const url = new URL(value);
    let videoId = "";

    if (url.hostname.includes("youtu.be")) {
      videoId = url.pathname.split("/").filter(Boolean)[0] || "";
    } else if (url.hostname.includes("youtube.com")) {
      const pathMatch = url.pathname.match(/^\/(?:live|embed|shorts)\/([^/?]+)/);
      videoId = url.searchParams.get("v") || pathMatch?.[1] || "";
    }

    return videoId
      ? `https://www.youtube.com/watch?v=${videoId}`
      : value;
  } catch (error) {
    return value;
  }
}

async function listDriveFiles(drive, folderId) {
  const files = [];
  let pageToken;

  do {
    const response = await drive.files.list({
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      fields: "nextPageToken, files(id,name,mimeType,modifiedTime,md5Checksum,size)",
      orderBy: "name_natural",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    files.push(
      ...(response.data.files || []).filter(file => imageTypes.has(file.mimeType))
    );
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return files;
}

async function downloadDriveFile(drive, file, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  const response = await drive.files.get(
    {
      fileId: file.id,
      alt: "media",
      supportsAllDrives: true
    },
    { responseType: "stream" }
  );

  try {
    await pipeline(response.data, fs.createWriteStream(temporary));
    await fsp.rename(temporary, destination);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

async function syncFolder(drive, folderId, category, previousState) {
  const destinationDirectory = path.join(mediaRoot, category);
  await fsp.mkdir(destinationDirectory, { recursive: true });

  const files = await listDriveFiles(drive, folderId);
  const currentState = {};
  const manifestItems = [];
  const keepFiles = new Set();

  for (const [position, file] of files.entries()) {
    const extension = imageTypes.get(file.mimeType);
    const contentVersion = (
      file.md5Checksum
      || String(Date.parse(file.modifiedTime || "") || 0)
    ).slice(0, 10);
    const fileName = `${safeName(file.name, file.id)}-${file.id.slice(0, 10)}-${contentVersion}${extension}`;
    const destination = path.join(destinationDirectory, fileName);
    const signature = `${file.modifiedTime || ""}:${file.md5Checksum || ""}:${fileName}`;
    const prior = previousState[file.id] || {};

    if (prior.signature !== signature || !fs.existsSync(destination)) {
      console.log(`Downloading ${category}: ${file.name}`);
      await downloadDriveFile(drive, file, destination);
    }

    const relativePath = path.relative(root, destination).replaceAll("\\", "/");
    keepFiles.add(path.resolve(destination).toLowerCase());
    currentState[file.id] = { signature, path: relativePath };
    manifestItems.push({
      caption: path.parse(file.name).name,
      image: encodeURI(relativePath),
      driveId: file.id,
      artIndex: position
    });
  }

  for (const localName of await fsp.readdir(destinationDirectory)) {
    const localPath = path.resolve(destinationDirectory, localName);
    if (!keepFiles.has(localPath.toLowerCase())) {
      await fsp.rm(localPath, { force: true });
    }
  }

  return { manifestItems, currentState };
}

function normalizeRemoteState(config, data = {}) {
  const music = config.music || {};
  return {
    mode: modes.has(data.mode) ? data.mode : "wall",
    liveUrl: canonicalYouTubeUrl(data.liveUrl),
    backgroundMusicUrl:
      canonicalYouTubeUrl(data.backgroundMusicUrl),
    musicEnabled:
      typeof data.musicEnabled === "boolean" ? data.musicEnabled : music.enabled !== false,
    musicVolume: Number.isFinite(data.musicVolume)
      ? Math.max(0, Math.min(100, data.musicVolume))
      : Number.isFinite(music.volume) ? music.volume : 55,
    liveLabel: data.liveLabel,
    liveTitle: data.liveTitle,
    liveBody: data.liveBody,
    liveMeta: data.liveMeta
  };
}

function normalizeSermon(snapshot) {
  if (!snapshot || snapshot.empty) return {};

  const docs = snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(sermon => sermon.isPublished !== false && sermon.isSermon !== false);
  const sermon = docs[0];
  if (!sermon) return {};

  const videoId = sermon.youtubeVideoId || sermon.videoId || "";
  const videoUrl = canonicalYouTubeUrl(
    sermon.videoUrl || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "")
  );
  const title = sermon.title || sermon.fullTitle || "Sunday Worship";
  const metaParts = [sermon.speaker, sermon.displayDate].filter(Boolean);

  return {
    sourceSermonId: sermon.id,
    liveUrl: videoUrl,
    liveTitle: title,
    liveBody: sermon.description || "",
    liveMeta: metaParts.join(" | "),
    thumbnailUrl: sermon.thumbnailUrl || ""
  };
}

function buildManifest(config, photos, photoSlides, slides, remote) {
  const live = config.live || {};
  return {
    wall: config.wall || {},
    photos,
    photoSlides,
    slides,
    live: {
      embedUrl: remote.liveUrl,
      label: remote.liveLabel || live.label || "Live now",
      title: remote.liveTitle || live.title || "Join us inside.",
      body: remote.liveBody || live.body || "",
      meta: remote.liveMeta || live.meta || ""
    },
    music: {
      url: remote.backgroundMusicUrl,
      enabled: remote.musicEnabled,
      volume: remote.musicVolume
    }
  };
}

async function main() {
  const config = readJson(configPath);
  if (!config) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }
  const keyPath = validateConfig(config);
  const serviceAccount = readJson(keyPath);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"]
  });
  const drive = google.drive({ version: "v3", auth });

  const app = getApps()[0] || initializeApp({
    credential: cert(serviceAccount)
  });
  const firestore = getFirestore(app);
  const firestoreConfig = config.firestore || {};
  const signageDocument = firestore
    .collection(firestoreConfig.signageCollection || firestoreConfig.collection || "appContent")
    .doc(firestoreConfig.signageDocument || firestoreConfig.document || "signage");
  const sermonsCollection = firestoreConfig.sermonsCollection || "sermons";
  const useLatestSermon = firestoreConfig.useLatestSermon !== false;
  const latestSermonQuery = firestore
    .collection(sermonsCollection)
    .orderBy(firestoreConfig.sermonOrderBy || "scheduledStart", "desc")
    .limit(Number(firestoreConfig.sermonQueryLimit) || 20);

  const existingContent = readJson(contentPath, {}) || {};
  let photos = Array.isArray(existingContent.photos) ? existingContent.photos : [];
  let photoSlides = Array.isArray(existingContent.photoSlides) ? existingContent.photoSlides : [];
  let slides = Array.isArray(existingContent.slides) ? existingContent.slides : [];
  let remote = normalizeRemoteState(config);
  let syncedSermonSignature = "";
  let syncState = readJson(statePath, {}) || {};
  let manifestQueue = Promise.resolve();
  let driveSyncRunning = false;

  function queueManifestWrite() {
    manifestQueue = manifestQueue
      .then(() => writeJsonIfChanged(contentPath, buildManifest(config, photos, photoSlides, slides, remote)))
      .catch(error => console.error("Could not update content.json:", error));
    return manifestQueue;
  }

  async function applySnapshot(snapshot) {
    remote = normalizeRemoteState(config, snapshot.exists ? snapshot.data() : {});
    const currentControl = readJson(controlPath, {}) || {};
    await writeJsonIfChanged(controlPath, {
      mode: remote.mode,
      slideIndex: Number.isFinite(currentControl.slideIndex) ? currentControl.slideIndex : 0,
      photoIndex: Number.isFinite(currentControl.photoIndex) ? currentControl.photoIndex : 0
    });
    await queueManifestWrite();
    console.log(
      `Firestore snapshot applied: mode=${remote.mode}, `
      + `live=${remote.liveUrl ? "set" : "empty"}, `
      + `music=${remote.backgroundMusicUrl ? "set" : "empty"}`
    );
  }

  async function applySermonSnapshot(snapshot) {
    const sermon = normalizeSermon(snapshot);
    if (!sermon.liveUrl) {
      console.log("Latest sermon snapshot applied: no published sermon found");
      return;
    }

    const signature = [
      sermon.sourceSermonId,
      sermon.liveUrl,
      sermon.liveTitle,
      sermon.liveBody,
      sermon.liveMeta
    ].join("|");
    if (signature === syncedSermonSignature) return;

    syncedSermonSignature = signature;
    await signageDocument.set({
      liveUrl: sermon.liveUrl,
      liveTitle: sermon.liveTitle,
      liveBody: sermon.liveBody,
      liveMeta: sermon.liveMeta,
      liveSource: "sermons",
      liveSourceSermonId: sermon.sourceSermonId,
      liveThumbnailUrl: sermon.thumbnailUrl
    }, { merge: true });
    console.log(
      `Latest sermon synced to signage: ${sermon.liveTitle || sermon.liveUrl}`
    );
  }

async function syncDrive() {
    if (driveSyncRunning) return;
    const driveConfig = config.drive || {};
    const photosConfigured = driveConfig.photosFolderId && !driveConfig.photosFolderId.includes("PASTE_");
    const photoSlidesConfigured = driveConfig.photoSlidesFolderId && !driveConfig.photoSlidesFolderId.includes("PASTE_");
    const slidesConfigured = driveConfig.slidesFolderId && !driveConfig.slidesFolderId.includes("PASTE_");
    if (!photosConfigured || !photoSlidesConfigured || !slidesConfigured) {
      console.log("Drive sync partial: one or more folder IDs are not configured yet.");
    }
    if (!photosConfigured && !photoSlidesConfigured && !slidesConfigured) {
      await queueManifestWrite();
      return;
    }

    driveSyncRunning = true;
    try {
      const photoResult = photosConfigured
        ? await syncFolder(
          drive,
          driveConfig.photosFolderId,
          "photos",
          syncState.photos || {}
        )
        : { manifestItems: photos, currentState: syncState.photos || {} };
      const slideResult = slidesConfigured
        ? await syncFolder(
          drive,
          driveConfig.slidesFolderId,
          "slides",
          syncState.slides || {}
        )
        : { manifestItems: slides, currentState: syncState.slides || {} };
      const photoSlideResult = photoSlidesConfigured
        ? await syncFolder(
          drive,
          driveConfig.photoSlidesFolderId,
          "photo-slides",
          syncState.photoSlides || {}
        )
        : { manifestItems: photoSlides, currentState: syncState.photoSlides || {} };
      photos = photoResult.manifestItems;
      photoSlides = photoSlideResult.manifestItems;
      slides = slideResult.manifestItems;
      syncState = {
        photos: photoResult.currentState,
        photoSlides: photoSlideResult.currentState,
        slides: slideResult.currentState
      };
      await writeJsonIfChanged(statePath, syncState);
      await queueManifestWrite();
      console.log(
        `Drive sync complete: ${photos.length} wall photos, `
        + `${photoSlides.length} photo slides, ${slides.length} announcement slides`
      );
    } finally {
      driveSyncRunning = false;
    }
  }

  const unsubscribeSignage = signageDocument.onSnapshot(
    snapshot => {
      applySnapshot(snapshot).catch(error => {
        console.error("Could not apply Firestore snapshot:", error);
      });
    },
    error => {
      console.error("Firestore snapshot listener stopped:", error);
      process.exitCode = 1;
    }
  );
  const unsubscribeSermons = useLatestSermon
    ? latestSermonQuery.onSnapshot(
      snapshot => {
        applySermonSnapshot(snapshot).catch(error => {
          console.error("Could not apply latest sermon snapshot:", error);
        });
      },
      error => {
        console.error("Latest sermon snapshot listener stopped:", error);
        process.exitCode = 1;
      }
    )
    : () => {};

  await syncDrive();
  const syncSeconds = Math.max(30, Number((config.drive || {}).syncSeconds) || 300);
  const driveTimer = setInterval(() => {
    syncDrive().catch(error => console.error("Drive sync failed; retrying later:", error));
  }, syncSeconds * 1000);

  console.log(
    `Watching Firestore `
    + `${firestoreConfig.signageCollection || firestoreConfig.collection || "appContent"}`
    + `/${firestoreConfig.signageDocument || firestoreConfig.document || "signage"}`
    + `${useLatestSermon ? ` and ${sermonsCollection}` : ""}; `
    + `syncing Drive every ${syncSeconds} seconds.`
  );

  function shutdown() {
    clearInterval(driveTimer);
    unsubscribeSignage();
    unsubscribeSermons();
    process.exit();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
