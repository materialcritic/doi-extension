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
import traceback
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

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
        # on PATH even when "python" isn't (python.org's installer only adds
        # python.exe to PATH if the user opts in — the `py` launcher gets
        # registered either way). Resolve it to the concrete interpreter
        # path it would launch, rather than keeping "py -3" as a two-token
        # command: spawning through the launcher makes it a wrapper process
        # with the real pythonX.Y.exe as its *child*. That matters later —
        # the hard-timeout watchdog kills the direct Popen child on a hang,
        # and killing just the launcher leaves the interpreter underneath it
        # running and still holding this host's stdout pipe open, so the
        # read loop never sees EOF and the whole extension hangs "checking"
        # forever instead of reporting a timeout. Resolving up front avoids
        # the indirection (and that failure mode) entirely.
        py_launcher = shutil.which("py")
        if py_launcher:
            try:
                resolved = subprocess.run(
                    [py_launcher, "-3", "-c", "import sys; print(sys.executable)"],
                    capture_output=True, text=True, timeout=5,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                if resolved.returncode == 0 and resolved.stdout.strip():
                    candidates.append(resolved.stdout.strip())
            except (OSError, subprocess.SubprocessError):
                pass
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
            # Every one of these test-import calls (and the py-launcher
            # resolve above) runs fresh on EVERY single check/download --
            # find_python_with_requests() has no cache, and each request is
            # a brand-new doi_host.py process per the native-messaging
            # architecture. Without CREATE_NO_WINDOW here too, this would
            # flash a console window on Windows just as often as the actual
            # download spawn already got fixed to avoid.
            run_kwargs = {"capture_output": True, "timeout": 5}
            if IS_WINDOWS:
                run_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
            result = subprocess.run([exe] + extra_args + ["-c", "import requests, bs4"], **run_kwargs)
            if result.returncode == 0:
                return [exe] + extra_args if extra_args else exe
        except (OSError, subprocess.SubprocessError):
            continue

    return shutil.which("python3") or shutil.which("python") or sys.executable


# Chrome launches this host with its own python3/python, which may lack
# packages your script needs (e.g. requests). Override via Settings (Python
# interpreter path) if the auto-detected one below doesn't have them.
#
# find_python_with_requests() itself is NOT called here at module scope
# any more. Native messaging spawns a brand-new doi_host.py process per
# request, so a bare module-level call ran the full candidate-probing loop
# (up to ~8 interpreters, each spawned just to test-import requests/bs4,
# plus a `py -3` resolve on Windows) on EVERY single request -- including
# actions like mirror_health/recent_downloads/download_stats/get_debug_log
# that never spawn Python at all. On a badge check (i.e. every academic
# page opened), that's tens of process spawns and real, avoidable latency
# before the actual work even starts. get_python_bin() below makes this
# both lazy (only actually called from the two dispatch sites that spawn
# scihub_download.py) and cached across process invocations, via a small
# JSON file next to this script -- an in-memory-only cache would do
# nothing here, since there's no long-lived process to hold it in.
PYTHON_CACHE_PATH = os.path.join(SCRIPT_DIR, "python_cache.json")
PYTHON_CACHE_MAX_AGE_DAYS = 7
_python_bin_memo = None  # per-process memo; only matters if get_python_bin()
                          # were ever called twice in one invocation, which
                          # doesn't currently happen, but costs nothing to have.


def _load_cached_python_bin():
    """Returns the cached interpreter (str or [path, "-3"]) if the cache
    file exists, isn't stale, and the cached path still points at a real
    file on disk -- otherwise None, meaning the caller should re-probe.
    Never raises: a corrupt or missing cache just means "re-probe", the
    same outcome as no caching existing at all."""
    try:
        with open(PYTHON_CACHE_PATH, encoding="utf-8") as f:
            cache = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    value = cache.get("python_bin")
    cached_at = cache.get("cached_at")
    if not value or not cached_at:
        return None
    try:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(cached_at)
    except ValueError:
        return None
    if age > timedelta(days=PYTHON_CACHE_MAX_AGE_DAYS):
        return None
    exe = value[0] if isinstance(value, list) else value
    if not exe or not os.path.isfile(exe):
        return None
    return value


def _save_cached_python_bin(value):
    """Best-effort write of the resolved interpreter to the cache file.
    Never raises -- caching is purely an optimization; failing to persist
    it should never be the reason a request fails, it just means the next
    request re-probes instead of reading the cache."""
    try:
        tmp_path = PYTHON_CACHE_PATH + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump({"python_bin": value, "cached_at": datetime.now(timezone.utc).isoformat()}, f)
        os.replace(tmp_path, PYTHON_CACHE_PATH)
    except OSError:
        pass


def get_python_bin():
    """Resolves the auto-detected Python interpreter, reading from
    PYTHON_CACHE_PATH when there's a fresh, still-valid entry rather than
    re-running the full candidate probe on every request. Re-probes (and
    refreshes the cache) if the cache is missing, stale (>7 days), or the
    cached path no longer exists -- e.g. after a Python upgrade moved the
    interpreter to a new versioned path."""
    global _python_bin_memo
    if _python_bin_memo is not None:
        return _python_bin_memo
    cached = _load_cached_python_bin()
    if cached is not None:
        _python_bin_memo = cached
        return cached
    resolved = find_python_with_requests()
    _save_cached_python_bin(resolved)
    _python_bin_memo = resolved
    return resolved


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

# Self-update's actual authentication is "does origin point where we expect"
# -- check_for_update/apply_update run `git fetch`/`git pull --ff-only` in
# REPO_DIR with no other verification of where that traffic goes.
# --ff-only prevents a merge conflict from corrupting the checkout, but it
# doesn't authenticate anything: whatever origin points at just becomes code
# this host runs on the next Chrome restart. Anything able to rewrite
# .git/config on this machine (another process, a synced folder, a stray
# script) would otherwise silently redirect the update channel.
EXPECTED_ORIGIN_PATTERN = r"^(https://github\.com/materialcritic/doi-extension(\.git)?|git@github\.com:materialcritic/doi-extension\.git)$"

# Prevents a `git fetch`/`git pull` from ever blocking on an interactive
# credential prompt -- there's a timeout on both calls already, but failing
# immediately with a clear git error is better than hanging for up to a
# minute first. This repo is public, so a correctly-configured checkout
# never needs to authenticate at all; if git ever tries to, something's
# already unexpected about the remote.
_GIT_NO_PROMPT_ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}


