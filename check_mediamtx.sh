#!/usr/bin/env bash
# Is the lobby TV's live-stream server (MediaMTX HLS) reachable from this box?
#
# Which server to probe:
#   1. MEDIAMTX_URL in /etc/awesomechurch-media.env (e.g. http://<mediamtx-host>:8888/),
#      the real lobby stream server; or, when that is not set,
#   2. the origin of whatever `liveUrl` on Firestore appContent/signage points at
#      (the bridge mirrors it into content.json as live.embedUrl).
#
# The signage URL is also inspected on its own: if it points at a public site
# (YouTube etc.) instead of a LAN host, the TV is not playing the local stream,
# and MEDIAMTX_SIGNAGE_LOCAL=false lets the Sunday report warn about it.
#
# Before service OBS isn't streaming yet, so the playlist itself would 404;
# any 3-digit status means the server is up, which is all we need at 08:45.
#
# Output is machine-readable for the n8n "Automation Media" workflow:
#   MEDIAMTX_URL=<origin probed or empty>   MEDIAMTX_SOURCE=env|signage|none
#   MEDIAMTX_HTTP=<status or 000>           MEDIAMTX_RESULT=0|1
#   MEDIAMTX_SIGNAGE_URL=<origin of the TV's live URL or empty>
#   MEDIAMTX_SIGNAGE_LOCAL=true|false|unknown
# followed by one JSON result line. Exit code 0 = reachable.
#
# Usage (on the VM):  ~/photowall/check_mediamtx.sh

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTENT="$ROOT_DIR/content.json"
CONFIG_FILE="${CONFIG_FILE:-/etc/awesomechurch-media.env}"

env_url=""
if [[ -r "$CONFIG_FILE" ]]; then
  env_url="$(grep -E '^MEDIAMTX_URL=' "$CONFIG_FILE" | tail -n 1 | cut -d= -f2- | tr -d '"'"'" | tr -d '[:space:]')"
fi

# Prints: <signage origin>|<signage local true/false/unknown>|<env origin>
parsed="$(python3 - "$CONTENT" "$env_url" <<'EOF' 2>/dev/null
import ipaddress, json, sys
from urllib.parse import urlsplit

def origin(url):
    p = urlsplit(url or "")
    return f"{p.scheme}://{p.netloc}/" if p.scheme in ("http", "https") and p.netloc else ""

def is_local(url):
    host = urlsplit(url or "").hostname or ""
    if not host:
        return "unknown"
    if host == "localhost" or host.endswith(".local") or host.endswith(".lan"):
        return "true"
    try:
        ip = ipaddress.ip_address(host)
        return "true" if (ip.is_private or ip.is_loopback or ip.is_link_local) else "false"
    except ValueError:
        return "false"

try:
    live = json.load(open(sys.argv[1])).get("live", {}).get("embedUrl", "") or ""
except Exception:
    live = ""
print(f"{origin(live)}|{is_local(live) if live else 'unknown'}|{origin(sys.argv[2])}")
EOF
)"

signage_origin="${parsed%%|*}"
rest="${parsed#*|}"
signage_local="${rest%%|*}"
env_origin="${rest#*|}"

origin="$signage_origin"
source_name="signage"
if [[ -n "$env_origin" ]]; then
  origin="$env_origin"
  source_name="env"
fi
[[ -z "$origin" ]] && source_name="none"

http=000
result=1
if [[ -n "$origin" ]]; then
  http="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$origin" 2>/dev/null)"
  [[ "$http" =~ ^[1-5][0-9][0-9]$ ]] && result=0 || http=000
fi

echo "MEDIAMTX_URL=$origin"
echo "MEDIAMTX_SOURCE=$source_name"
echo "MEDIAMTX_HTTP=$http"
echo "MEDIAMTX_RESULT=$result"
echo "MEDIAMTX_SIGNAGE_URL=$signage_origin"
echo "MEDIAMTX_SIGNAGE_LOCAL=$signage_local"

note=""
if [[ "$signage_local" == "false" ]]; then
  note=" NOTE: the TV's live URL points at ${signage_origin}, not the local stream server."
fi

if [[ -z "$origin" ]]; then
  printf '{"success":false,"action":"mediamtx-check","message":"No stream server to check: set MEDIAMTX_URL in %s or liveUrl on the signage"}\n' "$CONFIG_FILE"
elif [[ $result -eq 0 ]]; then
  printf '{"success":true,"action":"mediamtx-check","message":"Lobby stream server is reachable at %s (HTTP %s).%s"}\n' "$origin" "$http" "$note"
else
  printf '{"success":false,"action":"mediamtx-check","message":"Lobby stream server at %s is not responding.%s"}\n' "$origin" "$note"
fi

exit $result
