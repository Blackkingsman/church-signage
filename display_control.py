#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

CONTROL_FILE = Path(__file__).with_name("control.json")
MODES = ("wall", "slides", "photo", "live")


def read_control():
    if not CONTROL_FILE.exists():
        return {"mode": "wall", "slideIndex": 0, "photoIndex": 0}

    with CONTROL_FILE.open("r", encoding="utf-8") as file:
        data = json.load(file)

    return {
        "mode": data.get("mode", "wall"),
        "slideIndex": int(data.get("slideIndex", 0)),
        "photoIndex": int(data.get("photoIndex", 0)),
    }


def write_control(data):
    with CONTROL_FILE.open("w", encoding="utf-8") as file:
        json.dump(data, file, indent=2)
        file.write("\n")


def main():
    parser = argparse.ArgumentParser(
        description="Change the live display SPA view by updating control.json."
    )
    parser.add_argument(
        "mode",
        nargs="?",
        choices=MODES,
        help="Display view to show: wall, slides, photo, or live.",
    )
    parser.add_argument(
        "--slide",
        type=int,
        help="Set the announcement slide index, starting at 0.",
    )
    parser.add_argument(
        "--photo",
        type=int,
        help="Set the photo slideshow index, starting at 0.",
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="Print the current display control state.",
    )

    args = parser.parse_args()
    control = read_control()

    if args.status:
        print(json.dumps(control, indent=2))
        return

    if args.mode:
        control["mode"] = args.mode
    if args.slide is not None:
        control["slideIndex"] = max(0, args.slide)
        if not args.mode:
            control["mode"] = "slides"
    if args.photo is not None:
        control["photoIndex"] = max(0, args.photo)
        if not args.mode:
            control["mode"] = "photo"

    write_control(control)
    print(
        f"Display set to {control['mode']} "
        f"(slide {control['slideIndex']}, photo {control['photoIndex']})."
    )


if __name__ == "__main__":
    main()