def _verify_origin_remote():
    """Raises RuntimeError if REPO_DIR's `origin` remote doesn't point at
    this project's real GitHub repo. Call before any fetch/pull in
    check_for_update/apply_update."""
    import re
    result = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        cwd=REPO_DIR, capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Couldn't read the 'origin' remote: {(result.stderr or '').strip() or 'no origin configured'}")
    url = result.stdout.strip()
    if not re.match(EXPECTED_ORIGIN_PATTERN, url):
        raise RuntimeError(
            f"Refusing to update: 'origin' points at an unexpected repo ({url}), "
            "not github.com/materialcritic/doi-extension. If you deliberately forked this "
            "project, self-update isn't meant for that checkout -- update manually with git."
        )

# Diagnostic log for this process — every request this host handles, plus any
# uncaught exception (which would otherwise just crash silently with nothing
# useful for a user to report; see the try/except around main() at the bottom
# of this file). Read back by the extension's "Export Log" feature
# (background.js's getExtensionLog action bundles this in alongside its own
# chrome.storage.local-based log) via the get_debug_log action below.
DEBUG_LOG_PATH = os.path.join(SCRIPT_DIR, "debug_log.txt")
# Trim once the file crosses this size. Was 2 MB, which sat well above
# Chrome's native-messaging 1 MB per-message ceiling -- get_debug_log sends
# the whole file in a single message, so a log allowed to grow anywhere
# near 2 MB could get silently dropped by Chrome (connection torn down, no
# error) right when a user is exporting it because something's already
# wrong. 512 KB leaves comfortable headroom under the 1 MB limit even
# before send_message()'s own size guard (belt and suspenders) kicks in.
DEBUG_LOG_MAX_BYTES = 512 * 1024


class _FileLock:
    """Cross-process advisory lock. Every doi_host.py invocation is a
    separate OS process (main() handles exactly one request then exits), so
    a plain in-process threading.Lock does nothing to stop two of those
    processes from interleaving mid-write if they land close together (e.g.
    Settings' page-load fan-out opens several native-messaging connections
    back to back). Degrades to a no-op if locking is unavailable rather than
    failing the write — logging must never become the reason a request fails."""

    def __init__(self, handle):
        self.handle = handle

    def __enter__(self):
        try:
            if IS_WINDOWS:
                import msvcrt
                # msvcrt.locking() locks a byte range starting at the
                # file's CURRENT position -- unlike fcntl.flock() below,
                # which locks the whole file regardless of position. That
                # matters here: Python's open(path, "a") on Windows only
                # seeks to end-of-file ONCE, at open() time -- it does not
                # re-seek before every write the way POSIX's O_APPEND flag
                # guarantees at the kernel level. Two processes can each
                # capture their own now-stale "my EOF" position at open
                # time, then each successfully lock their own different
                # (non-conflicting) stale byte range and still clobber each
                # other on write. Locking a fixed sentinel byte at offset 0
                # instead means every process contends for the SAME lock
                # regardless of file size, so they're genuinely serialized;
                # only then do we seek to the real current end-of-file
                # (below, after the lock is held) to get a position no
                # other lock-respecting writer can have moved past.
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_LOCK, 1)
                self.handle.seek(0, os.SEEK_END)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX)
        except (ImportError, OSError):
            pass
        return self

    def __exit__(self, *exc):
        try:
            if IS_WINDOWS:
                import msvcrt
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        except (ImportError, OSError):
            pass
        return False


