#!/bin/bash
# ─────────────────────────────────────────────────────────
# DOI Grabber — Native Messaging Host installer (macOS)
# Run this AFTER loading the extension in Chrome and getting
# its Extension ID from chrome://extensions
# ─────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/doi_host.py"
MANIFEST_NAME="com.doi_grabber.host.json"
MANIFEST_DEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$MANIFEST_NAME"

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
echo "Next: edit doi_host.py and set YOUR_SCRIPT to the path of your Python script."
echo "Done! Reload the extension in Chrome and try the popup."
