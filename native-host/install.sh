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

# Prompt for the Extension ID
echo ""
echo "Open chrome://extensions, enable Developer Mode, load the extension,"
echo "and paste its Extension ID below."
echo ""
read -p "Extension ID: " EXT_ID

if [ -z "$EXT_ID" ]; then
  echo "Error: Extension ID cannot be empty."
  exit 1
fi

# Write the manifest with real paths and Extension ID
mkdir -p "$(dirname "$MANIFEST_DEST")"
cat > "$MANIFEST_DEST" <<EOF
{
  "name": "com.doi_grabber.host",
  "description": "Native Messaging host for DOI Grabber",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

echo ""
echo "✓ Manifest written to: $MANIFEST_DEST"
echo ""
echo "Next: if scihub_download.py isn't sitting right next to doi_host.py, or you're"
echo "using a python3 without 'requests'/'beautifulsoup4' installed, set the Script"
echo "path / Python interpreter path fields in the extension's Settings page."
echo "Done! Fully restart Chrome (not just reload the extension) and try the popup."