def _redact_debug_log_path(text):
    """Mask the OS account name in a path so this log is safe to attach to
    a bug report — mirrors extension/redact.js's redactPath() on the JS side."""
    import re
    text = re.sub(r"([A-Za-z]:[\\/]Users[\\/])[^\\/\s]+", r"\1<user>", text)
    text = re.sub(r"(/(?:home|Users)/)[^/\s]+", r"\1<user>", text)
    return text


def _redact_url_for_log(url):
    """Strip the query string and fragment from a URL before it's ever
    written to debug_log.txt (an exportable, shareable file) — mirrors
    extension/redact.js's URL handling on the JS side, added after a real
    user's exported log turned out to contain a live Gmail URL's query
    string. `_redact_debug_log_path` above only masks a bare filesystem
    path's account name, not a URL's query/fragment, so a "Scan Page for
    DOIs" run against an institutional-proxy or other tokenized URL (common
    for exactly the paywalled-access case this extension exists for) needs
    this separate pass. Never raises -- an unparseable string is logged as
    given rather than losing the whole diagnostic line over it."""
    try:
        parsed = urlparse(url)
        return parsed._replace(query="", fragment="").geturl()
    except Exception:
        return url


def debug_log(line):
    """Best-effort append to DEBUG_LOG_PATH. Never raises — a logging failure
    must not be able to break the actual feature that triggered it."""
    try:
        # Cheap size check rather than trimming on every call — only pay the
        # cost of a full read/rewrite once the file has actually grown large.
        try:
            oversized = os.path.getsize(DEBUG_LOG_PATH) > DEBUG_LOG_MAX_BYTES
        except OSError:
            oversized = False
        if oversized:
            with open(DEBUG_LOG_PATH, encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            with open(DEBUG_LOG_PATH, "w", encoding="utf-8") as f:
                f.writelines(lines[-2000:])
        # UTC, matching extension_log.txt's timestamps (JS's toISOString() is
        # always UTC) — a local-time stamp here would silently drift out of
        # sync with the JS log by the machine's UTC offset, making the two
        # logs impossible to line up side by side without doing timezone
        # arithmetic by hand.
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        # The newline is part of this SAME string, written in ONE write()
        # call — two records that land in the same append window can still
        # never end up with one swallowing the other's newline, which is
        # exactly how "action=recent_downloads" and the next record's
        # timestamp once got fused into one unparseable line (confirmed live
        # from a real Windows export: multiple doi_host.py processes appending
        # around the same moment, each seeking to EOF and writing without a
        # lock). newline="" additionally stops Windows from translating \n to
        # \r\n, which would otherwise make byte offsets and any future line-
        # count-based logic disagree with what's actually on disk.
        record = f"{timestamp} | {_redact_debug_log_path(str(line))}\n"
        with open(DEBUG_LOG_PATH, "a", encoding="utf-8", newline="") as f:
            with _FileLock(f):
                f.write(record)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass  # some filesystems/mounts don't support fsync; the write itself already landed
    except OSError:
        pass


def kill_process_tree(proc):
    """Terminate proc and any child processes it spawned.

    Plain proc.kill() only terminates the immediate child. On POSIX that's
    always enough here (scihub_download.py never forks its own children),
    but on Windows it isn't safe to assume the resolved interpreter is always a direct
    interpreter — a wrapper process (the `py` launcher is the common case,
    see find_python_with_requests()) spawns the real interpreter as a
    grandchild, and killing only the wrapper leaves that grandchild running
    and still holding the stdout pipe open, so the read loop below never
    sees EOF. taskkill /T recurses the whole tree in one call, so this stays
    correct even if some future resolved interpreter reintroduces a wrapper hop.
    """
    if IS_WINDOWS:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            capture_output=True,
        )
    else:
        proc.kill()


# ---------------------------------------------------------------------------
# Path validation -- defense in depth for the five actions below that take a
# filesystem path straight from the incoming message (read_log, open_folder,
# append_log, delete_file, reveal) and act on it with no other check.
# allowed_origins in the native-messaging manifest already pins this host to
# being reachable only from one specific Chrome extension ID, which is real
# protection, but it makes "the extension is never wrong" the *entire*
# security model. The extension renders remote metadata from Crossref,
# OpenAlex, and Semantic Scholar across a dozen pages -- a single
# HTML-injection bug anywhere in that surface would otherwise escalate
# straight to arbitrary local file read/write/delete via this host, which is
# supposed to be the last line of defense, not just a relay that trusts
# whatever path arrives.
# ---------------------------------------------------------------------------

