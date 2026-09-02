# Church Signage SPA

This project is a local signage display for the church TV. The display device
opens one page and stays there; content and modes are controlled remotely
without reloading the browser.

## End Result

After completing this setup:

- Wall photos are read from a Google Drive `Living Wall Photos` folder.
- Fullscreen photos are read from a separate Google Drive `Photo Slideshow` folder.
- Announcement slides are read from a Google Drive `Announcement Slides` folder.
- Slides are ordered by filename.
- The photo wall and photo slideshow use their own independent photo pools.
- Firestore `appContent/signage` controls the active mode, live URL, and background music.
- The backend (`awesome_church/backend`, not this project) watches `sermons` and updates
  `appContent/signage`'s live title/body/meta/thumbnail whenever a newer sermon appears.
  `liveUrl` is no longer auto-populated (the church runs local RTMP push, not YouTube) —
  it's set by hand in Firebase console only, for a special event or test stream.
- A real Firestore `onSnapshot` listener applies changes as soon as they arrive.
- The TV changes modes and content without a page reload.
- Drive images are cached on the church VM, so existing media survives an
  internet interruption.

## Architecture

```text
Google Drive Living Wall Photos -----\
Google Drive Photo Slideshow ---------> signage_bridge.js -> content.json -> SPA
Google Drive Announcement Slides -----/

Firestore appContent/signage ---> onSnapshot (read-only) -> control.json + content.json

  (elsewhere, in the awesome_church backend, NOT this project:)
  Firestore sermons -----> appContent/signage live fields (title/body/meta/thumbnail, no liveUrl)
```

This project only ever *reads* Firestore — it never writes to it. Sermon data is
mirrored into `appContent/signage` server-side by the main backend
(`awesome_church/backend/run.py`), which already watches `sermons` for other
purposes. Keeping that write logic in one place avoids two independent
processes racing to update the same document.

The browser never receives the service account key. The local server only
exposes `index.html`, `control.json`, `content.json`, and downloaded media.

## 1. Google Cloud Setup

Use the same Google Cloud project as the existing Firebase project.

### Enable the Drive API

1. Open Google Cloud Console.
2. Select the Firebase project.
3. Open **APIs & Services > Library**.
4. Find **Google Drive API** and enable it.

### Create the service account key

1. Open **IAM & Admin > Service Accounts**.
2. Create a dedicated signage service account.
3. Grant it a **read-only Firestore role** (e.g. Cloud Datastore Viewer) —
   this project only ever reads `appContent/signage`, it never writes.
4. Open the service account, select **Keys**, and create a JSON key.
5. Download the key.
6. Rename it to `serviceAccountKey.json`.
7. Place it beside `signage_bridge.js` in this project.

Expected location:

```text
C:\Users\Terry\OneDrive\Documents\photowall\serviceAccountKey.json
```

The key is ignored by Git and blocked by the local web server. Never publish or
send this file publicly.

## 2. Google Drive Setup

Create these folders:

```text
Living Wall/
  Living Wall Photos/
  Photo Slideshow/
  Announcement Slides/
```

Open `serviceAccountKey.json` and find its `client_email`. Share all three folders
and `Slides` with that email as **Viewer**.

Supported media:

```text
.jpg | .jpeg | .png | .webp | .gif
```

PowerPoint, Google Slides, and PDFs should be exported as full-screen image
files before placing them in `Slides`.

Photo filenames do not control presentation order. Slide filenames do:

```text
001-welcome.png
002-this-week.png
003-small-groups.png
004-offering.png
```

Open each Drive folder and copy the ID from its URL:

```text
https://drive.google.com/drive/folders/THIS_PART_IS_THE_FOLDER_ID
```

Edit `signage.config.json`:

```json
{
  "serviceAccountKey": "./serviceAccountKey.json",
  "firestore": {
    "signageCollection": "appContent",
    "signageDocument": "signage"
  },
  "drive": {
    "photosFolderId": "YOUR_PHOTOS_FOLDER_ID",
    "photoSlidesFolderId": "YOUR_PHOTO_SLIDES_FOLDER_ID",
    "slidesFolderId": "YOUR_SLIDES_FOLDER_ID",
    "syncSeconds": 300
  }
}
```

The bridge checks Drive every five minutes. Restarting the bridge also triggers
an immediate sync.

## 3. Firestore Setup

Create this document:

```text
appContent/signage
```

Add these fields using their matching Firestore types:

| Field | Type | Example |
| --- | --- | --- |
| `mode` | string | `wall` |
| `liveUrl` | string | `https://www.youtube.com/watch?v=8WChqo2NYVw` |
| `backgroundMusicUrl` | string | `https://www.youtube.com/watch?v=rtgVcSu7IY8` |
| `musicEnabled` | boolean | `true` |
| `musicVolume` | number | `55` |

Allowed `mode` values:

```text
wall | slides | photo | live
```

Optional live-screen text fields:

| Field | Type |
| --- | --- |
| `liveLabel` | string |
| `liveTitle` | string |
| `liveBody` | string |
| `liveMeta` | string |
| `liveSource` | string |
| `liveSourceSermonId` | string |
| `liveThumbnailUrl` | string |

