<img src="extension/icons/icon128.png" width="64" height="64" alt="DOI Grabber icon" />

# DOI Grabber

A Chrome extension (Manifest V3) that detects the DOI of the academic paper you're currently viewing, checks whether it's available on Sci-Hub (falling back to Unpaywall / open-access publisher copies when it isn't), and downloads it in one click via a local Python script running through a Native Messaging host. It also layers on a full set of Crossref-powered research tools: bulk-download an author's entire body of work, an entire journal issue, or an entire journal; see who a paper cites and who cites it; find similar papers; watch a journal or author for new releases; and more.

This is a **personal, single-machine tool** — it is not published on the Chrome Web Store (and can't be: the Sci-Hub integration is explicitly against Web Store policy) and isn't designed to be installed by strangers with zero setup. It's distributed here on GitHub so it can be version-controlled, backed up, and reinstalled on a new machine.

> ⚠️ **A note on legality.** This tool integrates with Sci-Hub, which operates in a legal gray area (or is outright illegal, depending on jurisdiction) because it mirrors copyrighted papers without publisher permission. Whether and how you use it is your own call to make and your own risk to bear. This project is shared for personal backup/portability purposes, not as an endorsement or as legal advice.

---

## Table of contents

- [What it does](#what-it-does)
- [Screenshots](#screenshots)
- [How it's built](#how-its-built)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [1. Load the Chrome extension](#1-load-the-chrome-extension)
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

## Screenshots

> Screenshots aren't included in this README yet — add your own here. Suggested shots:
>
> - `docs/screenshots/popup.png` — the toolbar popup on a detected paper
> - `docs/screenshots/popup-panels.png` — References/Cited By/Related Papers panels open
> - `docs/screenshots/options.png` — the Settings page
> - `docs/screenshots/author.png` — the "Download All Works" author page with the year histogram
> - `docs/screenshots/collaborators.png` — the Common Collaborators network graph
> - `docs/screenshots/journal-download.png` — the whole-journal batch download page
>
> Once added, reference them like:
> ```markdown
> ![Popup](docs/screenshots/popup.png)
> ```

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

The extension talks to the free **Crossref**, **OpenAlex**, and **Semantic Scholar** REST APIs directly (no key required for any of them) for metadata, references, citations, and recommendations — only the actual PDF-fetching goes through the native host.

## Prerequisites

- **macOS** with **Google Chrome** (or another Chromium-based browser that supports MV3 + Native Messaging, e.g. Brave/Edge — untested here, but should work)
- **Python 3** with the [`requests`](https://pypi.org/project/requests/) package installed
- Familiarity with `chrome://extensions` Developer Mode and running shell scripts from Terminal

## Installation

### 1. Load the Chrome extension

```bash
git clone https://github.com/materialcritic/doi-extension.git
cd doi-extension
```

1. Open Chrome and go to `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this repo's `extension/` folder.
4. Note the **Extension ID** shown on the card that appears — you'll need it in the next step.

### 2. Install the Native Messaging host

> **Important — do this from outside your Downloads folder.** macOS Gatekeeper attaches a quarantine flag to files that were downloaded through a browser (including `git clone`d into a `~/Downloads` subfolder in some setups, and definitely anything saved there via a browser). That quarantine flag silently blocks Chrome from executing `doi_host.py`, and the failure just looks like "native host has exited" with no clear reason. Move (or re-clone) the repo to a normal location first, e.g. `~/doi-extension`, before running the installer.

```bash
cd ~/doi-extension/native-host   # wherever you placed it, outside Downloads
./install.sh
```

The installer will:
- `chmod +x doi_host.py`
- Ask for the **Extension ID** from step 1
- Write `com.doi_grabber.host.json` (the Native Messaging manifest Chrome reads) to `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`, pointing at your `doi_host.py`

### 3. Point the extension at your Python setup

Open the extension's **Settings** page (right-click the toolbar icon → Options, or click the ⚙ in the popup) and fill in the **Connection** card:

| Field | What it is |
|---|---|
| **Output folder** | Where downloaded PDFs are saved. Leave blank to use `scihub_download.py`'s built-in default (`~/Downloads/autorename`). |
| **Python interpreter path** | Full path to a `python3` that has `requests` installed (e.g. `/opt/homebrew/bin/python3` for a Homebrew install on Apple Silicon). Chrome launches the native host with its own system `python3` by default, which usually lacks your packages — this field overrides that per-request, no source editing needed. |
| **Script path** | Full path to `scihub_download.py` (in this repo: `native-host/scihub_download.py`). Also overridable at runtime — no source editing needed. |
| **Sci-Hub mirrors** | One URL per line. Leave blank to use the script's built-in mirror list. |

A few settings are **not** exposed in the UI and are hardcoded directly in the Python files instead — edit these once if you're setting up on a new machine or a different path than the original author's:

- `native-host/doi_host.py`: `MIRROR_HEALTH_PATH`, `DOWNLOAD_LOG_PATH` (must point at wherever you keep `native-host/`)
- `native-host/scihub_download.py`: `MIRROR_HEALTH_PATH`, the download log path, and `UNPAYWALL_EMAIL` (Unpaywall's API asks for a real contact address in every request per their usage policy — put your own here, not the original author's)

### 4. Try it

1. Restart Chrome (Native Messaging hosts are only re-spawned on a fresh connection after a full restart, or a disable/re-enable of the extension — a plain "reload" of the extension is **not** enough after changing `doi_host.py` or `scihub_download.py`).
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
| **More by This Author** | Opens the [Download All Works](#more-by-this-author) page for the detected author. |
| **Download All Works** | Same as above. |
| **Common Collaborators** | Opens the [co-author network page](#common-collaborators) for the detected author. |
| **Download This Issue** | Opens the [issue download page](#download-this-issue) for the paper's volume/issue. |
| **QR Code** | Shows a scannable QR code (generated fully offline — nothing leaves your machine) linking to the article on Sci-Hub, for opening on your phone. |
| **References** | Lists the paper's references (via Crossref), each row clickable straight to Sci-Hub. |
| **Cited By** | Lists papers that cite this one (via Semantic Scholar). |
| **Related Papers** | Citation-graph-based recommendations (via Semantic Scholar's Recommendations API) — different from the keyword-based "Find Similar" on the full-page tools. |
| **Reveal in Finder** | Shown after a successful download — opens Finder with the file selected. |
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
- **Backup & Support**:
  - **Export Everything** — bundles your settings, watchlists, download history, and mirror health into a downloadable `.zip`
  - **Report a Bug/Feature Request** — see below

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
│   ├── com.doi_grabber.host.json  # Native Messaging manifest template (install.sh fills this in)
│   └── install.sh                  # Installer — registers the native host with Chrome
├── make_icons.py                   # One-off script that rendered the toolbar icon from SVG
└── SESSION_LOG.md                  # Full build history/design-decision log across every session
```

`SESSION_LOG.md` is worth a skim if you want the *why* behind a lot of these design choices — it documents every feature, bug, and dead-end across the project's build sessions in detail.

## Known limitations

- **Not portable out of the box.** A few paths (log file, mirror health file, Unpaywall contact email) are hardcoded in the Python files rather than read from settings — see [step 3 of installation](#3-point-the-extension-at-your-python-setup).
- **PhilPapers and Google Scholar can't be scraped** — both are permanently blocked (Cloudflare challenge and no free API, respectively). All author/paper search is Crossref-based instead.
- **Tandfonline and some other Cloudflare-protected publishers** return a bot-challenge page to any server-side fetch — their PDFs/abstracts can only be reached by a real browser tab, not the native host. The SAGE-specific "View Sage PDF" button works around this on the extension side; other publishers don't currently have an equivalent.
- **Crossref's author search is relevance-ranked, not a guaranteed-complete filter** — even at the 1,000-result cap, an extremely prolific author's most obscure works could theoretically be missed. There's no "everything by this ORCID" endpoint without a known ORCID iD.
- Requires **restarting Chrome** (not just reloading the extension) after any change to `doi_host.py` or `scihub_download.py`, since the native host is a separate long-lived process.

## Troubleshooting

**"Native host has exited" / download does nothing:**
- Check `doi_host.py` doesn't have a `com.apple.quarantine` extended attribute: `xattr -l native-host/doi_host.py`. If it does, `xattr -d com.apple.quarantine native-host/doi_host.py` (or make sure the whole repo lives outside `~/Downloads`).
- Make sure you fully restarted Chrome after installing/editing the native host, not just reloaded the extension.

**Download runs but fails immediately:**
- Check the Python interpreter set in Settings actually has `requests` installed: `<your-python-path> -c "import requests"`.

**No DOI detected on a page that clearly has one:**
- Some publishers (SAGE was one) put author/title metadata in nonstandard places `content.js` may not check yet — file a bug report from Settings with the URL and what you'd expect it to detect.

**Popup shows the right DOI but every action button stays disabled:**
- The background availability check may still be running — give it a few seconds, or check `chrome://extensions` for a service worker error.