def _allowed_path_roots(settings):
    """Directories a path-touching action is allowed to operate under: the
    user's configured output directory (if set), the built-in default output
    directory, and this script's own directory (native-host/ -- e.g. for any
    caller that legitimately reasons about a path relative to the host
    itself). Deliberately a short, explicit allowlist rather than "anything
    under the user's home directory" -- the whole point is to bound what a
    compromised extension page could reach even if it could get a message
    through, and "the entire home directory" isn't much of a bound."""
    roots = [
        os.path.join(os.path.expanduser("~"), "Downloads", "autorename"),
        SCRIPT_DIR,
    ]
    output_dir = (settings or {}).get("outputDir")
    if output_dir:
        roots.append(output_dir)
    return roots


def _validate_path(path, settings, must_exist=False):
    """Resolve `path` (following symlinks, collapsing ..) and require the
    result to sit under one of _allowed_path_roots(). Raises ValueError with
    a clear, loggable reason on rejection rather than returning a sentinel --
    every call site below is already inside a try/except that reports
    str(exception) back to the extension and logs it via debug_log(), so a
    legitimate config that trips this check is diagnosable rather than a
    silent no-op."""
    if not path:
        raise ValueError("No path provided")
    resolved = os.path.realpath(path)
    for root in _allowed_path_roots(settings):
        if not root:
            continue
        try:
            root_resolved = os.path.realpath(root)
        except OSError:
            continue
        if resolved == root_resolved or resolved.startswith(root_resolved + os.sep):
            if must_exist and not os.path.exists(resolved):
                raise ValueError(f"Path does not exist: {resolved}")
            return resolved
    raise ValueError(
        "Path is outside the allowed download directories "
        "(configured output folder, its built-in default, or the native host's own folder)"
    )


def _validate_script_path(script_path):
    """script_path can be overridden via Settings' free-text "Script path"
    field, which means it arrives in the message like any other value --
    require it to actually resolve inside SCRIPT_DIR. There is no legitimate
    case for running a script from outside the host's own directory; this
    exists specifically to stop a compromised Settings value (or a bug
    upstream that lets untrusted data reach it) from turning into arbitrary
    code execution via `python <attacker path>`."""
    resolved = os.path.realpath(script_path)
    if resolved != os.path.realpath(SCRIPT_DIR) and not resolved.startswith(os.path.realpath(SCRIPT_DIR) + os.sep):
        raise ValueError(f"Script path must be inside {SCRIPT_DIR}: got {resolved}")
    return resolved


def _validate_python_bin(python_bin):
    """python_bin can be overridden via Settings' free-text "Python
    interpreter path" field. Only ever validated for the STRING case here --
    get_python_bin()'s own internal auto-detection can return a [path, "-3"] list
    (the Windows py-launcher case, see find_python_with_requests()), but
    that value is computed internally by this trusted process, never taken
    from an incoming message, so it doesn't need re-validating here.
    Requires an existing regular file with the executable bit set, whose
    basename looks like a real Python interpreter -- rejects a value that's
    merely *some* executable, which would otherwise be "run this arbitrary
    binary" gated on nothing but the allowed_origins pin."""
    import re
    if not python_bin or not isinstance(python_bin, str):
        raise ValueError("No Python interpreter path provided")
    if "\x00" in python_bin:
        raise ValueError("Python interpreter path contains a null byte")
    resolved = os.path.realpath(python_bin)
    if not os.path.isfile(resolved):
        raise ValueError(f"Python interpreter path is not a file: {resolved}")
    if not IS_WINDOWS and not os.access(resolved, os.X_OK):
        raise ValueError(f"Python interpreter path is not executable: {resolved}")
    basename = os.path.basename(resolved)
    if not re.match(r"^python(3(\.\d+)?)?(\.exe)?$", basename, re.IGNORECASE):
        raise ValueError(f"Python interpreter path doesn't look like a Python interpreter: {basename}")
    return resolved


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
        # Explorer's /select flag and the path must be ONE token
        # ("/select,C:\path\file.pdf") -- split across two argv entries (as
        # this was before), Python's subprocess list-to-command-line joining
        # inserts a space between them, which Explorer doesn't parse as a
        # select directive at all; it silently opens a default window
        # instead. subprocess.run with a list still goes through
        # list2cmdline on Windows (there's no true argv array at the OS
        # level, just a single command-line string each program parses for
        # itself), so this only works when the flag and path are already one
        # string here, not fixed by argument-list splitting.
        subprocess.run(["explorer", "/select," + os.path.normpath(path)])
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


