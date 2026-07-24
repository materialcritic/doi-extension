#!/usr/bin/env python3
"""
Native Messaging Host for DOI Grabber Chrome extension.
Receives a DOI from the extension, runs it through your existing Python
script, and streams progress + a final result back to the extension.
"""

import csv
import os
import platform
import shutil
import sys
import json
import struct
import subprocess
import threading
import time
from datetime import datetime, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
IS_WINDOWS = platform.system() == "Windows"
IS_MACOS = platform.system() == "Darwin"

# ── CONFIGURE THIS ────────────────────────────────────────────────────────────
# Path to YOUR existing Python script that processes the DOI. Defaults to the
# copy shipped alongside this host; override via the extension's Settings
# page (Script path) instead of editing this if yours lives elsewhere.
YOUR_SCRIPT = os.path.join(SCRIPT_DIR, "scihub_download.py")
def find_python_with_requests():
    """Chrome's spawn PATH often differs from a Terminal shell's — on macOS in
    particular, the first python3 on PATH is frequently Apple's system one
    (no pip packages), while a Homebrew/pyenv install with `requests`/`bs4`
    sits elsewhere on PATH or isn't on Chrome's PATH at all. Rather than just
    taking shutil.which()'s first match and letting the script crash with
    ModuleNotFoundError, actually test each candidate and prefer one that has
    the packages scihub_download.py needs. Falls back to the plain
    first-found interpreter (or sys.executable) if none qualify, so the
    error message a user sees is still the familiar, actionable one — and
    Settings' Python interpreter path always overrides this entirely."""
    candidates = []
    for name in ("python3", "python"):
        found = shutil.which(name)
        if found:
            candidates.append(found)
    # Common install locations that may not be on Chrome's (narrower) PATH
    # even though they are on a Terminal shell's.
    candidates += [
        "/opt/homebrew/bin/python3",       # Homebrew, Apple Silicon
        "/usr/local/bin/python3",          # Homebrew, Intel
        os.path.expanduser("~/.pyenv/shims/python3"),
    ]

    if IS_WINDOWS:
        # Windows rarely has a "python3" on PATH at all (that name is a
        # macOS/Linux convention); the `py` launcher is the standard way to
        # find whatever real interpreter(s) are installed, and it's usually
        # on PATH even when "python" isn't. `py -3 -c ...` runs the default
        # Python 3 the launcher knows about.
        py_launcher = shutil.which("py")
        if py_launcher:
            candidates.append([py_launcher, "-3"])
        # Common install locations Chrome's narrower spawn PATH may miss —
        # python.org's per-user installer and the Microsoft Store package
        # both land under one of these, versioned, so glob for any 3.x.
        import glob
        for pattern in (
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\Python\Python3*\python.exe"),
            os.path.expandvars(r"%ProgramFiles%\Python3*\python.exe"),
            os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe"),
        ):
            candidates += glob.glob(pattern)

    seen = set()
    for candidate in candidates:
        # Most candidates are a single executable path; the `py` launcher
        # entry above is [path, "-3"] since it needs that extra arg to pick
        # a specific interpreter rather than launching the bare launcher.
        if isinstance(candidate, list):
            exe, extra_args = candidate[0], candidate[1:]
        else:
            exe, extra_args = candidate, []
        key = tuple(candidate) if isinstance(candidate, list) else candidate
        if not exe or key in seen or not os.path.isfile(exe):
            continue
        seen.add(key)
        try:
            result = subprocess.run(
                [exe] + extra_args + ["-c", "import requests, bs4"],
                capture_output=True, timeout=5,
            )
            if result.returncode == 0:
                return [exe] + extra_args if extra_args else exe
        except (OSError, subprocess.SubprocessError):
            continue

    return shutil.which("python3") or shutil.which("python") or sys.executable


