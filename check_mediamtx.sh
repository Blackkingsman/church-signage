#!/usr/bin/env bash
# Is the lobby TV's live-stream server (MediaMTX HLS) reachable from this box?
#
# The TV plays whatever `liveUrl` on Firestore appContent/signage points at;
# the bridge mirrors it into content.json as live.embedUrl. This script takes
# that URL's origin (scheme://host:port/) and asks it for any HTTP response.
# Before service OBS isn't streaming yet, so the playlist itself would 404;
# any 3-digit status means the server is up, which is all we need at 08:45.
#
# Output is machine-readable for the n8n "Automation Media" workflow:
#   MEDIAMTX_URL=<origin or empty>   MEDIAMTX_HTTP=<status or 000>
#   MEDIAMTX_RESULT=0|1
# followed by one JSON result line. Exit code 0 = reachable.
#
# Usage (on the VM):  ~/photowall/check_mediamtx.sh

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTENT="$ROOT_DIR/content.json"

origin="$(python3 - "$CONTENT" <<'EOF' 2>/dev/null
import json, sys
from urllib.parse import urlsplit
try:
    url = json.load(open(sys.argv[1])).get("live", {}).get("embedUrl", "") or ""
except Exception:
    url = ""
p = urlsplit(url)
print(f"{p.scheme}://{p.netloc}/" if p.scheme in ("http", "https") and p.netloc else "")
EOF
)"

http=000
result=1
if [[ -n "$origin" ]]; then
  http="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$origin" 2>/dev/null)"
  [[ "$http" =~ ^[1-5][0-9][0-9]$ ]] && result=0 || http=000
fi

echo "MEDIAMTX_URL=$origin"
echo "MEDIAMTX_HTTP=$http"
echo "MEDIAMTX_RESULT=$result"

if [[ -z "$origin" ]]; then
  printf '{"success":false,"action":"mediamtx-check","message":"No live stream URL is set on the signage (liveUrl is empty or not an http URL)"}\n'
elif [[ $result -eq 0 ]]; then
  printf '{"success":true,"action":"mediamtx-check","message":"Lobby stream server is reachable at %s (HTTP %s)"}\n' "$origin" "$http"
else
  printf '{"success":false,"action":"mediamtx-check","message":"Lobby stream server at %s is not responding"}\n' "$origin"
fi

exit $result
