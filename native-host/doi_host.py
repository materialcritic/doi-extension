#!/usr/bin/env python3
"""
Native Messaging Host for DOI Grabber Chrome extension.
Receives a DOI from the extension, runs it through your existing Python
script, and streams progress + a final result back to the extension.
"""

import csv
import os
import sys
import json
import struct
import subprocess
import time
from datetime import datetime, timedelta

# ── CONFIGURE THIS ────────────────────────────────────────────────────────────
# Path to YOUR existing Python script that processes the DOI
YOUR_SCRIPT = "/Users/floppa/bin/scihub_download.py"
# Chrome launches this host with its own python3, which may lack packages
# your script needs (e.g. requests). Use the interpreter that has them.
PYTHON_BIN = "/opt/homebrew/bin/python3"
# Kept in sync with scihub_download.py's own constants — this host reads the
# same file, it doesn't own it.
MIRROR_HEALTH_PATH = "/Users/floppa/doi-extension/native-host/mirror_health.json"
MIRROR_FAIL_THRESHOLD = 3
MIRROR_COOLDOWN_MINUTES = 10
MIRROR_HEALTH_MAX_AGE_DAYS = 4
DOWNLOAD_LOG_PATH = "/Users/floppa/doi-extension/native-host/download_log.txt"
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


def find_renamed_file(filepath):
    """Look up a rename for filepath via rename_log.csv, if one has happened.

    Reads the CSV by its known path rather than listing the directory —
    listing a Downloads subfolder hits macOS's TCC privacy protection even
    when reading a known file by path does not.
    """
    folder = os.path.dirname(filepath)
    basename = os.path.basename(filepath)
    log_path = os.path.join(folder, "rename_log.csv")
    new_name = None
    try:
        with open(log_path, newline="") as f:
            for row in csv.DictReader(f):
                if row.get("old_name") == basename:
                    new_name = row.get("new_name")
    except (FileNotFoundError, OSError):
        return None

    if new_name and os.path.exists(os.path.join(folder, new_name)):
        return os.path.join(folder, new_name)
    return None


def resolve_reveal_target(filepath, attempts=40, delay=0.5):
    """Find the file to reveal, tolerating a race with the autorename Folder
    Action (~/Scripts/auto_rename_by_doi.py). It's triggered by macOS Folder
    Actions (not a continuously-running watcher) and does a live Crossref API
    lookup per file (timeout=15s), so the rename + rename_log.csv write can
    legitimately take up to ~15-20s after the download finishes — the default
    here polls for up to 20s to comfortably cover that."""
    for i in range(attempts):
        if os.path.exists(filepath):
            return filepath
        renamed = find_renamed_file(filepath)
        if renamed:
            return renamed
        if i < attempts - 1:
            time.sleep(delay)
    raise FileNotFoundError(f"File not found and no rename_log.csv match: {filepath}")