# Chrome's native-messaging protocol hard-caps a single message at 1 MB
# (https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-protocol)
# -- over that, Chrome drops the message and tears down the connection with
# no error the host can catch or report. Guarded well under the real limit
# so there's room for JSON overhead (field names, escaping) on top of
# whatever payload triggered this.
NATIVE_MESSAGE_SAFE_BYTES = 900 * 1024


def send_message(data):
    """Send a Native Messaging message to stdout.

    Guards against Chrome's 1 MB per-message ceiling: a message built from
    unbounded data (a long-lived download_log.txt, a big debug log, an
    arbitrary file read via read_log) could otherwise exceed it and get
    silently dropped, tearing down the native-messaging connection with no
    error visible anywhere -- precisely when a user is trying to export logs
    because something has already been going wrong. Sending a small,
    well-formed error instead is always safer than risking a message Chrome
    will reject outright.
    """
    encoded = json.dumps(data).encode("utf-8")
    if len(encoded) > NATIVE_MESSAGE_SAFE_BYTES:
        debug_log(f"send_message: payload was {len(encoded)} bytes, over the safe limit -- sending a truncation error instead")
        fallback = {
            "type": data.get("type", "result"),
            "status": "error",
            "detail": (
                f"Response was too large to send ({len(encoded) // 1024} KB) -- "
                "Chrome's native-messaging limit is 1 MB per message. The underlying "
                "file is larger than this host currently supports returning in one piece."
            ),
        }
        encoded = json.dumps(fallback).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _read_capped(path, max_bytes):
    """Read a text file, returning at most the LAST max_bytes bytes of it if
    it's larger -- used anywhere a file of unbounded/user-controlled size
    (download_log.txt grows forever across a heavy user's history; read_log
    can point at any per-batch subfolder log) gets sent back over native
    messaging, so send_message()'s guard above is a last resort rather than
    the normal path. Seeks to a byte boundary first, then decodes with
    errors='replace' so landing mid-multibyte-character at the cut point
    can't raise -- a slightly garbled first character is a fine trade for
    not crashing the export."""
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        if size > max_bytes:
            f.seek(size - max_bytes)
            content = "... [truncated - showing the most recent portion] ...\n" + f.read().decode("utf-8", errors="replace")
        else:
            content = f.read().decode("utf-8", errors="replace")
    return content


