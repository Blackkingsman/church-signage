#!/usr/bin/env bash
# Install / update the church VM media tooling from this repo.
#
#   /usr/local/bin/media              <- vm/media
#   /opt/awesomechurch-media/         <- obs_ctl.py, obsbot_preset.py + a venv
#
# Run on the VM after `git pull`:   sudo vm/install.sh
# Settings live in /etc/awesomechurch-media.env (see vm/README.md).

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="/opt/awesomechurch-media"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

mkdir -p "$TOOLS_DIR"
install -m 0755 "$DIR/obs_ctl.py" "$DIR/obsbot_preset.py" "$TOOLS_DIR/"

if [[ ! -x "$TOOLS_DIR/venv/bin/python3" ]]; then
  echo "Creating Python venv in $TOOLS_DIR/venv ..."
  python3 -m venv "$TOOLS_DIR/venv" || {
    echo "python3 -m venv failed. On Ubuntu/Debian: sudo apt install python3-venv" >&2
    exit 1
  }
fi
"$TOOLS_DIR/venv/bin/pip" install -q --upgrade websocket-client

bash -n "$DIR/media"
install -m 0755 "$DIR/media" /usr/local/bin/media

echo "Installed:"
echo "  /usr/local/bin/media            ($(media help 2>/dev/null | head -n 1))"
echo "  $TOOLS_DIR/obs_ctl.py, obsbot_preset.py"
echo
echo "Next: add the Mac Mini / OBS values to /etc/awesomechurch-media.env, then run: media stream status"
