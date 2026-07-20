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
- Firestore `sermons` updates `appContent/signage` when a newer sermon appears.
- A real Firestore `onSnapshot` listener applies changes as soon as they arrive.
- The TV changes modes and content without a page reload.
- Drive images are cached on the church VM, so existing media survives an
  internet interruption.

## Architecture

```text
Google Drive Living Wall Photos -----\
Google Drive Photo Slideshow ---------> signage_bridge.js -> content.json -> SPA
Google Drive Announcement Slides -----/

Firestore sermons --------------> onSnapshot -> appContent/signage live fields
Firestore appContent/signage ---> onSnapshot -> control.json + content.json
```

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
3. Grant it **Cloud Datastore User** so it can read Firestore.
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
    "signageDocument": "signage",
    "sermonsCollection": "sermons",
    "useLatestSermon": true,
    "sermonOrderBy": "scheduledStart",
    "sermonQueryLimit": 20
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

The bridge writes `liveUrl`, `liveTitle`, `liveBody`, `liveMeta`, `liveSource`,
`liveSourceSermonId`, and `liveThumbnailUrl` automatically when it detects a
new latest sermon. The tech team can still manually edit these fields in
Firebase for a special event or test stream.

No index field is required. Slides and photos advance automatically.

Whenever this document changes, the bridge's Firestore `onSnapshot` listener
immediately updates the local display state:

- `mode` updates `control.json`.
- `liveUrl` updates the live player in `content.json`.
- `backgroundMusicUrl`, `musicEnabled`, and `musicVolume` update the background
  player in `content.json`.

The SPA notices those files and applies them without reloading.

## 4. Sermon Live Feed

The bridge also listens to the `sermons` collection and reads the newest sermon
by `scheduledStart`. It looks at the most recent 20 docs, skips docs where
`isPublished` is `false` or `isSermon` is `false`, and uses the first valid one.
When that newest sermon changes, the bridge updates the live fields on
`appContent/signage`. The webpage only follows `appContent/signage`, so manual
changes to `mode`, `backgroundMusicUrl`, or live fields apply through the same
snapshot path.

Supported sermon fields:

| Field | Used For |
| --- | --- |
| `videoUrl` | Preferred live URL |
| `youtubeVideoId` or `videoId` | Builds a YouTube URL when `videoUrl` is missing |
| `title` or `fullTitle` | Live-screen title |
| `description` | Live-screen body |
| `speaker` and `displayDate` | Live-screen meta line |
| `scheduledStart` | Latest-sermon ordering |
| `isPublished` | Must not be `false` |
| `isSermon` | Must not be `false` |

Example sermon URL resolution:

```text
videoUrl -> https://www.youtube.com/watch?v=8WChqo2NYVw
```

## 5. Install

Open PowerShell in this project and run:

```powershell
npm install
```

This installs the Google Drive and Firebase Admin libraries. It only needs to be
repeated when `package.json` changes.

## 6. Test the Integration

To initialize `appContent/signage` with the latest sermon and the default
background music URL, run:

```powershell
npm run seed
```

You can optionally set the starting mode:

```powershell
npm run seed -- live
```

First, start the integration bridge:

```powershell
npm run bridge
```

A successful start reports:

```text
Drive sync complete: 100 photos, 10 slides
Firestore snapshot applied: mode=wall, live=set, music=set
Latest sermon synced to signage: AWESOME CHURCH KOR LIVE | INT 11AM | THE GOD WHO MEETS MY NEEDS
Watching Firestore appContent/signage and sermons
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
2. Add or update a newer published sermon and confirm `appContent/signage.liveUrl`
   updates.
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

Confirm the key belongs to the Firebase project and the service account has the
**Cloud Datastore User** role.

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