def _months_ago(dt, n):
    """Subtract n calendar months from dt, clamping the day if the target
    month is shorter (e.g. Aug 31 minus 6 months lands on Feb 28/29, not an
    invalid Feb 31). Used instead of timedelta(days=30*n), which drifts a
    real, compounding amount from "n calendar months" (30*7 = 210 days is
    anywhere from about a week to two weeks short of 7 real months,
    depending which months are involved) -- not just imprecise rounding.
    Doesn't pull in python-dateutil as a new dependency for what's a small
    amount of arithmetic."""
    month_index = dt.month - 1 - n
    year = dt.year + month_index // 12
    month = month_index % 12 + 1
    import calendar
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


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

    action = message.get("action")
    if action:
        debug_log(f"request: action={action}" + (f" doi={message['doi']}" if "doi" in message else ""))
    elif "doi" in message:
        debug_log(f"request: download doi={message['doi']}")

    if message.get("action") == "get_debug_log":
        try:
            content = _read_capped(DEBUG_LOG_PATH, DEBUG_LOG_MAX_BYTES)
        except FileNotFoundError:
            content = ""
        send_message({"type": "result", "status": "ok", "debug_log": content})
        return

    if message.get("action") == "clear_debug_log":
        try:
            open(DEBUG_LOG_PATH, "w").close()
            send_message({"type": "result", "status": "ok"})
        except OSError as e:
            send_message({"type": "result", "status": "error", "detail": str(e)})
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
                # mirror_health.json is written by a separate process
                # (scihub_download.py) and can be truncated/malformed by a
                # crash mid-write — unlike the last_seen parse above, this
                # one had no guard at all, so a single bad timestamp raised
                # ValueError straight out of this handler (no surrounding
                # try/except here) and took down the whole host, breaking
                # every native-host action for the rest of that connection,
                # not just this one field. Same treatment as last_seen:
                # treat an unparseable value as "not cooling down" instead.
                try:
                    last_failed_dt = datetime.fromisoformat(last_failed)
                    elapsed = now - last_failed_dt
                    remaining = timedelta(minutes=MIRROR_COOLDOWN_MINUTES) - elapsed
                    if remaining.total_seconds() > 0:
                        cooling_down = True
                        cooldown_remaining_min = round(remaining.total_seconds() / 60)
                except ValueError:
                    pass
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

        # Atomic write (temp file + os.replace, same pattern import_data and
        # scihub_download.py's own save_mirror_health() already use) --
        # scihub_download.py may be reading/writing this same file
        # concurrently from an in-flight mirror race, and a direct "w" open
        # here could hand it a half-written file mid-read.
        tmp_path = MIRROR_HEALTH_PATH + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(health, f, indent=2)
        os.replace(tmp_path, MIRROR_HEALTH_PATH)

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
        #
        # Deliberately NOT capped/truncated the way get_debug_log/read_log
        # are below: this is a *backup*, meant to be restorable later via
        # import_data, and a heavy user's download_log.txt can in principle
        # grow past Chrome's 1 MB native-message ceiling. Silently sending
        # back only the most recent portion would produce a backup that
        # looks complete but silently drops older history -- discovered only
        # months later, at restore time, when it's too late to do anything
        # about it. send_message()'s own size guard is the safety net here
        # instead: a loud, honest "too large to export" beats a quiet,
        # incomplete backup.
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
            _verify_origin_remote()
            subprocess.run(
                ["git", "fetch", "--quiet", "origin"],
                cwd=REPO_DIR, check=True, capture_output=True, text=True, timeout=30,
                env=_GIT_NO_PROMPT_ENV,
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
            _verify_origin_remote()
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
                # Name the actual files git sees as changed, not just the
                # generic refusal -- a real Windows user hit this on every
                # single attempt for a week (line-ending normalization
                # making git see every tracked file as "modified" with no
                # .gitattributes pinning it -- see that file), and the old
                # generic message gave no way to tell what was actually
                # blocking it without a full log export. git status
                # --porcelain paths are already relative to REPO_DIR, so
                # there's no absolute-path/username content to redact here.
                preview = blocking_lines[:10]
                more = len(blocking_lines) - len(preview)
                file_list = ", ".join(preview) + (f", and {more} more" if more > 0 else "")
                detail = (
                    "Local changes exist in the repo checkout — resolve or stash them before updating. "
                    f"Changed: {file_list}"
                )
                debug_log(f"apply_update refused, {len(blocking_lines)} file(s) changed: {file_list}")
                send_message({
                    "type": "result", "status": "error",
                    "detail": detail,
                })
                return

            pull = subprocess.run(
                ["git", "pull", "--ff-only"],
                cwd=REPO_DIR, check=True, capture_output=True, text=True, timeout=60,
                env=_GIT_NO_PROMPT_ENV,
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
        # _months_ago() computes the actual calendar-month boundary rather
        # than a fixed-days approximation (timedelta(days=30*n) drifts a
        # real, compounding amount from "n calendar months" -- see its own
        # docstring) — used here for "last_month"/"last_6_months".
        windows = {
            "last_24_hours": now - timedelta(hours=24),
            "last_week": now - timedelta(weeks=1),
            "last_month": _months_ago(now, 1),
            "last_6_months": _months_ago(now, 6),
        }
        counts = {"total": 0, "last_24_hours": 0, "last_week": 0, "last_month": 0, "last_6_months": 0}

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
                    for key, cutoff in windows.items():
                        if ts >= cutoff:
                            counts[key] += 1
        except FileNotFoundError:
            pass

        send_message({"type": "result", "status": "ok", "counts": counts})
        return

    if message.get("action") == "read_log":
        filepath = message.get("filepath")
        settings = message.get("settings") or {}
        try:
            filepath = _validate_path(filepath, settings)
            content = _read_capped(filepath, DEBUG_LOG_MAX_BYTES)
            send_message({"type": "result", "status": "ok", "content": content})
        except FileNotFoundError:
            send_message({"type": "result", "status": "ok", "content": ""})
        except Exception as e:
            debug_log(f"read_log rejected: {e}")
            send_message({"type": "result", "status": "error", "detail": str(e)})
        return

    if message.get("action") == "open_folder":
        folder = message.get("folder")
        settings = message.get("settings") or {}
        try:
            folder = _validate_path(folder, settings)
            os.makedirs(folder, exist_ok=True)
            open_in_file_manager(folder)
            send_message({"type": "result", "status": "ok"})
        except Exception as e:
            debug_log(f"open_folder rejected: {e}")
            send_message({"type": "result", "status": "error", "detail": str(e)})
        return

    if message.get("action") == "append_log":
        filepath = message.get("filepath")
        line = message.get("line", "")
        settings = message.get("settings") or {}
        try:
            filepath = _validate_path(filepath, settings)
            os.makedirs(os.path.dirname(filepath), exist_ok=True)
            with open(filepath, "a") as f:
                f.write(line + "\n")
            send_message({"type": "result", "status": "ok"})
        except Exception as e:
            debug_log(f"append_log rejected: {e}")
            send_message({"type": "result", "status": "error", "detail": str(e)})
        return

    if message.get("action") == "delete_file":
        filepath = message.get("filepath")
        settings = message.get("settings") or {}
        try:
            filepath = _validate_path(filepath, settings)
            # This action exists solely to remove a corrupt download (the
            # popup's "Delete Corrupt File" button) -- restrict it further
            # than the general path check, since "delete an arbitrary file
            # under the output folder" is a bigger blast radius than this
            # feature actually needs.
            if not filepath.lower().endswith(".pdf"):
                raise ValueError("delete_file only accepts a .pdf path")
            os.remove(filepath)
            send_message({"type": "result", "status": "ok"})
        except Exception as e:
            debug_log(f"delete_file rejected: {e}")
            send_message({"type": "result", "status": "error", "detail": str(e)})
        return

    if message.get("action") == "reveal":
        filepath = message.get("filepath")
        settings = message.get("settings") or {}
        try:
            filepath = _validate_path(filepath, settings)
            target = resolve_reveal_target(filepath)
            reveal_in_file_manager(target)
            send_message({"type": "result", "status": "ok"})
        except Exception as e:
            debug_log(f"reveal rejected: {e}")
            send_message({"type": "result", "status": "error", "detail": str(e)})
        return

    if message.get("action") == "scan_pdf_dois":
        url = message.get("url")
        settings = message.get("settings") or {}
        if not url:
            send_message({"type": "result", "status": "error", "detail": "No PDF URL received"})
            return

        # settings.get("pythonBin") or get_python_bin() -- Python's `or`
        # short-circuits, so an actual Settings override skips calling
        # get_python_bin() (and therefore any interpreter probing) entirely.
        used_override = bool(settings.get("pythonBin"))
        python_bin = settings.get("pythonBin") or get_python_bin()
        script_path = settings.get("scriptPath") or YOUR_SCRIPT
        try:
            # Only re-validate an actual override from Settings -- the
            # auto-detected interpreter/script are computed/configured by
            # this trusted process itself, not taken from the incoming
            # message.
            if settings.get("pythonBin"):
                python_bin = _validate_python_bin(settings["pythonBin"])
            if settings.get("scriptPath"):
                script_path = _validate_script_path(settings["scriptPath"])
        except ValueError as e:
            debug_log(f"scan_pdf_dois rejected: {e}")
            send_message({"type": "result", "status": "error", "detail": str(e)})
            return
        python_bin_args = python_bin if isinstance(python_bin, list) else [python_bin]
        cmd = python_bin_args + [script_path, "--scan-pdf-url", url]

        debug_log(
            f"spawning (scan_pdf_dois): url={_redact_url_for_log(url)} platform={platform.system()} {platform.release()} "
            f"python_bin={python_bin_args} (auto-detected={not used_override}) script={script_path}"
        )

        try:
            popen_kwargs = {}
            if IS_WINDOWS:
                popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding='utf-8', errors='replace',
                bufsize=1,
                **popen_kwargs,
            )

            # Same hard-timeout watchdog as the download/check dispatch below —
            # a large multi-hundred-page PDF's text extraction has no
            # per-chunk progress line, so this is what catches a genuine hang
            # rather than just slow-but-progressing work.
            HARD_TIMEOUT_SECONDS = 180
            watchdog = threading.Timer(HARD_TIMEOUT_SECONDS, kill_process_tree, args=(proc,))
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
                debug_log(f"result (scan_pdf_dois): url={_redact_url_for_log(url)} status={result.get('status')} count={len(result.get('dois') or [])}")
            elif proc.returncode == 0:
                send_message({"type": "result", "status": "ok", "dois": []})
            else:
                detail = stderr_output.strip() or "Script exited with an error"
                send_message({"type": "result", "status": "error", "detail": detail})
                debug_log(f"result (scan_pdf_dois): url={_redact_url_for_log(url)} status=error returncode={proc.returncode} detail={detail}")

        except subprocess.TimeoutExpired:
            send_message({"type": "result", "status": "error", "detail": "Script timed out"})
        except FileNotFoundError:
            send_message({"type": "result", "status": "error", "detail": f"Script not found: {script_path}"})
        except Exception as e:
            send_message({"type": "result", "status": "error", "detail": str(e)})
            debug_log(f"result (scan_pdf_dois): url={_redact_url_for_log(url)} status=error detail={e}\n{traceback.format_exc()}")
        return

    if "doi" not in message:
        send_message({"type": "result", "status": "error", "detail": "No DOI received"})
        return

    doi = message["doi"]
    settings = message.get("settings") or {}

    # settings.get("pythonBin") or get_python_bin() -- Python's `or`
    # short-circuits, so an actual Settings override skips calling
    # get_python_bin() (and therefore any interpreter probing) entirely.
    used_override = bool(settings.get("pythonBin"))
    python_bin = settings.get("pythonBin") or get_python_bin()
    script_path = settings.get("scriptPath") or YOUR_SCRIPT
    output_dir = settings.get("outputDir")
    mirrors = settings.get("mirrors")
    scidb_mirrors = settings.get("scidbMirrors")
    unpaywall_email = settings.get("unpaywallEmail")

    try:
        # Only re-validate an actual override from Settings -- the
        # auto-detected interpreter/script are computed/configured by this
        # trusted process itself, not taken from the incoming message.
        if settings.get("pythonBin"):
            python_bin = _validate_python_bin(settings["pythonBin"])
        if settings.get("scriptPath"):
            script_path = _validate_script_path(settings["scriptPath"])
    except ValueError as e:
        debug_log(f"result: doi={doi} status=error detail=rejected: {e}")
        send_message({"type": "result", "status": "error", "detail": str(e)})
        return

    # find_python_with_requests() always resolves to a single concrete
    # interpreter path now (see its docstring for why: spawning through a
    # wrapper like the `py` launcher instead is what caused the Windows
    # hang-forever bug this file's kill_process_tree() works around). Kept
    # as a list-or-string flatten anyway since the interpreter can be
    # overridden by Settings' free-text Python interpreter path field.
    python_bin_args = python_bin if isinstance(python_bin, list) else [python_bin]
    cmd = python_bin_args + [script_path, doi]
    if output_dir:
        cmd += ["-d", output_dir]
    if mirrors:
        cmd += ["-m", ",".join(mirrors)]
    if scidb_mirrors:
        cmd += ["--scidb-mirrors", ",".join(scidb_mirrors)]
    if unpaywall_email:
        cmd += ["--email", unpaywall_email]
    if message.get("action") == "check":
        cmd += ["--check"]

    # Full environment context right next to the actual spawn — the single
    # most useful line for diagnosing a platform-specific failure (which
    # interpreter got picked, whether it's the auto-detect or a Settings
    # override, OS/version), so it's always right there next to whatever
    # error follows rather than requiring a separate "session start" line.
    debug_log(
        f"spawning: doi={doi} platform={platform.system()} {platform.release()} "
        f"python_bin={python_bin_args} (auto-detected={not used_override}) "
        f"script={script_path} cmd_tail={cmd[2:]}"
    )

    try:
        popen_kwargs = {}
        if IS_WINDOWS:
            # Without this, spawning a console-subsystem python.exe from a
            # windowless host (Chrome launched doi_host.py with no console of
            # its own) makes Windows allocate a fresh console window for it —
            # a visible flash on every single DOI check/download otherwise.
            popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8', errors='replace',
            bufsize=1,
            **popen_kwargs,
        )

        # Absolute ceiling: kills the child even if it hangs with stdout open
        # (the read loop below otherwise blocks forever and proc.wait() below
        # is never reached). Set well above the script's own retry budget —
        # get_pdf_url alone can legitimately run ~70s (4 retries, ~15s mirror
        # races apart) before Unpaywall/publisher/download tiers even start —
        # so this only ever catches a true hang, not slow-but-progressing work.
        HARD_TIMEOUT_SECONDS = 180
        watchdog = threading.Timer(HARD_TIMEOUT_SECONDS, kill_process_tree, args=(proc,))
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
            debug_log(f"result: doi={doi} status={result.get('status')} detail={result.get('detail', '')}")
        elif proc.returncode == 0:
            send_message({"type": "result", "status": "ok", "detail": "Completed"})
            debug_log(f"result: doi={doi} status=ok (no RESULT: line, returncode 0)")
        else:
            detail = stderr_output.strip() or "Script exited with an error"
            send_message({"type": "result", "status": "error", "detail": detail})
            debug_log(f"result: doi={doi} status=error returncode={proc.returncode} detail={detail}")

    except subprocess.TimeoutExpired:
        send_message({"type": "result", "status": "error", "detail": "Script timed out"})
        debug_log(f"result: doi={doi} status=error detail=Script timed out")
    except FileNotFoundError:
        send_message({"type": "result", "status": "error", "detail": f"Script not found: {script_path}"})
        debug_log(f"result: doi={doi} status=error detail=Script not found: {script_path}")
    except Exception as e:
        send_message({"type": "result", "status": "error", "detail": str(e)})
        debug_log(f"result: doi={doi} status=error detail={e}\n{traceback.format_exc()}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Anything raised here previously just crashed the process silently —
        # Chrome sees the native host disconnect and surfaces a generic error
        # via lastError, but nothing useful for a bug report survived. Log
        # the real traceback before letting it propagate (behavior/exit code
        # unchanged, only the visibility is new).
        debug_log("FATAL uncaught exception in main():\n" + traceback.format_exc())
        raise
