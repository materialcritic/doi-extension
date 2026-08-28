#!/bin/bash
# ─────────────────────────────────────────────────────────
# DOI Grabber — Native Messaging Host installer (macOS/Linux)
# Run this AFTER loading the extension in Chrome and getting
# its Extension ID from chrome://extensions
# ─────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/doi_host.py"
MANIFEST_NAME="com.doi_grabber.host.json"

case "$(uname -s)" in
  Darwin)
    MANIFEST_DEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$MANIFEST_NAME"
    ;;
  Linux)
    MANIFEST_DEST="$HOME/.config/google-chrome/NativeMessagingHosts/$MANIFEST_NAME"
    ;;
  *)
    echo "Unrecognized OS ($(uname -s)) — this installer supports macOS and Linux only. For Windows, use install.ps1 instead."
    exit 1
    ;;
esac

# Make the host script executable
chmod +x "$HOST_SCRIPT"

# Prompt for the Extension ID. Chrome extension IDs are always exactly 32
# lowercase characters from a-p (they're derived from a SHA-256 hash mapped
# into that alphabet) -- validating the shape here catches a typo/paste
# mistake immediately, instead of producing a manifest Chrome will silently
# ignore and leaving the user staring at a generic "native host has exited"
# with nothing to go on. This has historically been the single most common
# support symptom for this project.
echo ""
echo "Open chrome://extensions, enable Developer Mode, load the extension,"
echo "and paste its Extension ID below."
echo ""
while true; do
  read -p "Extension ID: " EXT_ID
  if [ -z "$EXT_ID" ]; then
    echo "Error: Extension ID cannot be empty."
    continue
  fi
  if ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
    echo "That doesn't look like a Chrome extension ID (expected exactly 32 letters, a-p)."
    echo "Double-check chrome://extensions and paste it again."
    continue
  fi
  break
done

# Write the manifest with real paths and Extension ID. Generated via python3
# (already a hard dependency of this whole project) rather than a heredoc --
# a heredoc interpolates $HOST_SCRIPT/$EXT_ID as raw text with no escaping,
# so a path containing a `"` or `\` (rare, but real on some systems/setups)
# would produce invalid JSON that Chrome then silently rejects. json.dumps
# escapes correctly regardless of what's in the path.
mkdir -p "$(dirname "$MANIFEST_DEST")"
python3 -c '
import json, sys
host_script, ext_id, dest = sys.argv[1], sys.argv[2], sys.argv[3]
manifest = {
    "name": "com.doi_grabber.host",
    "description": "Native Messaging host for DOI Grabber",
    "path": host_script,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{ext_id}/"],
}
with open(dest, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
' "$HOST_SCRIPT" "$EXT_ID" "$MANIFEST_DEST"

# Native-messaging manifests can embed a path Chrome will happily execute
# on this account's behalf -- keep it readable/writable by this user only.
chmod 600 "$MANIFEST_DEST"

echo ""
echo "✓ Manifest written to: $MANIFEST_DEST"
echo ""
echo "Next: if scihub_download.py isn't sitting right next to doi_host.py, or you're"
echo "using a python3 without 'requests'/'beautifulsoup4' installed, set the Script"
echo "path / Python interpreter path fields in the extension's Settings page."
echo "Done! Fully restart Chrome (not just reload the extension) and try the popup."
