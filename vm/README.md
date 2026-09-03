# Church VM media tooling

Version-controlled copy of what runs on the church VM (`192.168.2.18`) to
control the AV setup. Install/update with `sudo vm/install.sh` after `git pull`.

```
media up|sleep|down|status         camera + media PC + NDI (unchanged)
media stream prep                  up + camera preset + wake Mac Mini + open OBS + verify sources
media stream start|stop|status     OBS Start/Stop Streaming, readiness summary
media mac status|wake|ssh          Mac Mini
media obs open|start|stop|status   OBS on the Mac Mini (obs-websocket)
media camera preset N              OBSBOT Tail Air VISCA-over-IP preset recall
```

## Topology

- **Media PC (Windows)** — slides/music → NDI. Woken with Wake-on-LAN, driven over SSH.
- **Camera (OBSBOT Tail Air 2)** — PoE powered (switch API), NDI out, VISCA over IP for presets.
- **Mac Mini** — OBS ingests both NDI sources + X32 audio over USB-C, streams to YouTube + MediaMTX.

## One-time setup

### Mac Mini
1. **System Settings → General → Sharing → Remote Login: On** (for the user that runs OBS).
2. Copy the VM's SSH key so it can log in without a password. On the VM:
   `ssh-copy-id -p 22 <macuser>@<mac-ip>` (uses `~/.ssh/id_*` of the `awesomechurch` user).
   Test: `ssh <macuser>@<mac-ip> 'open -a OBS'`
3. **System Settings → Energy → Wake for network access: On**, and note the Mac's Ethernet
   MAC address (`ifconfig en0 | grep ether`) for Wake-on-LAN. Simplest is to just leave the
   Mac awake; sleep + WoL works but is less predictable than the Windows PC.
4. **OBS → Tools → WebSocket Server Settings** → Enable WebSocket server, port `4455`,
   Enable Authentication, set a password. (Built into OBS 28+; no plugin needed.)
5. Make sure OBS **Settings → Stream** points at the persistent YouTube stream key
   (plus the MediaMTX output). The bot creates each week's broadcast and binds it to
   that key, so OBS never needs a new key.

### Camera
- OBSBOT app → the Tail Air → confirm **VISCA over IP** is enabled (UDP 52381).
- Save the service framing as a preset. VISCA memory numbers start at 0, so if the
  app's "Preset 1" turns out to be memory 0, set `CAMERA_PRESET_PREP=0`.

### VM
Add to `/etc/awesomechurch-media.env` (root-only file, values are examples):

```
MAC_MINI_IP=192.168.2.30
MAC_SSH_HOST=streamer@192.168.2.30
MAC_SSH_PORT=22
MAC_MINI_MAC=aa:bb:cc:dd:ee:ff          # optional, for Wake-on-LAN
OBS_WS_HOST=192.168.2.30                # defaults to MAC_MINI_IP
OBS_WS_PORT=4455
OBS_WS_PASSWORD=change-me
OBS_REQUIRED_INPUTS=Media PC,Camera,X32 # exact OBS source names that must exist
OBS_APP_NAME=OBS
CAMERA_PRESET_PREP=1                    # preset recalled during "stream prep"; blank to skip
CAMERA_VISCA_PORT=52381
```

Then: `sudo vm/install.sh` and `media stream status`.

## Output conventions

Every command prints human-readable progress, `KEY=VALUE` lines the n8n workflows
parse (`CAMERA_RESULT`, `PC_RESULT`, `NDI_RESULT`, `MAC_RESULT`, `OBS_RESULT`,
`OBS_STREAMING`, …) and finally one JSON line:
`{"success":true|false,"partial_success":bool,"action":"…","message":"…"}`.
Exit code 0 = success, 2 = partial, 1 = failure.
