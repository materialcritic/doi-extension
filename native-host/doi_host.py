#!/usr/bin/env python3
"""
Native Messaging Host for DOI Grabber Chrome extension.
Receives a DOI from the extension and passes it to your existing Python script.
"""

import sys
import json
import struct
import subprocess
import os

# ── CONFIGURE THIS ────────────────────────────────────────────────────────────
# Path to YOUR existing Python script that processes the DOI
YOUR_SCRIPT = "/Users/floppa/bin/scihub_download.py"
# ─────────────────────────────────────────────────────────────────────────────


def read_message():
    """Read a Native Messaging message from stdin."""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    message_length = struct.unpack("=I", raw_length)[0]
    raw_message = sys.stdin.buffer.read(message_length)
    return json.loads(raw_message.decode("utf-8"))


def send_message(data):
    """Send a Native Messaging message to stdout."""
    encoded = json.dumps(data).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main():
    message = read_message()
    if not message or "doi" not in message:
        send_message({"status": "error", "detail": "No DOI received"})
        return

    doi = message["doi"]

    try:
        result = subprocess.run(
            [sys.executable, YOUR_SCRIPT, doi],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode == 0:
            send_message({"status": "ok", "output": result.stdout.strip()})
        else:
            send_message({"status": "error", "detail": result.stderr.strip()})
    except FileNotFoundError:
        send_message({"status": "error", "detail": f"Script not found: {YOUR_SCRIPT}"})
    except subprocess.TimeoutExpired:
        send_message({"status": "error", "detail": "Script timed out after 60s"})
    except Exception as e:
        send_message({"status": "error", "detail": str(e)})


if __name__ == "__main__":
    main()
