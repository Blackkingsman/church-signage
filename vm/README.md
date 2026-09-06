# Church VM media tooling

Version-controlled copy of what runs on the church management VM to control
the AV setup. Install/update with `sudo bash vm/install.sh` after `git pull`.
Real hostnames and addresses live only in `/etc/awesomechurch-media.env` on
the VM; the values below are placeholders.

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
OBS_REQUIRED_INPUTS="NDI® Source, Capture Card Device"   # exact OBS source names; quote values with spaces (file is sourced by bash)
OBS_APP_NAME=OBS
CAMERA_PRESET_PREP=1                    # preset recalled during "stream prep"; blank to skip
CAMERA_VISCA_PORT=52381
MAC_REBOOT_PREP=1                       # reboot the Mac Mini during "stream prep" (see below); 0 to skip
```

### Sunday reboot of the Mac Mini (`MAC_REBOOT_PREP=1`)

`media stream prep` then does: wake → quit OBS cleanly → `shutdown -r now` →
wait for SSH to come back → 30 s for the desktop → open OBS. This gives the
USB audio interface a fresh boot every week. It needs, once, on the Mac:

1. Passwordless sudo for the reboot only (as the OBS user):
   ```
   echo "$USER ALL=(ALL) NOPASSWD: /sbin/shutdown" | sudo tee /etc/sudoers.d/media-reboot
   sudo chmod 440 /etc/sudoers.d/media-reboot
   ```
2. **System Settings → Users & Groups → Automatic login** set to the OBS user,
   so a GUI session exists after the reboot for `open -a OBS` to land in.
   FileVault must be **off** for automatic login to work.
3. Test from the VM: `media mac reboot`, then `media obs open`.

OBS is quit with AppleScript (same as Cmd+Q) before the reboot so it saves
state; a hard kill makes the next launch stop on the "start in safe mode?"
dialog, and the WebSocket never comes up.

### Encoder check

`obs status` reports `OBS_ENCODER` and `OBS_SOFTWARE_ENCODER`. On the Mac
Mini the stream encoder must be the **Apple VT hardware encoder**
(Settings → Output → Streaming → Video Encoder), never x264; status returns
partial (exit 2) when a software encoder is selected. For the second output
to MediaMTX, set the Multiple RTMP Outputs target to reuse the main stream's
encoders instead of encoding again, or the Mac encodes everything twice.

Then: `sudo vm/install.sh` and `media stream status`.

## Output conventions

Every command prints human-readable progress, `KEY=VALUE` lines the n8n workflows
parse (`CAMERA_RESULT`, `PC_RESULT`, `NDI_RESULT`, `MAC_RESULT`, `OBS_RESULT`,
`OBS_STREAMING`, …) and finally one JSON line:
`{"success":true|false,"partial_success":bool,"action":"…","message":"…"}`.
Exit code 0 = success, 2 = partial, 1 = failure.