# Chrome launches this host with its own python3/python, which may lack
# packages your script needs (e.g. requests). Override via Settings (Python
# interpreter path) if the auto-detected one below doesn't have them.
PYTHON_BIN = find_python_with_requests()
# Kept in sync with scihub_download.py's own constants — this host reads the
# same file, it doesn't own it.
MIRROR_HEALTH_PATH = os.path.join(SCRIPT_DIR, "mirror_health.json")
MIRROR_FAIL_THRESHOLD = 3
MIRROR_COOLDOWN_MINUTES = 10
MIRROR_HEALTH_MAX_AGE_DAYS = 4
DOWNLOAD_LOG_PATH = os.path.join(SCRIPT_DIR, "download_log.txt")
# Self-update reads/pulls the git repo this host lives in (native-host/ is a
# subfolder of the repo root, e.g. a clone of github.com/materialcritic/doi-extension).
REPO_DIR = os.path.dirname(SCRIPT_DIR)
# ─────────────────────────────────────────────────────────────────────────────


def open_in_file_manager(path):
    """Open path's containing folder in Finder/Explorer/the default file
    manager, selecting it where the platform supports that."""
    if IS_MACOS:
        subprocess.run(["open", path], check=True)
    elif IS_WINDOWS:
        # explorer.exe routinely returns a non-zero exit code even on
        # success, so don't check=True here.
        subprocess.run(["explorer", path])
    else:
        subprocess.run(["xdg-open", os.path.dirname(path) if os.path.isfile(path) else path], check=True)


