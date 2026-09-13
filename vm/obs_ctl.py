#!/usr/bin/env python3
"""Control OBS Studio on the Mac Mini through obs-websocket (v5).

Called by /usr/local/bin/media (obs start|stop|status). Prints KEY=VALUE lines
followed by one JSON result line, matching the media script's conventions.

Env / flags:
  OBS_WS_HOST, OBS_WS_PORT (4455), OBS_WS_PASSWORD
  OBS_REQUIRED_INPUTS  comma-separated OBS input names that must exist for
                       "status" to count as ready (e.g. "Media PC,Camera,X32")

Usage:
  obs_ctl.py status
  obs_ctl.py start
  obs_ctl.py stop
  obs_ctl.py scene --name "Full Screen Computer"
  obs_ctl.py audio [--inputs "Capture Card Device"] [--seconds 6]
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import sys
import time

try:
    import websocket  # websocket-client
except ImportError:  # pragma: no cover
    print("OBS_STATE=error")
    print(json.dumps({"success": False, "partial_success": False, "action": "obs",
                      "message": "python package 'websocket-client' is missing; run vm/install.sh"}))
    sys.exit(1)


def result(success: bool, action: str, message: str, partial: bool = False) -> None:
    print(json.dumps({"success": success, "partial_success": partial,
                      "action": action, "message": message}))


class Obs:
    def __init__(self, host: str, port: int, password: str, timeout: float = 5.0, event_subscriptions: int = 0):
        self.url = f"ws://{host}:{port}"
        self.password = password
        self.timeout = timeout
        self.event_subscriptions = event_subscriptions
        self.ws = None
        self._req = 0

    def connect(self) -> None:
        self.ws = websocket.create_connection(self.url, timeout=self.timeout)
        hello = json.loads(self.ws.recv())
        if hello.get("op") != 0:
            raise RuntimeError(f"unexpected first message: {hello}")
        identify = {"rpcVersion": 1, "eventSubscriptions": self.event_subscriptions}
        auth = hello.get("d", {}).get("authentication")
        if auth:
            if not self.password:
                raise RuntimeError("OBS requires a password but OBS_WS_PASSWORD is empty")
            secret = base64.b64encode(
                hashlib.sha256((self.password + auth["salt"]).encode()).digest()).decode()
            identify["authentication"] = base64.b64encode(
                hashlib.sha256((secret + auth["challenge"]).encode()).digest()).decode()
        self.ws.send(json.dumps({"op": 1, "d": identify}))
        identified = json.loads(self.ws.recv())
        if identified.get("op") != 2:
            raise RuntimeError(f"authentication failed: {identified}")

    def request(self, request_type: str, data: dict | None = None) -> dict:
        self._req += 1
        rid = str(self._req)
        self.ws.send(json.dumps({"op": 6, "d": {"requestType": request_type,
                                                "requestId": rid, "requestData": data or {}}}))
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            msg = json.loads(self.ws.recv())
            if msg.get("op") == 7 and msg["d"].get("requestId") == rid:
                status = msg["d"].get("requestStatus", {})
                if not status.get("result"):
                    raise RuntimeError(f"{request_type} failed: {status.get('comment') or status}")
                return msg["d"].get("responseData") or {}
        raise RuntimeError(f"{request_type}: no response")

    def close(self) -> None:
        if self.ws:
            try:
                self.ws.close()
            except Exception:
                pass


def snapshot(obs: Obs, required: list[str]) -> dict:
    stream = obs.request("GetStreamStatus")
    scene = obs.request("GetCurrentProgramScene")
    inputs = [i.get("inputName", "") for i in obs.request("GetInputList").get("inputs", [])]
    missing = [name for name in required if name not in inputs]
    version = obs.request("GetVersion")

    # Which video encoder the stream output uses. A software encoder (x264)
    # on the Mac Mini is what produces "encoding overloaded" mid-service.
    mode, encoder = "", ""
    try:
        mode = obs.request("GetProfileParameter",
                           {"parameterCategory": "Output", "parameterName": "Mode"}).get("parameterValue") or "Simple"
        if mode == "Advanced":
            encoder = obs.request("GetProfileParameter",
                                  {"parameterCategory": "AdvOut", "parameterName": "Encoder"}).get("parameterValue") or ""
        else:
            encoder = obs.request("GetProfileParameter",
                                  {"parameterCategory": "SimpleOutput", "parameterName": "StreamEncoder"}).get("parameterValue") or ""
    except Exception:
        pass
    software_encoder = "x264" in encoder.lower() or encoder.lower() in ("obs_x264",)

    info = {
        "streaming": bool(stream.get("outputActive")),
        "stream_seconds": int(stream.get("outputDuration", 0) / 1000),
        "skipped_frames": int(stream.get("outputSkippedFrames", 0) or 0),
        "total_frames": int(stream.get("outputTotalFrames", 0) or 0),
        "scene": scene.get("currentProgramSceneName") or scene.get("sceneName") or "",
        "inputs": inputs,
        "missing_inputs": missing,
        "obs_version": version.get("obsVersion", ""),
        "output_mode": mode,
        "encoder": encoder,
        "software_encoder": software_encoder,
    }
    print("OBS_STATE=running")
    print(f"OBS_VERSION={info['obs_version']}")
    print(f"OBS_STREAMING={'true' if info['streaming'] else 'false'}")
    print(f"OBS_STREAM_SECONDS={info['stream_seconds']}")
    print(f"OBS_SKIPPED_FRAMES={info['skipped_frames']}")
    print(f"OBS_SCENE={info['scene']}")
    print(f"OBS_INPUTS={', '.join(inputs)}")
    print(f"OBS_MISSING_INPUTS={', '.join(missing)}")
    print(f"OBS_OUTPUT_MODE={mode}")
    print(f"OBS_ENCODER={encoder}")
    print(f"OBS_SOFTWARE_ENCODER={'true' if software_encoder else 'false'}")
    return info


# obs-websocket EventSubscription::InputVolumeMeters (high-volume, opt-in).
EVENT_INPUT_VOLUME_METERS = 1 << 16


def mul_to_db(mul: float) -> float:
    return 20.0 * math.log10(mul) if mul and mul > 0 else -120.0


def audio_check(obs: Obs, targets: list[str], seconds: float, quiet_db: float, silent_db: float) -> tuple[int, str]:
    """Listen to OBS's audio meters for `seconds` and report the peak per input."""
    inputs = [i.get("inputName", "") for i in obs.request("GetInputList").get("inputs", [])]
    peaks: dict[str, float] = {}
    deadline = time.time() + seconds
    obs.ws.settimeout(1.0)
    while time.time() < deadline:
        try:
            msg = json.loads(obs.ws.recv())
        except websocket.WebSocketTimeoutException:
            continue
        if msg.get("op") != 5 or msg.get("d", {}).get("eventType") != "InputVolumeMeters":
            continue
        for entry in msg["d"].get("eventData", {}).get("inputs", []):
            name = entry.get("inputName", "")
            levels = entry.get("inputLevelsMul") or []
            peak = 0.0
            for ch in levels:
                if ch:
                    peak = max(peak, float(ch[1] if len(ch) > 1 else ch[0]))
            peaks[name] = max(peaks.get(name, 0.0), peak)
    obs.ws.settimeout(obs.timeout)

    metered = sorted(peaks.keys())
    if not targets:
        targets = metered
    levels_line = "; ".join(f"{n}={mul_to_db(peaks.get(n, 0.0)):.1f}dB" for n in metered) or "(no audio inputs reported levels)"
    print(f"AUDIO_SECONDS={int(seconds)}")
    print(f"AUDIO_LEVELS={levels_line}")

    states = []
    for name in targets:
        if name not in inputs:
            states.append((name, "missing", -120.0, False))
            continue
        muted = False
        try:
            muted = bool(obs.request("GetInputMute", {"inputName": name}).get("inputMuted"))
        except Exception:
            muted = False
        db = mul_to_db(peaks.get(name, 0.0))
        if muted:
            state = "muted"
        elif name not in peaks:
            state = "no-meter"
        elif db < silent_db:
            state = "silent"
        elif db < quiet_db:
            state = "quiet"
        else:
            state = "ok"
        states.append((name, state, db, muted))

    best = max(states, key=lambda t: t[2]) if states else ("", "missing", -120.0, False)
    name, state, db, muted = best
    print(f"AUDIO_INPUT={name}")
    print(f"AUDIO_PEAK_DB={db:.1f}")
    print(f"AUDIO_MUTED={'true' if muted else 'false'}")
    print(f"AUDIO_STATE={state}")
    problems = [f"'{n}' is {st}" for n, st, _, _ in states if st not in ("ok", "quiet")]

    if state == "ok":
        code = 0
        msg = f"OBS is receiving audio on '{name}' (peak {db:.0f} dB over {int(seconds)} s)"
        if problems:
            msg += "; " + ", ".join(problems)
    elif state == "quiet":
        code = 2
        msg = f"Audio on '{name}' is very quiet (peak {db:.0f} dB over {int(seconds)} s) — check the mixer send level"
    elif state == "muted":
        code = 1
        msg = f"'{name}' is MUTED in OBS — unmute it in the audio mixer panel"
    elif state == "missing":
        code = 1
        msg = f"OBS has no input named '{name}' (have: {', '.join(inputs) or 'none'}) — set OBS_AUDIO_INPUTS to the audio source name"
    elif state == "no-meter":
        code = 1
        msg = f"OBS reports no audio meter for '{name}' — the device may be disconnected or the source has no audio"
    else:
        code = 1
        msg = f"NO audio on '{name}' for {int(seconds)} s (peak {db:.0f} dB) — check the X32 USB link, the mixer routing, and that the input is not muted"
    print(f"AUDIO_RESULT={code}")
    return code, msg


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["status", "start", "stop", "scene", "audio"])
    parser.add_argument("--name", default=os.environ.get("OBS_PREP_SCENE", ""), help="scene name for the scene command")
    parser.add_argument("--host", default=os.environ.get("OBS_WS_HOST", ""))
    parser.add_argument("--port", type=int, default=int(os.environ.get("OBS_WS_PORT", "4455") or 4455))
    parser.add_argument("--password", default=os.environ.get("OBS_WS_PASSWORD", ""))
    parser.add_argument("--required-inputs", default=os.environ.get("OBS_REQUIRED_INPUTS", ""))
    parser.add_argument("--wait", type=int, default=20, help="seconds to wait for streaming state to change")
    parser.add_argument("--inputs", default=os.environ.get("OBS_AUDIO_INPUTS", ""), help="comma-separated audio inputs to judge (default: every input with a meter)")
    parser.add_argument("--seconds", type=float, default=float(os.environ.get("OBS_AUDIO_SECONDS", "6") or 6), help="how long to listen to the meters")
    parser.add_argument("--quiet-db", type=float, default=-40.0)
    parser.add_argument("--silent-db", type=float, default=-60.0)
    args = parser.parse_args()

    if not args.host:
        print("OBS_STATE=error")
        result(False, f"obs-{args.command}", "OBS_WS_HOST is not set")
        return 1

    required = [s.strip() for s in args.required_inputs.split(",") if s.strip()]
    obs = Obs(args.host, args.port, args.password,
              event_subscriptions=EVENT_INPUT_VOLUME_METERS if args.command == "audio" else 0)
    try:
        obs.connect()
    except Exception as e:
        print("OBS_STATE=unreachable")
        result(False, f"obs-{args.command}", f"Could not connect to OBS WebSocket at {args.host}:{args.port}: {e}")
        return 1

    action = f"obs-{args.command}"
    try:
        if args.command == "audio":
            targets = [s.strip() for s in args.inputs.split(",") if s.strip()]
            code, msg = audio_check(obs, targets, args.seconds, args.quiet_db, args.silent_db)
            result(code == 0, action, msg, partial=(code == 2))
            return code

        info = snapshot(obs, required)

        if args.command == "status":
            if info["missing_inputs"]:
                result(False, action, "OBS is running but these sources are missing: " + ", ".join(info["missing_inputs"]), partial=True)
                return 2
            if info["software_encoder"]:
                result(False, action, f"OBS is using the software encoder ({info['encoder']}); switch Settings > Output to the Apple hardware encoder or it will overload", partial=True)
                return 2
            state = "streaming" if info["streaming"] else "ready (not streaming)"
            result(True, action, f"OBS is {state}, scene '{info['scene']}'")
            return 0

        if args.command == "start":
            if info["streaming"]:
                result(True, action, "OBS was already streaming")
                return 0
            if info["missing_inputs"]:
                result(False, action, "Not starting: OBS is missing sources: " + ", ".join(info["missing_inputs"]))
                return 1
            obs.request("StartStream")
            deadline = time.time() + args.wait
            while time.time() < deadline:
                time.sleep(1)
                if obs.request("GetStreamStatus").get("outputActive"):
                    print("OBS_STREAMING=true")
                    result(True, action, "OBS is now streaming")
                    return 0
            result(False, action, "OBS accepted StartStream but the stream did not become active; check Settings > Stream")
            return 1

        if args.command == "scene":
            if not args.name:
                result(False, action, "No scene name given (--name or OBS_PREP_SCENE)")
                return 1
            if info["scene"] == args.name:
                result(True, action, f"OBS is already on scene '{args.name}'")
                return 0
            scenes = [s.get("sceneName", "") for s in obs.request("GetSceneList").get("scenes", [])]
            if args.name not in scenes:
                result(False, action, f"Scene '{args.name}' does not exist in OBS (have: {', '.join(scenes)})")
                return 1
            obs.request("SetCurrentProgramScene", {"sceneName": args.name})
            now = obs.request("GetCurrentProgramScene")
            current = now.get("currentProgramSceneName") or now.get("sceneName") or ""
            print(f"OBS_SCENE={current}")
            if current == args.name:
                result(True, action, f"OBS switched to scene '{args.name}'")
                return 0
            result(False, action, f"OBS did not switch to '{args.name}' (still on '{current}')")
            return 1

        if args.command == "stop":
            if not info["streaming"]:
                result(True, action, "OBS was not streaming")
                return 0
            obs.request("StopStream")
            deadline = time.time() + args.wait
            while time.time() < deadline:
                time.sleep(1)
                if not obs.request("GetStreamStatus").get("outputActive"):
                    print("OBS_STREAMING=false")
                    result(True, action, "OBS stream stopped")
                    return 0
            result(False, action, "OBS accepted StopStream but the stream is still active")
            return 1
    except Exception as e:
        result(False, action, f"OBS request failed: {e}")
        return 1
    finally:
        obs.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
