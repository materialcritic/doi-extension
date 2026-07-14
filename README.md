<img src="extension/icons/icon128.png" width="64" height="64" alt="DOI Grabber icon" />

# DOI Grabber

A Chrome extension (Manifest V3) that detects the DOI of the academic paper you're currently viewing, checks whether it's available on Sci-Hub (falling back to Unpaywall / open-access publisher copies when it isn't), and downloads it in one click via a local Python script running through a Native Messaging host. It also layers on a full set of Crossref-powered research tools: bulk-download an author's entire body of work, an entire journal issue, or an entire journal; see who a paper cites and who cites it; find similar papers; watch a journal or author for new releases; and more.

This is a **personal, single-machine tool** — it is not published on the Chrome Web Store (and can't be: the Sci-Hub integration is explicitly against Web Store policy) and isn't designed to be installed by strangers with zero setup. It's distributed here on GitHub so it can be version-controlled, backed up, and reinstalled on a new machine.

> ⚠️ **A note on legality.** This tool integrates with Sci-Hub, which operates in a legal gray area (or is outright illegal, depending on jurisdiction) because it mirrors copyrighted papers without publisher permission. Whether and how you use it is your own call to make and your own risk to bear. This project is shared for personal backup/portability purposes, not as an endorsement or as legal advice.

---

## Table of contents

- [What it does](#what-it-does)
- [How it's built](#how-its-built)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [1. Clone the repo and load the Chrome extension](#1-clone-the-repo-and-load-the-chrome-extension)
  - [2. Install the Native Messaging host](#2-install-the-native-messaging-host)
  - [3. Point the extension at your Python setup](#3-point-the-extension-at-your-python-setup)
  - [4. Try it](#4-try-it)
- [Using the popup](#using-the-popup)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [The full-page tools](#the-full-page-tools)
  - [More by This Author](#more-by-this-author)
  - [Common Collaborators](#common-collaborators)
  - [Download This Issue](#download-this-issue)
  - [Download Entire Journal](#download-entire-journal)
  - [Similar Papers](#similar-papers)
- [Settings page](#settings-page)
- [Keeping it up to date](#keeping-it-up-to-date)
- [Reporting a bug or requesting a feature](#reporting-a-bug-or-requesting-a-feature)
- [Project structure](#project-structure)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)

---

## What it does

Open any academic paper's page (a journal site, a DOI resolver link, PhilPapers, SAGE, Taylor & Francis, etc.) and the extension:

1. **Detects the DOI** automatically — from the URL, `citation_doi`/`dc.identifier` meta tags, or page text.
2. **Checks availability** in the background and badges the toolbar icon: 🟢 green if a real PDF was found, 🔴 red if confirmed unavailable, no badge if inconclusive.
3. Lets you **download it in one click**, tried in this order:
   - **Sci-Hub** (races all configured mirrors in parallel, keeps a health/latency history per mirror, returns whichever responds first)
   - **Unpaywall** (legitimate open-access copy, if Sci-Hub has nothing)
   - **The publisher's own landing page** (looks for a `citation_pdf_url` meta tag or a direct PDF link, if Unpaywall also has nothing)
4. If it's still unavailable, offers **fallbacks**: search Google for the title + author, search Google Scholar for the author, or (for SAGE papers specifically) jump straight to SAGE's own PDF viewer in case it's actually open-access.

On top of the single-paper flow, it also has full pages for **bulk-downloading** an author's entire output, an entire journal issue, or an entire journal; browsing a paper's **references** and **citations**; finding **similar/related papers**; and **watching** a journal or author for new releases.

## How it's built

Two halves that talk to each other over [Chrome's Native Messaging protocol](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging):

```
┌─────────────────────────────┐        stdio, length-prefixed JSON       ┌──────────────────────────┐
│   Chrome Extension (MV3)    │ ───────────────────────────────────────▶ │   Native Messaging Host   │
│   extension/                │ ◀─────────────────────────────────────── │   native-host/doi_host.py │
│                              │                                          │                            │
│  content.js  — detects DOI  │                                          │  spawns & streams:         │
│  background.js — svc worker │                                          │  scihub_download.py        │
│  popup.html/js — toolbar UI │                                          │  (Sci-Hub/Unpaywall/       │
│  options.html/js — settings │                                          │   publisher-page fallback) │
│  author/issue/collaborators/│                                          │                            │
│  journal-download/search    │                                          │  reads/writes:             │
│  .html/.js — full-page tools│                                          │  download_log.txt          │
└─────────────────────────────┘                                          │  mirror_health.json         │
                                                                          └──────────────────────────┘
```

The extension talks to the free **Crossref**, **OpenAlex**, and **Semantic Scholar** REST APIs directly (no key required for any of them) for metadata, references, citations, and recommendations. It also makes best-effort calls to **ORCID** (`pub.orcid.org`) and **Gravatar** (`www.gravatar.com`) to fetch an author avatar on the author pages — ORCID to find a public contact email, Gravatar to turn that email into a photo (falling back to initials when there's no public email or registered avatar). Only the actual PDF-fetching goes through the native host.

## Prerequisites

- **macOS, Windows, or Linux**, with **Google Chrome** (or another Chromium-based browser that supports MV3 + Native Messaging, e.g. Brave/Edge — untested here, but should work)
- **Python 3** with the [`requests`](https://pypi.org/project/requests/) and [`beautifulsoup4`](https://pypi.org/project/beautifulsoup4/) packages installed:
  ```bash
  pip3 install requests beautifulsoup4      # macOS/Linux
  py -m pip install requests beautifulsoup4 # Windows
  ```
- **`git`**, installed and on your PATH — used both to clone this repo initially and by the extension's own [self-update feature](#keeping-it-up-to-date), which shells out to `git fetch`/`git pull` in your local checkout.
- Familiarity with `chrome://extensions` Developer Mode, and running shell scripts from Terminal (macOS) or PowerShell (Windows)

`native-host/doi_host.py` and `native-host/scihub_download.py` auto-detect sensible defaults (their own folder for log/health files, `python3`/`python`/the `py` launcher for the interpreter, `~/Downloads/autorename` for the output folder) so they work out of the box on both platforms — nothing needs source-editing before first install, only the Settings-page fields below.

## Installation

### 1. Clone the repo and load the Chrome extension

Pick one folder for the whole repo up front — both the extension and the native host need to live under the **same git checkout** (the [self-update feature](#keeping-it-up-to-date) runs `git pull` in whatever folder `native-host/doi_host.py` sits in, and that only makes sense if it's this repo).

> **On macOS, clone somewhere other than `~/Downloads` (or `~/Desktop`/`~/Documents`).** Those are TCC-protected folders — even with the extension and native host wired up correctly, macOS can silently block Chrome from *executing* `doi_host.py` out of one of them, with no prompt and no useful error beyond a generic "native host has exited." A plain home-directory location like `~/doi-extension` avoids the whole problem. (This is separate from the Gatekeeper quarantine-flag issue below — that one's about *where the file came from*, this one's about *which folder it lives in*.)

```bash
cd ~
git clone https://github.com/materialcritic/doi-extension.git
cd doi-extension
```

1. Open Chrome and go to `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this repo's `extension/` folder.
4. Note the **Extension ID** shown on the card that appears — you'll need it in the next step.

### 2. Install the Native Messaging host

<details open>
<summary><strong>macOS / Linux</strong></summary>

> **If Chrome reports "native host has exited," there are two independent macOS causes to rule out** (see [Troubleshooting](#troubleshooting) for full recovery steps):
> 1. **Wrong folder (see the callout above)** — `doi_host.py` living under `~/Downloads`/`~/Desktop`/`~/Documents` can be silently blocked by macOS's TCC folder protection, with no error beyond this generic message. Move the whole repo to somewhere like `~/doi-extension` and re-run `./install.sh`.
> 2. **Quarantine flag** — macOS Gatekeeper attaches `com.apple.quarantine` to files downloaded through a browser or saved by an app like TextEdit/Finder from a browser-downloaded source. A `git clone` run from Terminal does **not** set this flag, so it's rarer, but check with `xattr -l native-host/doi_host.py` and clear it with `xattr -d com.apple.quarantine native-host/doi_host.py` if present.

```bash
cd doi-extension/native-host   # wherever you cloned the repo, from step 1
./install.sh
```

The installer will:
- `chmod +x doi_host.py`
- Ask for the **Extension ID** from step 1
- Write `com.doi_grabber.host.json` (the Native Messaging manifest Chrome reads) to `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (macOS) or `~/.config/google-chrome/NativeMessagingHosts/` (Linux), pointing at your `doi_host.py`

</details>

<details>
<summary><strong>Windows</strong></summary>

```powershell
cd doi-extension\native-host
.\install.ps1
```

If PowerShell blocks the script from running, allow it for this session first: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`.

The installer will:
- Ask for the **Extension ID** from step 1
- Write `com.doi_grabber.host.json` next to itself in `native-host\`, with `"path"` pointing at `doi_host.bat` (a small wrapper — Chrome needs an executable it can spawn directly, and can't run a bare `.py` file the way macOS/Linux can via a shebang line)
- Register that manifest's path in the registry at `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.doi_grabber.host` (Windows has no fixed native-messaging-hosts folder like macOS/Linux — it uses the registry instead)

`doi_host.bat` looks for the `py` launcher (bundled with the standard python.org Windows installer) first, falling back to `python` on PATH.

> Windows support here is implemented but not verified on a real Windows machine — if something doesn't work, please [file a bug report](#reporting-a-bug-or-requesting-a-feature) with the exact error.

</details>

### 3. Point the extension at your Python setup

Open the extension's **Settings** page (right-click the toolbar icon → Options, or click the ⚙ in the popup) and fill in the **Connection** card — only needed if the auto-detected defaults don't already work for you:

| Field | What it is |
|---|---|
| **Output folder** | Where downloaded PDFs are saved. Leave blank to use `scihub_download.py`'s default (`~/Downloads/autorename`, or `%USERPROFILE%\Downloads\autorename` on Windows). |
| **Python interpreter path** | Full path to a `python3`/`python` that has `requests` and `beautifulsoup4` installed (e.g. `/opt/homebrew/bin/python3` for Homebrew on Apple Silicon, or `C:\Users\you\AppData\Local\Programs\Python\Python312\python.exe` on Windows). Chrome may launch the native host with a system interpreter that lacks your packages — this field overrides that per-request. |
| **Script path** | Full path to `scihub_download.py` (in this repo: `native-host/scihub_download.py`). Also overridable at runtime. |
| **Sci-Hub mirrors** | One URL per line. Leave blank to use the script's built-in mirror list. |

One thing is **not** exposed in the UI and is hardcoded directly in `scihub_download.py` instead: `UNPAYWALL_EMAIL` — Unpaywall's API asks for a real contact address in every request per their usage policy; replace the placeholder with your own if you're running this yourself.

### 4. Try it

1. Fully restart Chrome (Native Messaging hosts are only re-spawned on a fresh connection after a full restart, or a disable/re-enable of the extension — a plain "reload" of the extension is **not** enough after changing `doi_host.py` or `scihub_download.py`).
2. Visit any academic paper's page (try a DOI resolver link like `https://doi.org/10.1234/example`, or any journal article page).
3. Click the toolbar icon. If a DOI was detected, you'll see it in the box and the **Download** button will enable.
4. Click **Download** and watch the live log scroll as it races mirrors and saves the file.

## Using the popup

Click the toolbar icon on any page with a detected DOI to get:

| Button | What it does |
|---|---|
| **Download** | Downloads the PDF (Sci-Hub → Unpaywall → publisher page, in that order) to your configured output folder. |
| **Copy DOI** | Copies the bare DOI string to your clipboard. |
| **Copy Sci-Hub Link** | Resolves and copies the mirror URL without downloading anything. |
| **View on Sci-Hub** | Opens the paper directly on a working Sci-Hub mirror in a new tab (auto-expands the PDF viewer to fill the tab). |
| **View Sage PDF (Open Access)** | Only shown for SAGE papers (`10.1177/...`) marked unavailable — opens SAGE's own PDF viewer directly, since some are open-access despite Sci-Hub/Unpaywall having nothing. |
| **More by This Author** | Opens a Google Scholar search for the detected author's name in a new tab. |
| **Download All Works** | Opens the [Download All Works](#more-by-this-author) page (Crossref-based bulk download) for the detected author. |
| **Common Collaborators** | Opens the [co-author network page](#common-collaborators) for the detected author. |
| **Download This Issue** | Opens the [issue download page](#download-this-issue) for the paper's volume/issue. |
| **QR Code** | Shows a scannable QR code (generated fully offline — nothing leaves your machine) linking to the article on Sci-Hub, for opening on your phone. |
| **References** | Lists the paper's references (via Crossref), each row clickable straight to Sci-Hub. |
| **Cited By** | Lists papers that cite this one (via Semantic Scholar). |
| **Related Papers** | Citation-graph-based recommendations (via Semantic Scholar's Recommendations API) — different from the keyword-based "Find Similar" on the full-page tools. |
| **Reveal in Finder** | Shown after a successful download — opens Finder (macOS) or File Explorer (Windows) with the file selected. |
| **Delete Corrupt File** | Shown if the download failed the PDF-header check (usually means a mirror served an HTML error page instead of a real PDF). |
| **Search Google Instead** | Opens a Google search for `<title> <author>` — always available, not just when unavailable. |
| ⚙ (top right) | Opens Settings. |
| ☀/🌙 (top right) | Quick-toggles between your last-picked light theme and Dark. |

## Keyboard shortcuts

Two page-wide shortcuts (work anywhere, even with the popup closed), set by Chrome itself:

- **⌥D** (Alt+D) — download the current paper, if available
- **⌥F** (Alt+F) — search Google for the current paper

These can be remapped at `chrome://extensions/shortcuts` (linked from the Settings page). Chrome caps extensions at 4 total assignable shortcuts, so beyond these two there's a separate **popup-only** shortcut layer — single keypresses that only fire while the popup itself has keyboard focus:

| Key | Action |
|---|---|
| `d` | Download |
| `c` | Copy DOI |
| `l` | Copy Sci-Hub Link |
| `v` | View on Sci-Hub |
| `a` | More by This Author |
| `w` | Download All Works |
| `o` | Common Collaborators |
| `i` | Download This Issue |
| `q` | QR Code |
| `r` | References |
| `b` | Cited By |
| `g` | Search Google Instead |

Reassign any of these from Settings → **Popup Shortcuts** — click "Change" on a row and press the new key. If that key is already used elsewhere, it's freed from the other action automatically rather than binding twice.

## The full-page tools

Several buttons open dedicated tabs for bulk operations too heavy for the small popup:

### More by This Author

Searches Crossref for every work matching the detected author's name (up to 1,000 results) and gives you:
- A checklist to batch-download selected works into `<output folder>/<author name>/`
- Skip-already-downloaded on reopen, plus a "Retry Failed" button
- Sort by relevance / newest / oldest / downloadable-first / by-journal / most-cited
- A live filter box (⌘/Ctrl+F to focus it)
- A progress bar with a live ETA during a batch run
- A year-published histogram — click a bar to filter the list to that year
- Google Scholar and "Institutional Website" quick-search buttons
- A **"Watch This Author"** button — background-checks every 6 hours for new work, notifies you when one appears

### Common Collaborators

Same underlying author search, but tallies co-author frequency into a ranked list (excluding the target author themselves), each linking to that person's own author page. Toggle **"Show Network Graph"** for a radial visualization — the target author in the center, their top 20 collaborators arranged around them, with lines to collaborators who also worked together directly.

### Download This Issue

Given any paper, resolves its journal/volume/issue via Crossref and lists every article in that issue with the same batch-download UI as the author page (checklist, skip-already-downloaded, retry-failed, progress bar). Also supports:
- **Batch Download Multiple Issues** — a volume range (up to 50) at a fixed issue number
- **Search This Journal** — keyword search scoped to just this journal, with sortable/paginated results and a "Download All Matches" button
- **Watch This Journal** — notifies you when a new issue appears (checked every 6 hours)
- Pause/Resume + Cancel controls for any running batch

### Download Entire Journal

Opens its own tab (since walking an entire journal can mean thousands of articles). Fetches every issue via deep Crossref pagination, groups them into collapsible per-issue cards, and lets you review the full list — with per-article remove buttons — before clicking **Start**. Live per-row status (Pending → Downloading… → ✓/Failed/Corrupt) plus a sticky Pause/Cancel toolbar and overall progress bar. Gated behind a confirmation dialog since it can run for a very long time.

### Similar Papers

A **"Find Similar"** link next to any paper's title (on the author/issue/journal pages) does lightweight keyword extraction from its abstract (or title, if no abstract) and opens a new results page built on Crossref's bibliographic search — using the same batch-download UI as everywhere else. Results can chain into further similarity searches.

## Settings page

Right-click the toolbar icon → **Options** (or click ⚙ in the popup):

- **Appearance** — 6 color themes: Dark (default), Warm Parchment, Cool Slate, Soft Sage, Pure Minimal, Carrot
- **Connection** — output folder, Python interpreter path, script path, Sci-Hub mirror list (see [Installation](#3-point-the-extension-at-your-python-setup))
- **Keyboard Shortcuts** — read-only view of the current Alt+D/Alt+F bindings, with a link to Chrome's remap page
- **Popup Shortcuts** — reassign any of the single-key popup shortcuts
- **Journal Watchlist** / **Author Watchlist** — manage what you're currently watching, with a manual "Check Now"
- **Download Stats** — total-ever / last-7-weeks / last-7-months / last-year download counts
- **Paper of the Day** — a deterministic daily pick from your download history, with a "Show Another" button and history list
- **Mirror Health** — per-mirror fail count, cooldown countdown, and a latency sparkline; per-mirror or global reset
- **Updates** — check for and install new versions from GitHub; see [Keeping it up to date](#keeping-it-up-to-date)
- **Backup & Support**:
  - **Export Everything** — bundles your settings, watchlists, download history, and mirror health into a downloadable `.zip`
  - **Report a Bug/Feature Request** — see below

## Keeping it up to date

Since this isn't distributed through the Chrome Web Store, "updating" means pulling new commits into your local git clone — Settings has a card that does this for you:

- **Check for Updates** — runs `git fetch` against `origin` and lists how many commits you're behind, with the changelog (commit messages) for what would land.
- **Update Now** — appears once you're behind. Runs a fast-forward-only `git pull` (`git pull --ff-only`) through the native host. It refuses if your checkout has any uncommitted local changes, rather than risking a conflicted merge — commit or stash first if you've been editing the code yourself.
- After a successful update, the extension reloads itself automatically. If any file under `native-host/` changed, you'll be told to **fully restart Chrome** as well (see [Known limitations](#known-limitations)) — an extension reload alone won't pick up native-host code changes.
- The popup shows a small **"Update available"** hint whenever you're behind, driven by a background check every 12 hours — click it to jump straight to the Updates card.

This only works because the extension and native host are loaded from the same git checkout (see [step 1 of installation](#1-clone-the-repo-and-load-the-chrome-extension)) with an `origin` remote pointed at this repo — if you installed by copying files instead of cloning, the update check will fail with a git error, and you'll need to update by pulling manually instead.

## Reporting a bug or requesting a feature

Click **Report a Bug/Feature Request** at the bottom of Settings. It opens a form (in a new tab) where you can:
- Pick **Bug** or **Feature Request**
- Write a description and (optionally) paste relevant code/logs
- Attach screenshots

Clicking **Open GitHub Issue** opens a pre-filled [GitHub issue](https://github.com/materialcritic/doi-extension/issues/new) with everything except the screenshots (GitHub issue-creation links can't carry file attachments — drag the screenshot(s) into the issue body once it opens). If you'd rather not use GitHub, **Copy Report for Email** copies the whole report as text to your clipboard instead, ready to paste into whatever email client you use.

## Project structure

```
doi-extension/
├── extension/                    # The Chrome extension (load unpacked from here)
│   ├── manifest.json              # MV3 manifest — permissions, host permissions, commands
│   ├── content.js                 # Scans each page for a DOI + author/title metadata
│   ├── background.js              # Service worker — availability checks, badging, watchlists,
│   │                               #   Crossref/OpenAlex/Semantic Scholar calls, notifications
│   ├── popup.html / popup.js      # Toolbar popup
│   ├── options.html / options.js  # Settings page
│   ├── author.html / author.js    # "Download All Works" page
│   ├── collaborators.html/.js     # "Common Collaborators" page
│   ├── issue.html / issue.js      # "Download This Issue" page
│   ├── journal-download.html/.js  # "Download Entire Journal" page
│   ├── search.html / search.js    # "Similar Papers" results page
│   ├── report.html / report.js    # Bug/feature report form
│   ├── theme.js                   # Shared 6-palette color theme system
│   ├── shortcuts.js                # Shared popup-shortcut definitions
│   ├── scihub-fullscreen.js       # Content script: auto-expands the PDF viewer on Sci-Hub mirrors
│   ├── vendor/qrcode.js           # Vendored offline QR encoder
│   ├── vendor/zipwriter.js        # Vendored zero-dependency ZIP writer (for Export Everything)
│   └── icons/                     # Toolbar icon (16/48/128px)
├── native-host/
│   ├── doi_host.py                 # Native Messaging host — spawns scihub_download.py, streams
│   │                               #   progress, handles reveal/delete/mirror-health/export actions
│   ├── scihub_download.py         # The actual DOI → PDF downloader (Sci-Hub/Unpaywall/publisher)
│   ├── com.doi_grabber.host.json  # Native Messaging manifest template (install.sh/install.ps1 fill this in)
│   ├── install.sh                  # Installer for macOS/Linux — registers the native host with Chrome
│   ├── install.ps1                 # Installer for Windows — same, via the Windows Registry
│   └── doi_host.bat                # Windows wrapper so Chrome can spawn doi_host.py as an executable
└── ...
```

## Known limitations

- **PhilPapers and Google Scholar can't be scraped** — both are permanently blocked (Cloudflare challenge and no free API, respectively). All author/paper search is Crossref-based instead.
- **Tandfonline and some other Cloudflare-protected publishers** return a bot-challenge page to any server-side fetch — their PDFs/abstracts can only be reached by a real browser tab, not the native host. The SAGE-specific "View Sage PDF" button works around this on the extension side; other publishers don't currently have an equivalent.
- **Crossref's author search is relevance-ranked, not a guaranteed-complete filter** — even at the 1,000-result cap, an extremely prolific author's most obscure works could theoretically be missed. There's no "everything by this ORCID" endpoint without a known ORCID iD.
- Requires **restarting Chrome** (not just reloading the extension) after any change to `doi_host.py` or `scihub_download.py`, since the native host is a separate long-lived process.
- **Windows support is implemented but unverified** on a real Windows machine (built and reasoned through, not hands-on tested) — see the callout in [step 2 of installation](#2-install-the-native-messaging-host).
- On Linux, "Reveal in Finder" falls back to just opening the containing folder (via `xdg-open`) rather than selecting the file within it — there's no single standard way to select a specific file across Linux file managers the way `open -R`/`explorer /select,` do on macOS/Windows.
- **Self-update only supports a clean fast-forward** — if you've made local edits to the code, or your branch has diverged from `origin` for any other reason, "Update Now" will refuse rather than merge/rebase automatically. Commit, stash, or reset your changes first, then update.

## Troubleshooting

**"Native host has exited" / download does nothing:**
- **macOS, repo lives under `~/Downloads`/`~/Desktop`/`~/Documents`:** these are TCC-protected folders — macOS can silently block Chrome from *executing* `doi_host.py` out of one, with no prompt and no useful error. Move the whole repo somewhere else (e.g. `~/doi-extension`), update the `path` in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.doi_grabber.host.json` (or just re-run `./install.sh` from the new location), and fully restart Chrome. This is the most common cause if *every* native-host action fails identically (mirror health, download stats, updates, downloads — not just one feature).
- **macOS, quarantine flag:** check `doi_host.py` doesn't have a `com.apple.quarantine` extended attribute: `xattr -l native-host/doi_host.py`. If it does, `xattr -d com.apple.quarantine native-host/doi_host.py`.
- **Windows:** confirm `doi_host.bat`'s path in `com.doi_grabber.host.json` matches where you actually placed `native-host/`, and that either the `py` launcher or `python` is on your PATH (`py --version` or `python --version` in PowerShell).
- Make sure you fully restarted Chrome after installing/editing the native host, not just reloaded the extension.
- If you moved the extension's *own* folder (not just `native-host/`) to a new path, its ID changes too (unpacked extensions with no `"key"` in `manifest.json` get an ID derived from their absolute path) — you'll need to update `allowed_origins` in `com.doi_grabber.host.json` to the new ID as well.

**Download runs but fails immediately:**
- Check the Python interpreter set in Settings actually has `requests` and `beautifulsoup4` installed: `<your-python-path> -c "import requests, bs4"`.

**No DOI detected on a page that clearly has one:**
- Some publishers (SAGE was one) put author/title metadata in nonstandard places `content.js` may not check yet — file a bug report from Settings with the URL and what you'd expect it to detect.

**Popup shows the right DOI but every action button stays disabled:**
- The background availability check may still be running — give it a few seconds, or check `chrome://extensions` for a service worker error.

**"Check for Updates" / "Update Now" fails or says "native host unreachable":**
- Confirm `git` is installed and on the PATH the native host sees (it inherits Chrome's environment, which may differ from your Terminal's — try running `which git` from the same shell you'd normally use, and if it's in a nonstandard location, that's a real gap this feature doesn't currently work around).
- "Local changes exist in the repo checkout" means you (or a tool) edited a tracked file directly — run `git status` in the repo to see what, then commit or stash it before retrying.
- Confirm the checkout has a real `origin` remote pointed at this GitHub repo (`git remote -v` from the repo root) — this feature assumes a normal clone, not a folder of copied files.