def reveal_in_file_manager(path):
    """Open path's containing folder with path itself selected, where the
    platform supports that (macOS/Windows); falls back to just opening the
    containing folder on Linux, since there's no single standard way to
    select a file across Linux file managers."""
    if IS_MACOS:
        subprocess.run(["open", "-R", path], check=True)
    elif IS_WINDOWS:
        subprocess.run(["explorer", "/select,", path])
    else:
        subprocess.run(["xdg-open", os.path.dirname(path)], check=True)


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

    if message.get("action") == "default_output_dir":
        # The extension pages can't know the user's home dir; they ask here so
        # the "leave output folder blank" default resolves to a real path
        # instead of a hardcoded one. Kept in sync with scihub_download.py's
        # own argparse default (Path.home() / 'Downloads' / 'autorename') —
        # if you change one, change both.
        default_dir = os.path.join(os.path.expanduser("~"), "Downloads", "autorename")
        send_message({"type": "result", "status": "ok", "path": default_dir})
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

    if message.get("action") == "import_data":
        # Restores the two files this host owns the paths for, from a
        # previously-exported backup zip (Settings' "Import Backup"). Fully
        # overwrites rather than merges — a restore is expected to replace
        # current state, not interleave with it. Writes via a temp file +
        # os.replace (atomic on POSIX and Windows) so a concurrent reader
        # (e.g. a download in progress) never sees a half-written file,
        # same pattern scihub_download.py uses for mirror_health.json.
        download_log = message.get("download_log")
        mirror_health = message.get("mirror_health")
        try:
            if download_log is not None:
                tmp_path = DOWNLOAD_LOG_PATH + ".tmp"
                with open(tmp_path, "w") as f:
                    f.write(download_log)
                os.replace(tmp_path, DOWNLOAD_LOG_PATH)

            if mirror_health is not None:
                tmp_path = MIRROR_HEALTH_PATH + ".tmp"
                with open(tmp_path, "w") as f:
                    f.write(mirror_health)
                os.replace(tmp_path, MIRROR_HEALTH_PATH)

            send_message({"type": "result", "status": "ok"})
        except Exception as e:
            send_message({"type": "result", "status": "error", "detail": str(e)})
        return

    if message.get("action") == "check_for_update":
        # Settings' "Updates" card — reports how far the local checkout is
        # behind origin, plus the commit subjects that would land, without
        # changing anything on disk (git fetch only touches remote-tracking refs).
        try:
            subprocess.run(
                ["git", "fetch", "--quiet", "origin"],
                cwd=REPO_DIR, check=True, capture_output=True, text=True, timeout=30,
            )
            branch = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=REPO_DIR, check=True, capture_output=True, text=True,
            ).stdout.strip()
            log = subprocess.run(
                ["git", "log", "--oneline", f"HEAD..origin/{branch}"],
                cwd=REPO_DIR, check=True, capture_output=True, text=True,
            ).stdout.strip()
            commits = [line.split(" ", 1)[1] for line in log.splitlines() if line]
            local_sha = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=REPO_DIR, check=True, capture_output=True, text=True,
            ).stdout.strip()
            send_message({
                "type": "result", "status": "ok",
                "behind_by": len(commits),
                "commits": commits,
                "local_sha": local_sha,
            })
        except subprocess.CalledProcessError as e:
            send_message({"type": "result", "status": "error", "detail": (e.stderr or str(e)).strip()})
        except Exception as e:
            send_message({"type": "result", "status": "error", "detail": str(e)})
        return

    if message.get("action") == "apply_update":
        # Fast-forward pull only — this host is running out of REPO_DIR right
        # now, so a merge/rebase mid-flight could leave a half-updated
        # process behind; a clean fast-forward is the safe case and the only
        # one Settings' "Update Now" button offers.
        try:
            status = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=REPO_DIR, check=True, capture_output=True, text=True,
            ).stdout.strip()
            # `git status --porcelain` also lists untracked files ("?? ..."),
            # which is unrelated to whether a fast-forward pull is safe — a
            # stray file (editor cruft, a __pycache__ dir, a leftover backup
            # zip that predates the .gitignore entry, etc.) shouldn't block
            # updates the way an actual edit to a tracked file should.
            blocking_lines = [
                line for line in status.splitlines() if not line.startswith("??")
            ]
            if blocking_lines:
                send_message({
                    "type": "result", "status": "error",
                    "detail": "Local changes exist in the repo checkout — resolve or stash them before updating.",
                })
                return

            pull = subprocess.run(
                ["git", "pull", "--ff-only"],
                cwd=REPO_DIR, check=True, capture_output=True, text=True, timeout=60,
            )
            native_host_changed = "native-host/" in pull.stdout
            send_message({
                "type": "result", "status": "ok",
                "output": pull.stdout.strip(),
                "native_host_changed": native_host_changed,
            })
        except subprocess.CalledProcessError as e:
            send_message({"type": "result", "status": "error", "detail": (e.stderr or str(e)).strip()})
        except Exception as e:
            send_message({"type": "result", "status": "error", "detail": str(e)})
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
            open_in_file_manager(folder)
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
            reveal_in_file_manager(target)
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
    unpaywall_email = settings.get("unpaywallEmail")

    # python_bin is normally a single executable path, but on Windows it can
    # be [py_launcher_path, "-3"] when that's what find_python_with_requests()
    # settled on (see its docstring) — flatten either shape into argv.
    python_bin_args = python_bin if isinstance(python_bin, list) else [python_bin]
    cmd = python_bin_args + [script_path, doi]
    if output_dir:
        cmd += ["-d", output_dir]
    if mirrors:
        cmd += ["-m", ",".join(mirrors)]
    if unpaywall_email:
        cmd += ["--email", unpaywall_email]
    if message.get("action") == "check":
        cmd += ["--check"]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8', errors='replace',
            bufsize=1,
        )

        # Absolute ceiling: kills the child even if it hangs with stdout open
        # (the read loop below otherwise blocks forever and proc.wait() below
        # is never reached). Set well above the script's own retry budget —
        # get_pdf_url alone can legitimately run ~70s (4 retries, ~15s mirror
        # races apart) before Unpaywall/publisher/download tiers even start —
        # so this only ever catches a true hang, not slow-but-progressing work.
        HARD_TIMEOUT_SECONDS = 180
        watchdog = threading.Timer(HARD_TIMEOUT_SECONDS, proc.kill)
        watchdog.start()
        try:
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
        finally:
            watchdog.cancel()

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