def main():
    message = read_message()
    if not message:
        send_message({"type": "result", "status": "error", "detail": "No message received"})
        return

    if message.get("action") == "mirror_health":
        try:
            with open(MIRROR_HEALTH_PATH) as f:
                health = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            health = {}

        now = datetime.now()
        stale_cutoff = now - timedelta(days=MIRROR_HEALTH_MAX_AGE_DAYS)
        mirrors = []
        for url, entry in health.items():
            last_seen = entry.get("last_seen")
            if last_seen:
                try:
                    if datetime.fromisoformat(last_seen) < stale_cutoff:
                        continue
                except ValueError:
                    pass
            fail_count = entry.get("fail_count", 0)
            last_failed = entry.get("last_failed")
            cooling_down = False
            cooldown_remaining_min = 0
            if fail_count >= MIRROR_FAIL_THRESHOLD and last_failed:
                last_failed_dt = datetime.fromisoformat(last_failed)
                elapsed = now - last_failed_dt
                remaining = timedelta(minutes=MIRROR_COOLDOWN_MINUTES) - elapsed
                if remaining.total_seconds() > 0:
                    cooling_down = True
                    cooldown_remaining_min = round(remaining.total_seconds() / 60)
            mirrors.append({
                "url": url,
                "fail_count": fail_count,
                "last_failed": last_failed,
                "cooling_down": cooling_down,
                "cooldown_remaining_min": cooldown_remaining_min,
                "last_latency_ms": entry.get("last_latency_ms"),
                "latency_history": entry.get("latency_history", []),
            })

        send_message({"type": "result", "status": "ok", "mirrors": mirrors})
        return

    if message.get("action") == "reset_mirror_health":
        url = message.get("url")
        try:
            with open(MIRROR_HEALTH_PATH) as f:
                health = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            health = {}

        if url:
            health.pop(url, None)
        else:
            health = {}

        with open(MIRROR_HEALTH_PATH, "w") as f:
            json.dump(health, f, indent=2)

        send_message({"type": "result", "status": "ok"})
        return

    if message.get("action") == "export_data":
        # Feeds Settings' "Export Everything" backup zip — the raw text of
        # both files this host owns the paths for, so the extension doesn't
        # need to know/hardcode these paths itself.
        try:
            with open(DOWNLOAD_LOG_PATH) as f:
                download_log = f.read()
        except FileNotFoundError:
            download_log = ""

        try:
            with open(MIRROR_HEALTH_PATH) as f:
                mirror_health = f.read()
        except FileNotFoundError:
            mirror_health = "{}"

        send_message({
            "type": "result",
            "status": "ok",
            "download_log": download_log,
            "mirror_health": mirror_health,
        })
        return

    if message.get("action") == "recent_downloads":
        # Most-recent-first, deduped by DOI (a re-download after a corrupt
        # file overwrites its earlier spot rather than appearing twice) —
        # feeds "Paper of the Day" in Settings.
        limit = message.get("limit", 100)
        seen = set()
        recent = []
        try:
            with open(DOWNLOAD_LOG_PATH) as f:
                lines = f.readlines()
        except FileNotFoundError:
            lines = []

        for line in reversed(lines):
            parts = line.rstrip("\n").split(" | ")
            if len(parts) < 3 or parts[1] != "SUCCESS":
                continue
            timestamp, doi = parts[0], parts[2]
            if doi in seen:
                continue
            seen.add(doi)
            recent.append({"doi": doi, "timestamp": timestamp})
            if len(recent) >= limit:
                break

        send_message({"type": "result", "status": "ok", "downloads": recent})
        return

    if message.get("action") == "download_stats":
        now = datetime.now()
        windows = {
            "last_7_weeks": timedelta(weeks=7),
            "last_7_months": timedelta(days=30 * 7),
            "last_year": timedelta(days=365),
        }
        counts = {"total": 0, "last_7_weeks": 0, "last_7_months": 0, "last_year": 0}

        try:
            with open(DOWNLOAD_LOG_PATH) as f:
                for line in f:
                    parts = line.rstrip("\n").split(" | ")
                    if len(parts) < 2 or parts[1] != "SUCCESS":
                        continue
                    try:
                        ts = datetime.strptime(parts[0], "%Y-%m-%d %H:%M:%S")
                    except ValueError:
                        continue
                    counts["total"] += 1
                    for key, window in windows.items():
                        if now - ts <= window:
                            counts[key] += 1
        except FileNotFoundError:
            pass

        send_message({"type": "result", "status": "ok", "counts": counts})
        return

    if message.get("action") == "read_log":
        filepath = message.get("filepath")
        try:
            with open(filepath) as f:
                content = f.read()
            send_message({"type": "result", "status": "ok", "content": content})
        except FileNotFoundError:
            send_message({"type": "result", "status": "ok", "content": ""})
        except Exception as e:
            send_message({"type": "result", "status": "error", "detail": str(e)})
        return

    if message.get("action") == "open_folder":
        folder = message.get("folder")
        try:
            os.makedirs(folder, exist_ok=True)
            subprocess.run(["open", folder], check=True)
            send_message({"type": "result", "status": "ok"})
        except Exception as e:
            send_message({"type": "result", "status": "error", "detail": str(e)})
        return

    if message.get("action") == "append_log":
        filepath = message.get("filepath")
        line = message.get("line", "")
        try:
            os.makedirs(os.path.dirname(filepath), exist_ok=True)
            with open(filepath, "a") as f:
                f.write(line + "\n")
            send_message({"type": "result", "status": "ok"})
        except Exception as e:
            send_message({"type": "result", "status": "error", "detail": str(e)})
        return

    if message.get("action") == "delete_file":
        filepath = message.get("filepath")
        try:
            os.remove(filepath)
            send_message({"type": "result", "status": "ok"})
        except Exception as e:
            send_message({"type": "result", "status": "error", "detail": str(e)})
        return

    if message.get("action") == "reveal":
        filepath = message.get("filepath")
        try:
            target = resolve_reveal_target(filepath)
            subprocess.run(["open", "-R", target], check=True)
            send_message({"type": "result", "status": "ok"})
        except Exception as e:
            send_message({"type": "result", "status": "error", "detail": str(e)})
        return

    if "doi" not in message:
        send_message({"type": "result", "status": "error", "detail": "No DOI received"})
        return

    doi = message["doi"]
    settings = message.get("settings") or {}

    python_bin = settings.get("pythonBin") or PYTHON_BIN
    script_path = settings.get("scriptPath") or YOUR_SCRIPT
    output_dir = settings.get("outputDir")
    mirrors = settings.get("mirrors")

    cmd = [python_bin, script_path, doi]
    if output_dir:
        cmd += ["-d", output_dir]
    if mirrors:
        cmd += ["-m", ",".join(mirrors)]
    if message.get("action") == "check":
        cmd += ["--check"]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

        result = None
        for line in proc.stdout:
            line = line.rstrip("\n")
            if not line:
                continue
            if line.startswith("RESULT:"):
                try:
                    result = json.loads(line[len("RESULT:"):])
                except json.JSONDecodeError:
                    pass
            else:
                send_message({"type": "progress", "line": line})

        stderr_output = proc.stderr.read()
        proc.wait(timeout=90)

        if result is not None:
            send_message({"type": "result", **result})
        elif proc.returncode == 0:
            send_message({"type": "result", "status": "ok", "detail": "Completed"})
        else:
            send_message({"type": "result", "status": "error", "detail": stderr_output.strip() or "Script exited with an error"})

    except subprocess.TimeoutExpired:
        send_message({"type": "result", "status": "error", "detail": "Script timed out"})
    except FileNotFoundError:
        send_message({"type": "result", "status": "error", "detail": f"Script not found: {script_path}"})
    except Exception as e:
        send_message({"type": "result", "status": "error", "detail": str(e)})


if __name__ == "__main__":
    main()
