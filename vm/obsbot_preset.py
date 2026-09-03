#!/usr/bin/env python3
"""Recall a saved position (preset) on the OBSBOT Tail Air over VISCA-over-IP.

The Tail Air listens on UDP 52381 and expects Sony-style encapsulated VISCA:
an 8-byte header (type, payload length, sequence number) followed by the raw
VISCA command. Preset recall is CAM_Memory Recall: 81 01 04 3F 02 <n> FF.

Called by /usr/local/bin/media (camera preset N). Prints KEY=VALUE lines and a
JSON result line. Exit 0 when the camera acknowledged the command.

Usage:
  obsbot_preset.py --ip 192.168.2.x --preset 1
"""

from __future__ import annotations

import argparse
import json
import socket
import struct
import sys
import time


def result(success: bool, message: str) -> None:
    print(json.dumps({"success": success, "partial_success": False,
                      "action": "camera-preset", "message": message}))


def encapsulate(payload: bytes, seq: int, msg_type: bytes = b"\x01\x00") -> bytes:
    return msg_type + struct.pack(">H", len(payload)) + struct.pack(">I", seq) + payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ip", required=True)
    parser.add_argument("--port", type=int, default=52381)
    parser.add_argument("--preset", type=int, required=True, help="VISCA memory number (0-254)")
    parser.add_argument("--timeout", type=float, default=2.0)
    args = parser.parse_args()

    if not 0 <= args.preset <= 254:
        result(False, "preset must be between 0 and 254")
        return 1

    recall = bytes([0x81, 0x01, 0x04, 0x3F, 0x02, args.preset & 0xFF, 0xFF])
    control_reset = b"\x02\x00\x00\x01\x00\x00\x00\x00\x01"  # reset sequence counter

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(args.timeout)
    try:
        sock.sendto(control_reset, (args.ip, args.port))
        time.sleep(0.1)
        sock.sendto(encapsulate(recall, 1), (args.ip, args.port))

        acked = False
        completed = False
        deadline = time.time() + args.timeout
        while time.time() < deadline:
            try:
                data, _ = sock.recvfrom(64)
            except socket.timeout:
                break
            body = data[8:] if len(data) > 8 else data
            print(f"CAMERA_REPLY={body.hex()}")
            if len(body) >= 2 and body[0] == 0x90:
                kind = body[1] >> 4
                if kind == 0x4:
                    acked = True
                elif kind == 0x5:
                    completed = True
                elif kind == 0x6:
                    result(False, f"camera returned a VISCA error for preset {args.preset}: {body.hex()}")
                    return 1
            if completed:
                break
    except OSError as e:
        result(False, f"could not send to {args.ip}:{args.port}: {e}")
        return 1
    finally:
        sock.close()

    print(f"CAMERA_PRESET={args.preset}")
    if acked or completed:
        result(True, f"camera moved to preset {args.preset}")
        return 0
    # No reply is not proof of failure (some firmwares stay silent), but flag it.
    print("CAMERA_ACK=none")
    result(True, f"preset {args.preset} sent; camera did not acknowledge (verify VISCA over IP is enabled)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
