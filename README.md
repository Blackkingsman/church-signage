# Church Signage

Lobby TV display for Awesome Church, plus the media-control tooling that runs
on the same church VM. The TV opens one page and stays there; content and
modes are controlled remotely without reloading the browser.

What the TV can show:

| Mode | Source | Notes |
|---|---|---|
| `wall` | Google Drive *Living Wall Photos* | Polaroid-style photo wall sized to real-world Instax dimensions for the TV's diagonal; portrait and landscape handled by real orientation; background music |
| `photo` | Google Drive *Photo Slideshow* | One fullscreen photo at a time |
| `slides` | Google Drive *Announcement Slides* | Ordered by filename (`001-…`, `002-…`) |
| `live` | Local HLS stream (MediaMTX) | The livestream with the current sermon's title and details |

Photos removed from Drive disappear on the next sync. Drive media is cached
on the VM so the display survives an internet outage.

This project is one piece of a larger setup. The Firestore project, the
backend that mirrors sermon info here, and the Telegram assistant that
switches modes are documented in the
[awesome_church](https://github.com/Blackkingsman/awesome_church) repo
(`docs/`).

## Architecture

```text
Google Drive Living Wall Photos ─┐
Google Drive Photo Slideshow ────┼─► signage_bridge.js ─► media/ + content.json ─┐
Google Drive Announcement Slides ┘         ▲                                     │
                                           │ onSnapshot (read-only)              ▼
Firestore appContent/signage ──────────────┘ ─► control.json ──► server.js ──► index.html on the TV

Written elsewhere:
  appContent/signage.mode                 ← Telegram assistant (n8n) or Firebase console
  appContent/signage.live* (6 fields)     ← awesome_church backend, from the newest sermon
  appContent/signage.liveUrl, music, wall ← humans, in the Firebase console
```

- `signage_bridge.js` mirrors three Drive folders to disk every `syncSeconds`
  (default 300), listens to `appContent/signage` in real time, and writes
  `content.json` / `control.json`. It **only reads** Firestore.
- `server.js` serves the page and the JSON files on the LAN and blocks the
  service-account key.
- `index.html` polls the JSON files and switches modes without a reload.
- `vm/` holds the `media` controller for the AV gear (camera, media PC, NDI,
  Mac Mini, OBS, livestream). See [vm/README.md](vm/README.md).

## 1. Google Cloud setup

Use the same Google Cloud project as the Firebase project.

1. **APIs & Services → Library** → enable the **Google Drive API**.
2. **IAM & Admin → Service Accounts** → create a dedicated signage account
   with a **read-only Firestore role** (e.g. Cloud Datastore Viewer). This
   project never writes to Firestore.
3. Create a JSON key, rename it `serviceAccountKey.json`, and place it next
   to `signage_bridge.js`. It is gitignored and blocked by the web server.

## 2. Google Drive setup

Create three folders and share each with the service account's
`client_email` as **Viewer**:

```text
Living Wall/
  Living Wall Photos/
  Photo Slideshow/
  Announcement Slides/
```

Supported media: `.jpg .jpeg .png .webp .gif`. Export PowerPoint, Google
Slides, or PDFs as fullscreen images before adding them to *Announcement
Slides*. Slide filenames control order (`001-welcome.png`); photo filenames
do not.

Copy each folder's ID from its URL
(`https://drive.google.com/drive/folders/<FOLDER_ID>`) into
`signage.config.json` (start from `signage.config.example.json`):

```json
{
  "serviceAccountKey": "./serviceAccountKey.json",
  "firestore": { "signageCollection": "appContent", "signageDocument": "signage" },
  "drive": {
    "photosFolderId": "…",
    "photoSlidesFolderId": "…",
    "slidesFolderId": "…",
    "syncSeconds": 300
  },
  "wall": { "eyebrow": "Community moments", "title": "Our week together", "screenInches": 65, "cardScale": 1 },
  "live": { "label": "Live now", "title": "Join us inside.", "body": "…", "meta": "…" },
  "music": { "enabled": true, "volume": 55 }
}
```

`signage.config.json` is gitignored.

## 3. Firestore document

`appContent/signage`, one flat document. Who writes each field:

| Field | Type | Written by | Notes |
|---|---|---|---|
| `mode` | string | Telegram assistant, or by hand | `wall` / `photo` / `slides` / `live` |
| `liveUrl` | string | by hand | HLS URL of the local MediaMTX server, e.g. `http://<mediamtx-host>:8888/live/index.m3u8`. YouTube links also work. Never auto-set. |
| `backgroundMusicUrl` | string | by hand | YouTube link for the wall's background music |
| `musicEnabled` | boolean | by hand | |
| `musicVolume` | number | by hand | 0–100 |
| `wallScreenInches` | number | by hand | TV diagonal; drives real-size polaroid cards. Overrides `wall.screenInches` in the config. |
| `wallCardScale` | number | by hand | Multiplier on real Instax Wide size (1 = life size). Overrides `wall.cardScale`. |
| `photoIntervalSeconds`, `slideIntervalSeconds` | number | by hand | Slideshow timing |
| `liveLabel` | string | by hand | Optional label on the live screen |
| `liveTitle`, `liveBody`, `liveMeta`, `liveSource`, `liveSourceSermonId`, `liveThumbnailUrl` | string | **awesome_church backend** | Mirrored from the newest published sermon. Don't edit by hand; the backend re-applies them. |

Every change to this document reaches the TV within a second or two through
the bridge's `onSnapshot` listener. No page reload.

## 4. Running on the VM

The VM is Debian. Requirements: `node`, `npm`, `python3`, `curl`.

```bash
git clone https://github.com/Blackkingsman/church-signage.git ~/photowall
cd ~/photowall
# add serviceAccountKey.json and signage.config.json (see above)
./start_signage.sh          # npm ci, then starts the bridge and the server in the background
./check_signage.sh          # health check; restarts both only if one is down
```

`start_signage.sh` writes PIDs to `run/` and logs to `logs/`
(`bridge.log`, `server.log`). A healthy bridge logs:

```text
Drive sync complete: 100 photos, 10 slides
Firestore snapshot applied: mode=wall, live=set, music=set
Watching Firestore appContent/signage; syncing Drive every 300 seconds.
```

Point the TV's browser at `http://<vm-lan-address>:8000/`.

**Deploying a change**: push to this repo, then on the VM:

```bash
cd ~/photowall && git pull --ff-only && ./start_signage.sh
```

`check_signage.sh` does **not** restart a bridge that is already running, so
after a code change use `start_signage.sh` explicitly, or the old process
keeps serving old code.

`deploy_to_vm.ps1` is an alternative that copies the working tree over SSH
from a Windows machine. It takes the target from `-Target user@host` or the
`SIGNAGE_VM_TARGET` environment variable.

**Sunday automation**: an n8n workflow runs `check_signage.sh` over SSH every
Sunday morning along with the livestream prep, and reports to the tech
team's Telegram group if the display had to be restarted or could not start.

## 5. Local override

For emergencies on the VM, the mode can be forced locally; the next
Firestore change becomes authoritative again:

```bash
python3 display_control.py wall|slides|photo|live
python3 display_control.py --status
```

## 6. Hidden display controls

- Top-left invisible touch zone: toggle background music mute.
- Top-right invisible touch zone: enter or exit fullscreen.

Android and TV browsers require a real user tap before allowing unmuted
audio or fullscreen; nothing remote can fake that.

## Media controller (`vm/`)

`vm/media` is the bash controller installed to `/usr/local/bin/media` on the
VM. It powers the PoE camera, wakes and sleeps the Windows media PC, manages
NDI, wakes the Mac Mini, opens and controls OBS over obs-websocket, recalls
camera presets over VISCA, and chains all of that into `media stream prep`,
`start`, `stop`, `status`. The Telegram assistant and the Sunday automation
call it over SSH. Setup, env file, and output conventions:
[vm/README.md](vm/README.md).

## Troubleshooting

| Symptom | Check |
|---|---|
| "Configuration is incomplete" | `serviceAccountKey.json` present, all three folder IDs in `signage.config.json` |
| Firestore permission denied | Key belongs to the Firebase project and has a Firestore **read** role |
| Drive 404 or no images | Each folder shared with the service account's `client_email`; supported formats only |
| Slides out of order | Use zero-padded numeric prefixes |
| Firestore changes don't reach the TV | `./check_signage.sh`; `logs/bridge.log` should show `Firestore snapshot applied` |
| TV shows sample content | No usable `content.json` yet; the bridge must report at least one photo or slide |
| Live mode is blank | `liveUrl` must point at a reachable HLS or YouTube URL; confirm OBS is streaming to MediaMTX |
| Cards look too big or small | Tune `wallScreenInches` / `wallCardScale` in Firestore |