The awesome_church backend writes `liveTitle`, `liveBody`, `liveMeta`,
`liveSource`, `liveSourceSermonId`, and `liveThumbnailUrl` automatically
whenever it detects a new latest sermon — this bridge does not, it only
reads this document. `liveUrl` is never auto-set (no YouTube link to derive
it from anymore); the tech team can still manually edit any of these fields
in Firebase for a special event or test stream.

No index field is required. Slides and photos advance automatically.

Whenever this document changes, the bridge's Firestore `onSnapshot` listener
immediately updates the local display state:

- `mode` updates `control.json`.
- `liveUrl` updates the live player in `content.json`.
- `backgroundMusicUrl`, `musicEnabled`, and `musicVolume` update the background
  player in `content.json`.

The SPA notices those files and applies them without reloading.

## 4. Sermon Live Feed (owned by the backend, not this project)

This bridge does **not** watch the `sermons` collection anymore. That job
belongs to the main `awesome_church` backend (`backend/run.py`), which
already watches `sermons` for push notifications and now also mirrors the
newest sermon into `appContent/signage`. See `_sync_latest_sermon_to_signage`
in that repo for the exact logic (most recent 20 docs by `scheduledStart`,
skipping `isPublished === false` or `isSermon === false`, first match wins).

This bridge only ever reads whatever ends up on `appContent/signage` — so
manual changes to `mode`, `backgroundMusicUrl`, or live fields in Firebase
console still apply immediately through the same `onSnapshot` path, same as
sermon-driven updates.

Fields the backend keeps in sync from the latest sermon:

| Field | Source |
| --- | --- |
| `liveTitle` | `title` or `fullTitle` |
| `liveBody` | `description` |
| `liveMeta` | `speaker` + `displayDate` |
| `liveThumbnailUrl` | `thumbnailUrl` |
| `liveSourceSermonId` | the sermon doc's ID |

`liveUrl` is never touched by this sync — the church now runs local RTMP
push instead of YouTube, so there's no meaningful URL to derive. Set it by
hand in Firebase console only if you need a link for a special event.

## 5. Install

Open PowerShell in this project and run:

```powershell
npm install
```

This installs the Google Drive and Firebase Admin libraries. It only needs to be
repeated when `package.json` changes.

## 6. Test the Integration

To initialize `appContent/signage` (mode, `backgroundMusicUrl`, or any live
field), edit the document directly in the Firebase console — this project no
longer writes to Firestore, so there's no local seed script anymore. The
backend keeps the sermon-derived live fields in sync on its own once a
published sermon exists.

First, start the integration bridge:

```powershell
npm run bridge
```

A successful start reports:

```text
Drive sync complete: 100 photos, 10 slides
Firestore snapshot applied: mode=wall, live=set, music=set
Watching Firestore appContent/signage; syncing Drive every 300 seconds.
```

It creates these local generated files:

```text
media/photos/
media/slides/
content.json
control.json
.signage-sync-state.json
```

Keep that PowerShell window running.

In a second PowerShell window, start the display server:

```powershell
npm start
```

Open this on the phone/TV:

```text
http://10.50.0.3:8000/
```

Test the complete flow:

1. Change Firestore `mode` to `wall`, `slides`, `photo`, and `live`.
2. In the `awesome_church` backend repo, add or update a newer published
   sermon and confirm `appContent/signage`'s `liveTitle`/`liveBody`/`liveMeta`/
   `liveThumbnailUrl` update (this bridge just reflects whatever lands there —
   it isn't the thing computing it).
3. Change `backgroundMusicUrl` and confirm the background player changes.
4. Add an image to each Drive folder.
5. Restart `npm run bridge` or wait for the next Drive sync.
6. Confirm the new files appear without refreshing the phone.

## Local Backup Control

The local Python helper can still override the current view temporarily:

```powershell
python display_control.py wall
python display_control.py slides
python display_control.py photo
python display_control.py live
python display_control.py --status
```

The next Firestore snapshot becomes authoritative again.

## Hidden Display Controls

- Top-left invisible touch zone toggles background music mute/unmute.
- Top-right invisible touch zone enters or exits fullscreen.

Android browsers require a real user tap before permitting unmuted audio or
fullscreen. Firestore and JavaScript cannot fake that trusted tap.

## VM Operation

For normal use, keep these two processes running on the church VM:

```powershell
npm run bridge
npm start
```

They can later be added to Windows Task Scheduler so they start automatically
when the VM starts. Keep the display on the church LAN and use the existing VPN
for offsite Firestore or Drive administration.

## Troubleshooting

### Configuration is incomplete

Confirm that `serviceAccountKey.json` exists and both Drive folder IDs have been
entered in `signage.config.json`.

### Firestore permission denied

Confirm the key belongs to the Firebase project and the service account has a
Firestore **read** role (e.g. Cloud Datastore Viewer). It doesn't need write
access — this project never writes to Firestore.

### Drive returns 404 or no images

Share each exact folder with the service account's `client_email`. Confirm the
files use one of the supported image formats.

### Slides appear in the wrong order

Use padded numeric prefixes such as `001`, `002`, and `003`.

### Firestore changes do not reach the TV

Confirm `npm run bridge` is still running and reports
`Firestore snapshot applied`. Then confirm `npm start` is running and the TV is
still on the VM's LAN address.

### The TV displays sample content

The SPA uses built-in samples when no usable `content.json` exists. Check the
bridge output and confirm it reports at least one downloaded photo or slide.
