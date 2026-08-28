<img src="extension/icons/icon128.png" width="64" height="64" alt="DOI Grabber icon" />

# DOI Grabber

A Chrome extension (Manifest V3) that detects the DOI of the academic paper you're currently viewing, checks whether it's available on Sci-Hub (falling back to Unpaywall / open-access publisher copies when it isn't), and downloads it in one click via a local Python script running through a Native Messaging host. It also layers on a full set of Crossref-powered research tools: bulk-download an author's entire body of work, an entire journal issue, or an entire journal; see who a paper cites and who cites it; find similar papers; watch a journal or author for new releases; and more.

This is a **personal, single-machine tool** — it is not published on the Chrome Web Store (and can't be: the Sci-Hub integration is explicitly against Web Store policy) and isn't designed to be installed by strangers with zero setup. It's distributed here on GitHub so it can be version-controlled, backed up, and reinstalled on a new machine.

> ⚠️ **A note on legality.** This tool integrates with Sci-Hub, which operates in a legal gray area (or is outright illegal, depending on jurisdiction) because it mirrors copyrighted papers without publisher permission. Whether and how you use it is your own call to make and your own risk to bear. This project is shared for personal backup/portability purposes, not as an endorsement or as legal advice.

---

## Table of contents

- [What it does](#what-it-does)
- [Privacy](#privacy)
- [How it's built](#how-its-built)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [1. Clone the repo and load the Chrome extension](#1-clone-the-repo-and-load-the-chrome-extension)
  - [2. Install the Native Messaging host](#2-install-the-native-messaging-host)
  - [3. Point the extension at your Python setup](#3-point-the-extension-at-your-python-setup)
  - [4. Try it](#4-try-it)
- [Using the popup](#using-the-popup)
- [Address bar search (omnibox)](#address-bar-search-omnibox)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [The full-page tools](#the-full-page-tools)
  - [More by This Author](#more-by-this-author)
  - [Common Collaborators](#common-collaborators)
  - [Download This Issue](#download-this-issue)
  - [Download Entire Journal](#download-entire-journal)
  - [Similar Papers](#similar-papers)
  - [Author Network Map](#author-network-map)
  - [Citation Snowball Graph](#citation-snowball-graph)
  - [Scan Page for DOIs](#scan-page-for-dois)
  - [Trending in a Topic](#trending-in-a-topic)
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

On top of the single-paper flow, it also has full pages for **bulk-downloading** an author's entire output, an entire journal issue, or an entire journal; browsing a paper's **references** and **citations**; finding **similar/related papers**; **watching** a journal or author for new releases; mapping out a **collaboration network** starting from a group of authors; **scanning a whole page (or an open PDF) for every DOI it mentions** and bulk-downloading a checklist of them; and **exporting** your download history as a citation file (BibTeX/RIS) or a full settings/history backup.

## Privacy

Worth being upfront about, since this runs continuously in the background:

- **Every DOI the extension detects on a page you open is sent to Crossref** (and, for the "Cited By"/"Related Papers" popup panels, to Semantic Scholar; for abstracts, to OpenAlex; for a download attempt specifically, to Unpaywall as one of the fallback tiers) — that's how the availability badge and every metadata-backed feature work. In effect, that's a continuous disclosure of which academic papers you're looking at to those third parties, the same way any "look this up automatically" browser feature works. None of this is configurable off short of not using the extension; the trade-off is the whole point of the automatic badge.
- **Content scripts run on every `http(s)://` page you visit** (`content.js`/`logger.js`/`redact.js`, per `manifest.json`'s broad `matches` pattern), not just recognized academic sites — this is what makes the automatic DOI detection and badge possible without you having to invoke the extension by hand on each page, but it does mean the extension's code executes in the context of every page you load, including ones unrelated to research (`host_permissions`, in contrast, is narrowly scoped to five specific API hosts — the extension can't just fetch arbitrary URLs from those content scripts).
- **Diagnostic logging** (Settings → Diagnostics & Logs) records actions and errors locally in `chrome.storage.local` and `debug_log.txt` — never sent anywhere automatically, only read if you click Export Log. URLs and filesystem paths are redacted before being written (query strings/fragments stripped from URLs, the OS account name masked in paths) so an exported log is reasonably safe to attach to a bug report, but "reasonably safe" isn't a guarantee of zero sensitive content — skim an export yourself before sharing it if you're not sure what a given page's URL might have contained.
- **The native host can read, write, and delete files on your machine** (gated by Chrome's Native Messaging `allowed_origins`, which pins it to only this one specific extension ID, plus its own path/interpreter validation — see `SECURITY.md`) — that's how downloading, reveal-in-Finder, and the corrupt-file cleanup button work.
- **Nothing here is sent to the extension's author** — there's no telemetry, no analytics, no phone-home of any kind. The only outbound traffic is what's described above (Crossref/OpenAlex/Semantic Scholar/Unpaywall for metadata, Sci-Hub mirrors for the actual PDF), plus whatever you explicitly trigger yourself (opening a Google search, submitting a bug report).

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

No prior experience with Terminal, git, or Python required — every command below is given to you exactly, so you can just copy, paste, and press Enter. Pick your platform and work through it top to bottom before moving on to [Installation](#installation).

<details open>
<summary><strong>macOS</strong></summary>

1. **Google Chrome** — [download here](https://www.google.com/chrome/) if you don't already have it.
2. **Terminal** — already on every Mac, nothing to install. Open it by pressing `⌘ Space`, typing `Terminal`, and pressing Enter. This is where you'll paste commands throughout setup — it's just a text-based way to tell your computer what to do.
3. **git** — check whether you already have it. In Terminal, paste this and press Enter:
   ```bash
   git --version
   ```
   - If you see something like `git version 2.39.2`, you're done with this step.
   - If a popup instead appears asking to install "Command Line Developer Tools," click **Install**, wait a few minutes for it to finish, then run the command above again to confirm.
4. **Python 3** — check whether you already have it:
   ```bash
   python3 --version
   ```
   - If you see `Python 3.x.x`, you're set.
   - If you get `command not found`, install it from [python.org/downloads](https://www.python.org/downloads/) — download the macOS installer and click through it with the default options — then run the command above again to confirm.
5. Install the two Python packages this tool needs by pasting into Terminal:
   ```bash
   pip3 install requests beautifulsoup4
   ```
   You should see a "Successfully installed…" message at the end.
6. *(Optional — only needed for [Scan Page for DOIs](#scan-page-for-dois)'s PDF support)* Install `pypdf`:
   ```bash
   pip3 install pypdf
   ```
   Everything else works fine without this — it's only used to read the text out of a PDF opened directly in Chrome. Skip it if you don't plan to use that feature on PDFs; you can always come back and install it later.

</details>

<details>
<summary><strong>Windows</strong></summary>

1. **Google Chrome** — [download here](https://www.google.com/chrome/) if you don't already have it.
2. **PowerShell** — already on every Windows machine, nothing to install. Open it by clicking the **Start** menu, typing `PowerShell`, and pressing Enter. This is where you'll paste commands throughout setup.
3. **git** — check whether you already have it. In PowerShell, paste this and press Enter:
   ```powershell
   git --version
   ```
   - If you see something like `git version 2.43.0.windows.1`, you're done with this step.
   - If you get an error, download the installer from [git-scm.com/download/win](https://git-scm.com/download/win), run it, and click **Next** through every screen leaving the defaults as they are. Then close and reopen PowerShell and run the command above again to confirm.
4. **Python 3** — check whether you already have it:
   ```powershell
   py --version
   ```
   - If you see `Python 3.x.x`, you're set.
   - If not, download the installer from [python.org/downloads](https://www.python.org/downloads/windows/) and run it. **On the very first screen, tick the checkbox at the bottom that says "Add python.exe to PATH" before clicking "Install Now"** — this is the single most common thing people miss, and skipping it means Windows won't be able to find Python later. Once it finishes, close and reopen PowerShell and run the command above again to confirm.
5. Install the two Python packages this tool needs by pasting into PowerShell:
   ```powershell
   py -m pip install requests beautifulsoup4
   ```
   You should see a "Successfully installed…" message at the end.
6. *(Optional — only needed for [Scan Page for DOIs](#scan-page-for-dois)'s PDF support)* Install `pypdf`:
   ```powershell
   py -m pip install pypdf
   ```
   Everything else works fine without this — it's only used to read the text out of a PDF opened directly in Chrome. Skip it if you don't plan to use that feature on PDFs; you can always come back and install it later.

</details>

That's everything you need before starting — the extension and native host auto-detect the rest (log file locations, which Python to use, a default download folder), so nothing else needs configuring up front.

## Installation

Four steps: download the code, load it into Chrome, connect Chrome to the Python script, then try a download. Work through them in order — each one builds on the last.

### 1. Clone the repo and load the Chrome extension

"Cloning" just means downloading a copy of this project onto your computer in a way that can pull future updates automatically later (see [Keeping it up to date](#keeping-it-up-to-date)).

> ⚠️ **Use `git clone` (below), not GitHub's green "Code → Download ZIP" button.** A zip download has no hidden `.git` folder, which silently breaks the extension's [self-update feature](#keeping-it-up-to-date) later — and zip extraction sometimes produces a confusingly doubled folder (e.g. `doi-extension-main\doi-extension-main`) or a file that didn't extract completely, which can look like a broken installer script when the real problem is just how it got onto your machine. The `git clone` commands below are the only supported install path.

> ⚠️ **On macOS, don't put this inside `~/Downloads`, `~/Desktop`, or `~/Documents`.** macOS has a security feature that can silently block Chrome from running the helper script if it lives in one of those three folders — with no error message explaining why, just a confusing "native host has exited." Following the steps below (which clone straight into your Home folder) avoids this entirely, so there's nothing extra you need to do — just don't manually move the folder into Downloads/Desktop/Documents afterward.

> ⚠️ **On Windows, don't put this inside a OneDrive-synced folder.** If your Desktop or Documents shows a little cloud icon on files in File Explorer, OneDrive is syncing it (common on work/school PCs, and some personal ones too, via a feature called "Known Folder Move"). OneDrive can leave a file as a not-fully-downloaded placeholder that other programs read before it's actually finished syncing — which can make a perfectly fine script look corrupted (e.g. a confusing PowerShell "missing closing brace" parse error) even though nothing is actually wrong with it. Cloning straight into your home folder as the steps below do (`cd ~`) avoids this — `C:\Users\yourname\` itself is normally not OneDrive-synced even when Desktop/Documents are.

<details open>
<summary><strong>macOS</strong></summary>

1. Open **Terminal** (`⌘ Space`, type `Terminal`, Enter).
2. Paste each of these three lines in, pressing Enter after each one before typing the next:
   ```bash
   cd ~
   git clone https://github.com/materialcritic/doi-extension.git
   cd doi-extension
   ```
   *(`cd ~` moves you to your Home folder; `git clone` downloads the project into a new `doi-extension` folder there; `cd doi-extension` moves you into it.)*
3. **Checkpoint:** type `pwd` and press Enter — it should print something ending in `/doi-extension`, e.g. `/Users/yourname/doi-extension`. If it does, you're good to continue.

</details>

<details>
<summary><strong>Windows</strong></summary>

1. Open **PowerShell** (Start menu → type `PowerShell` → Enter).
2. Paste each of these three lines in, pressing Enter after each one before typing the next:
   ```powershell
   cd ~
   git clone https://github.com/materialcritic/doi-extension.git
   cd doi-extension
   ```
3. **Checkpoint:** type `pwd` and press Enter — it should print something ending in `\doi-extension`, e.g. `C:\Users\yourname\doi-extension`. If it does, you're good to continue.

</details>

Now load the extension into Chrome (same on both platforms):

4. Open Chrome and go to `chrome://extensions` (paste that into the address bar and press Enter — it's a special internal page, not a website).
5. In the top-right corner of that page, click the **Developer mode** toggle to turn it on. (A few new buttons will appear on the left — this is expected.)
6. Click **Load unpacked**.
7. A file picker opens. Navigate into the `doi-extension` folder you just created, then select the **`extension`** subfolder inside it (select the folder itself, don't open it), and click **Select Folder** (Windows) / **Open** (macOS).
8. A card titled "DOI Grabber" should now appear on the extensions page. **Write down the Extension ID** shown on that card — a long string of lowercase letters (e.g. `laggaiemaddbjjfckfbmlhkcaanfnlim`) — you'll need to paste it into the next step.

### 2. Install the Native Messaging host

This step is what lets Chrome hand a DOI off to the Python script that actually finds and downloads the PDF. It only needs to be run once.

<details open>
<summary><strong>macOS / Linux</strong></summary>

1. Back in the same Terminal window (still inside the `doi-extension` folder), run:
   ```bash
   cd native-host
   ./install.sh
   ```
2. It will ask you to paste in the **Extension ID** from step 1 — paste it in and press Enter.
3. You should see a short confirmation message and be back at the prompt — that's it, nothing else to do here.

If a later download fails with "native host has exited," see [Troubleshooting](#troubleshooting) — the most common cause is the repo ending up inside `~/Downloads`/`~/Desktop`/`~/Documents` (the callout above explains why, and how to fix it by moving the folder).

</details>

<details>
<summary><strong>Windows</strong></summary>

1. Back in the same PowerShell window (still inside the `doi-extension` folder), run:
   ```powershell
   cd native-host
   .\install.ps1
   ```
2. **If you see a red error mentioning "execution policy" or "running scripts is disabled"** — this is Windows being cautious about running a script it doesn't recognize yet, not a real problem. Paste in this line (it only relaxes the restriction for this one PowerShell window, just this once), press Enter, then run `.\install.ps1` again:
   ```powershell
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   ```
3. It will ask you to paste in the **Extension ID** from step 1 — paste it in and press Enter.
4. You should see a short confirmation message and be back at the prompt.

> **Note:** Windows support has had real hands-on testing (several genuine bugs were found and fixed this way — a PowerShell 5.1 parsing issue from non-ASCII characters, the Python interpreter auto-detect missing the `py` launcher's actual install locations, a hang caused by the `py` launcher being a wrapper process), but it's still less battle-tested than the macOS path overall. If anything here doesn't match what you see, please [file a bug report](#reporting-a-bug-or-requesting-a-feature) with the exact error message — that's the fastest way to get it fixed for the next person.

</details>

### 3. Point the extension at your Python setup

For most people, this step can be **skipped entirely** — the extension auto-detects a working Python install. Only come back to this if [step 4](#4-try-it) doesn't work and the troubleshooting section points you here.

If you do need it: open the extension's **Settings** page (right-click the toolbar icon in Chrome → **Options**, or click the ⚙ inside the popup) and fill in the **Connection** card:

| Field | What it is |
|---|---|
| **Output folder** | Where downloaded PDFs are saved. Leave blank to use the default (`~/Downloads/autorename` on macOS/Linux, `%USERPROFILE%\Downloads\autorename` on Windows). |
| **Python interpreter path** | Full path to a `python3`/`python` that has `requests` and `beautifulsoup4` installed. To find yours: macOS/Linux Terminal, run `which python3`; Windows PowerShell, run `(Get-Command py).Source`. Paste whatever path that prints in here. |
| **Script path** | Full path to `scihub_download.py` (inside this repo at `native-host/scihub_download.py`). |
| **Sci-Hub mirrors** | One URL per line. Leave blank to use the script's built-in mirror list. |
| **Unpaywall contact email** | Sent with every Unpaywall API request, per their usage policy (just how they'd reach you if the API were being misused — not a login). Leave blank to use the built-in default. |

The Unpaywall email is the one field worth filling in even if nothing's broken — it's a real usage-policy requirement, and the built-in default is the maintainer's own address, not a placeholder.

### 4. Try it

1. **Fully quit and reopen Chrome** — not just close the window, actually quit the application (macOS: `⌘Q` or Chrome menu → Quit Chrome; Windows: close every Chrome window, then check it's not still running in the system tray). This step only needs doing once, right after install — Chrome only picks up the native host on a fresh start, a plain page reload isn't enough.
2. Visit any academic paper's page — try pasting `https://doi.org/10.1038/nphys1170` into the address bar, or any journal article page you'd normally read.
3. Click the DOI Grabber toolbar icon (top-right of Chrome, may be tucked under the puzzle-piece icon — click that, then the pin icon next to DOI Grabber to keep it visible). If a DOI was detected on the page, you'll see it in the popup and the **Download** button will be enabled.
4. Click **Download** and watch the live log scroll as it races mirrors and saves the file. When it finishes, a **Reveal in Finder** (macOS) / **Open File Explorer** (Windows) button appears — click it to see the PDF.

If anything above didn't go as described, jump to [Troubleshooting](#troubleshooting) — it's organized by symptom.

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
| **References** | Lists the paper's references (via Crossref), each row clickable straight to its DOI page (redirects to whichever publisher/journal hosts it). |
| **Cited By** | Lists papers that cite this one (via Semantic Scholar), each row clickable straight to its DOI page. |
| **Related Papers** | Citation-graph-based recommendations (via Semantic Scholar's Recommendations API) — different from the keyword-based "Find Similar" on the full-page tools. Each row also opens straight to its DOI page. |
| **Scan Page for DOIs** | Opens the [Scan Page for DOIs](#scan-page-for-dois) results page for the current tab — always enabled, doesn't require a DOI to have been detected on the page. Also reachable by right-clicking anywhere on a page and choosing **"Scan Page for DOIs."** |
| **Reveal in Finder** | Shown after a successful download — opens Finder (macOS) or File Explorer (Windows) with the file selected. |
| **Delete Corrupt File** | Shown if the download failed the PDF-header check (usually means a mirror served an HTML error page instead of a real PDF). |
| **Search Google Instead** | Opens a Google search for `<title> <author>` — always available, not just when unavailable. |
| ⚙ (top right) | Opens Settings. |
| ☀/🌙 (top right) | Quick-toggles between your last-picked light theme and Dark. |

## Address bar search (omnibox)

Type `doi` then <kbd>Space</kbd> in Chrome's address bar, then a paper's title, author, or a raw DOI, to search and download without visiting the paper's page at all:

- Suggestions come from a live Crossref search (`query.bibliographic`) as you type, each showing the title plus a dimmed line of author/journal/year and — when Crossref has one — a snippet of the abstract.
- Pasting or typing a DOI directly (instead of a title search) skips the Crossref lookup and offers a direct "Download DOI …" suggestion.
- Pressing <kbd>Enter</kbd> on a suggestion (or on a freeform DOI/title with no suggestion picked) routes straight into the same `downloadDOI()` path as the toolbar button and <kbd>⌥D</kbd> — Sci-Hub → Unpaywall → publisher-page fallback, unchanged.

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

Same underlying author search, but tallies co-author frequency into a ranked list (excluding the target author themselves), each linking to that person's own author page. A radial network graph — the target author in the center, their top 20 collaborators arranged around them, with lines to collaborators who also worked together directly — is shown open by default above the list; use **"Hide Network Graph"** to collapse it if you just want the list. (Also reachable from the "Common Collaborators" button on the [Download All Works](#more-by-this-author) page's own header, next to Google Scholar/Institutional Website — not just from the popup.)

This is a single-author view. To map out how a *group* of people connect to each other — not just one person's own collaborators — see [Author Network Map](#author-network-map).

### Download This Issue

Given any paper, resolves its journal/volume/issue via Crossref and lists every article in that issue with the same batch-download UI as the author page (checklist, skip-already-downloaded, retry-failed, progress bar). Every listed author's name is clickable, opening their own [Download All Works](#more-by-this-author) page. Also supports:
- **Batch Download Multiple Issues** — a volume range (up to 50) at a fixed issue number
- **Search This Journal** — keyword search scoped to just this journal, with sortable/paginated results and a "Download All Matches" button
- **Watch This Journal** — notifies you when a new issue appears (checked every 6 hours)
- Pause/Resume + Cancel controls for any running batch

### Download Entire Journal

Opens its own tab (since walking an entire journal can mean thousands of articles). Fetches every issue via deep Crossref pagination, groups them into collapsible per-issue cards, and lets you review the full list — with per-article remove buttons — before clicking **Start**. Live per-row status (Pending → Downloading… → ✓/Failed/Corrupt) plus a sticky Pause/Cancel toolbar and overall progress bar. Gated behind a confirmation dialog since it can run for a very long time.

### Similar Papers

A **"Find Similar"** link next to any paper's title (on the author/issue/journal pages) does lightweight keyword extraction from its abstract (or title, if no abstract) and opens a new results page built on Crossref's bibliographic search — using the same batch-download UI as everywhere else. Results can chain into further similarity searches. Author names here are clickable too, same as on the issue page.

### Author Network Map

Opened via Settings → **Tools** → **Open Author Network Map** (its own tab, not launched from the popup). Start from **two or more** seed author names; the map immediately pulls in each seed's direct collaborators from Crossref and lays them out in concentric rings by hop distance from the seeds. From there:

- **Click-to-expand** — any dashed (unexpanded) node pulls in *its* collaborators too (up to 15, by shared works) when clicked, growing the map outward one hop at a time under your control rather than an expensive automatic multi-hop crawl. A solid green ring means a node's already been expanded. Two seeds who share a collaborator collapse into one shared node, not a duplicate.
- **Node size = real prominence, not graph position** — sized and ranked by the person's actual OpenAlex citation count, not by how many edges they happen to have in the current map, so a major author renders large immediately even before anyone's expanded them, and a node's size doesn't shift just because you expanded somewhere else. Hover any node for the exact citation/works-count figures plus how many shared works connect them *within this map*.
- **Highlight the path between two people** — pick two names and click "Highlight Path" to see the shortest route connecting them through the map, with a hop-count readout. Reports plainly if they aren't connected yet.
- **Click an edge to see the actual shared papers** — not just a count. Opens a panel listing title/year/DOI for every paper two connected people co-authored, each with its own Download button (wired into the same download flow as everywhere else), saved to a dedicated subfolder.
- **Search and focus** — a search box jumps to and highlights a person by name; focus mode fades everything more than N hops from a chosen person, for orienting yourself in a large map.
- **Zoomable and pannable** — `+`/`−` buttons, "Fit to View," Ctrl/⌘+scroll or trackpad pinch to zoom (cursor-anchored), click-and-drag to pan.
- The whole map autosaves as you build it and resumes where you left off next time you open the page; **"Start New Map"** clears it.

Same name-based-matching caveat as the rest of the extension's author tools — Crossref/OpenAlex name search can conflate two different real people who share a name, especially common ones.

### Citation Snowball Graph

Reached from Settings → **Citation Snowballing** (not the popup). Give it a seed DOI and it does a breadth-first "snowball" walk of the citation graph:

- **Direction** — Backward walks the seed's own references (via Crossref), Forward walks papers that cite it (via OpenAlex, top-k by citation count), Both does both.
- **Depth** — up to 4 hops out from the seed.
- **Per-level cap** and **Max papers** — bound fan-out per node and the total walk size; forward citations explode fast, so the max-papers ceiling is what actually stops a deep forward run.
- Every paper is deduped by DOI across the *whole* graph, not just per-level — a paper reached by several paths is only fetched once, and the results summary reports how many such convergences ("duplicates merged") happened.
- Results list each paper's title, author, hop, and direction, with **Download all**, **Copy DOIs**, and **View as graph** buttons. **Reset** clears the form (and cancels an in-progress run) so a new seed DOI can be run without reloading the page.

**View as graph** opens a dedicated tab (`graph.html`) rendering the walk as a pannable, zoomable node graph: the seed centered, references fanning left (teal), citations fanning right (coral), edges drawn between them including the convergence edges dedup would otherwise hide. Each node shows the paper's title and author (backward/Crossref nodes that come back title-less are batch-enriched from OpenAlex afterward); hovering a node shows the full title/author plus its abstract, lazily fetched and cached per DOI the moment you hover it — nothing is fetched for papers you never look at. Clicking a node (a real click, not a drag) opens that paper's `doi.org` page in a new tab. The graph has its own **Direction**/**Depth** filter bar that narrows what's currently drawn — this filters the graph already sitting in memory, it never re-runs the walk — and follows the extension's active color theme like every other page.

### Scan Page for DOIs

Reached from the popup's **Scan Page for DOIs** row (Explore tab — always enabled, no DOI needs to be detected first) or by right-clicking anywhere on a page and choosing **"Scan Page for DOIs"** from the context menu. Finds *every* DOI-shaped string on the current tab — not just the page's own "primary" paper — and opens a results page listing each one with its title/author/journal/year (backfilled from Crossref) so you can pick which ones to download, the same checklist-and-batch pattern as [Download This Issue](#download-this-issue).

- **Regular web pages** are scanned client-side: visible page text, every `doi.org`/Sci-Hub-style link, and any meta tag mentioning "doi" (not just the primary `citation_doi`). Handy for a references/bibliography page, a table of contents, or any page listing several papers at once.
- **A PDF opened directly in Chrome** (a URL ending in `.pdf`) is handled differently: Chrome's built-in PDF viewer has no readable DOM a content script could scan, so the native host downloads the actual PDF file and extracts its text server-side (needs the optional `pypdf` package — see [Prerequisites](#prerequisites)) to scan for DOIs there instead.
- Each row has a checkbox (checked by default), so you control exactly which DOIs actually get downloaded — same **Select All** / **Select None** / pause / cancel / progress-bar machinery as the other bulk-download pages, into their own `Page Scan - <page title> (<date>)` subfolder and log.
- A DOI that Crossref can't find at all is flagged with a warning and **unchecked by default** rather than assumed downloadable — most commonly this means a PDF-text-extraction artifact truncated it (see [Known limitations](#known-limitations)), though very rarely it's just a real DOI Crossref hasn't indexed yet. You can still check it by hand if you want to try downloading it anyway.
- Click any row's title to lazily fetch and show its abstract, same as the other bulk-download pages.

### Trending in a Topic

Reached from Settings → **Trending in a Topic** (its own tab, `trending.html`). Enter a topic (matched to an OpenAlex topic ID via a live search-as-you-type) and get a ranked list of recently-published papers in it — ranked by **citation velocity** (citations ÷ months since publication) by default, not raw citation count, so it surfaces work that's picking up attention *now* rather than all-time classics. A noise floor (papers younger than ~3 weeks, or with fewer than 3 citations) keeps a brand-new paper with 2 lucky citations from topping the list on a small-sample fluke.

- **Window** (6/12/24 months) and **Rank by** (velocity / recent momentum / total citations) controls re-sort the same fetched pool instantly, without re-querying.
- Downloads use the same batch machinery as every other bulk-download page — checklist, pause/cancel, progress bar, retry-failed.
- **Follow This Topic** works like the Journal/Author watchlists: checks every 6 hours, notifies when a new paper enters the top 10 by velocity, opens straight to this page on click.

## Settings page

Right-click the toolbar icon → **Options** (or click ⚙ in the popup):

- **Appearance** — 6 color themes: Dark (default), Warm Parchment, Cool Slate, Soft Sage, Pure Minimal, Carrot
- **Tools** — **Open Author Network Map**; see [Author Network Map](#author-network-map)
- **Connection** — output folder, Python interpreter path, script path, Sci-Hub mirror list, Unpaywall contact email (see [Installation](#3-point-the-extension-at-your-python-setup))
- **Keyboard Shortcuts** — read-only view of the current Alt+D/Alt+F bindings, with a link to Chrome's remap page
- **Popup Shortcuts** — reassign any of the single-key popup shortcuts
- **Journal Watchlist** / **Author Watchlist** / **Topic Watchlist** — manage what you're currently watching, with a manual "Check Now" (Topic Watchlist is followed from [Trending in a Topic](#trending-in-a-topic)'s own page, not added directly here)
- **Download Stats** — total-ever / last-7-weeks / last-7-months / last-year download counts
- **Paper of the Day** — a deterministic daily pick from your download history, with a "Show Another" button and a collapsible "Previously shown" history (with a Clear History button)
- **Mirror Health** — per-mirror fail count, cooldown countdown, and a latency sparkline; per-mirror or global reset
- **Updates** — check for and install new versions from GitHub; see [Keeping it up to date](#keeping-it-up-to-date)
- **Backup & Support**:
  - **Export Everything** — bundles your settings, watchlists, download history, and mirror health into a downloadable `.zip`
  - **Import Backup** — restores settings, watchlists, download history, and mirror health from a zip created by Export Everything. Overwrites your current state, so use with care.
  - **Report a Bug/Feature Request** — see below
- **Diagnostics & Logs** — every action and error, logged locally (see [Privacy](#privacy)); **Export Log** bundles it with the native host's own log and basic environment info (extension version, Chrome UA, platform, theme) into a `.zip` for a bug report; **Clear Log** wipes both sides.
- **Citation Export** — builds a BibTeX or RIS file covering every paper you've successfully downloaded, with metadata fetched fresh from Crossref per paper (title/author/journal/year), for importing into Zotero, Mendeley, or another reference manager. Can take a while for a large library, since it's one lookup per paper.
- **Citation Snowballing** — walk a seed paper's references and/or citations out several hops and browse the result as an interactive graph; see [Citation Snowball Graph](#citation-snowball-graph)

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
│   ├── network.html / network.js  # "Author Network Map" page
│   ├── graph.html / graph.js      # "Citation Snowball Graph" page (opened from Settings)
│   ├── snowball.html / snowball.js # Citation Snowballing run/results page (opens graph.html for the graph view)
│   ├── trending.html / trending.js # "Trending in a Topic" page (opened from Settings)
│   ├── page-scan.html/.js         # "Scan Page for DOIs" results page
│   ├── report.html / report.js    # Bug/feature report form
│   ├── theme.js                   # Shared 6-palette color theme system
│   ├── shortcuts.js                # Shared popup-shortcut definitions
│   ├── keywords.js                 # Shared keyword-extraction for "Find Similar"
│   ├── logger.js                   # Shared diagnostic-logging client, loaded on every page + as a content script
│   ├── redact.js                   # Shared log/URL/path redaction (usernames, query strings) before anything is persisted
│   ├── path-utils.js               # Shared sanitizeFolderName()/joinOutputPath() for every bulk-download page
│   ├── scihub-fullscreen.js       # Content script: auto-expands the PDF viewer on Sci-Hub mirrors
│   ├── vendor/qrcode.js           # Vendored offline QR encoder
│   ├── vendor/zipwriter.js        # Vendored zero-dependency ZIP reader/writer (Export Everything / Import Backup)
│   └── icons/                     # Toolbar icon (16/48/128px)
├── native-host/
│   ├── doi_host.py                 # Native Messaging host — spawns scihub_download.py, streams
│   │                               #   progress, handles reveal/delete/mirror-health/export actions
│   ├── scihub_download.py         # The actual DOI → PDF downloader (Sci-Hub/Unpaywall/publisher)
│   ├── requirements.txt           # requests/beautifulsoup4 (required); pypdf (optional — see Prerequisites)
│   ├── tests/                     # pytest coverage for doi_host.py's pure functions (path/interpreter
│   │                               #   validation, the native-message size guard, month arithmetic, etc.)
│   ├── com.doi_grabber.host.json.template  # Native Messaging manifest template — install.sh/install.ps1
│   │                               #   fill this in and write the real one OUTSIDE this checkout, never here
│   ├── install.sh                  # Installer for macOS/Linux — registers the native host with Chrome
│   ├── install.ps1                 # Installer for Windows — same, via the Windows Registry
│   └── doi_host.bat                # Windows wrapper so Chrome can spawn doi_host.py as an executable
├── .github/workflows/ci.yml       # Compile/syntax/test checks on every push, plus a regression guard for
│                                   #   the install.ps1 tracked-file bug documented in Known limitations
├── SECURITY.md                     # How this tool touches your filesystem, and how to report a vulnerability
└── ...
```

## Known limitations

- **PhilPapers and Google Scholar can't be scraped** — both are permanently blocked (Cloudflare challenge and no free API, respectively). All author/paper search is Crossref-based instead.
- **Tandfonline and some other Cloudflare-protected publishers** return a bot-challenge page to any server-side fetch — their PDFs/abstracts can only be reached by a real browser tab, not the native host. The SAGE-specific "View Sage PDF" button works around this on the extension side; other publishers don't currently have an equivalent.
- **Crossref's author search is relevance-ranked, not a guaranteed-complete filter** — even at the 1,000-result cap, an extremely prolific author's most obscure works could theoretically be missed. There's no "everything by this ORCID" endpoint without a known ORCID iD.
- Requires **restarting Chrome** (not just reloading the extension) after any change to `doi_host.py` or `scihub_download.py`, since the native host is a separate long-lived process.
- **Windows support has had several rounds of real hands-on testing** (genuine bugs found and fixed as a result — see the note in [step 2 of installation](#2-install-the-native-messaging-host)), but is still less battle-tested than the macOS path overall.
- On Linux, "Reveal in Finder" falls back to just opening the containing folder (via `xdg-open`) rather than selecting the file within it — there's no single standard way to select a specific file across Linux file managers the way `open -R`/`explorer /select,` do on macOS/Windows.
- **Self-update only supports a clean fast-forward** — if you've made local edits to the code, or your branch has diverged from `origin` for any other reason, "Update Now" will refuse rather than merge/rebase automatically. Commit, stash, or reset your changes first, then update.
- **Scan Page for DOIs on a PDF can come back with truncated DOIs on some PDFs** — confirmed live against a real PLOS ONE article: `pypdf`'s text extraction occasionally injects a stray space or newline in the middle of a word (a font/kerning quirk affecting the whole document's text, not something specific to DOIs), which can chop a DOI short (e.g. `10.1371/journal.pone.0270949` coming back as `10.1371/j`). Not silently guessed at — a DOI Crossref can't find at all is flagged and left unchecked by default, but a real DOI could in principle also get a false "not found" flag this way. Only ever affects the PDF path, not regular web pages.
- **Scan Page for DOIs only detects a PDF tab by its URL ending in `.pdf`** — a PDF served without that extension (uncommon, but it happens) is instead scanned like a regular web page, which will find nothing since Chrome's PDF viewer has no readable page text for a content script to see.
- **The configured Unpaywall/Crossref contact email is only sent on the highest-volume Crossref calls** (References, Scan Page for DOIs, Paper of the Day, Citation Export, and Citation Snowballing) for Crossref's better-rate-limit "polite pool" — not yet threaded through every single Crossref call in the codebase (a handful of one-off lookups, like author searches and the omnibox, still call Crossref anonymously). Those calls all still work fine either way; this only affects how generously Crossref rate-limits them.

## Troubleshooting

**Windows: `install.ps1` fails with `ParserError: MissingEndCurlyBrace` / "Missing closing '}' in statement block":**
- This was a real bug, fixed in this repo — if you see it, you're running a copy from before the fix. Run `git pull` in the repo root (or re-clone) to get the corrected `install.ps1`, then run `.\install.ps1` again.
- Root cause, for context: the old script had a few decorative em-dash/box-drawing characters in comments and an error message. Legacy Windows PowerShell 5.1 (the default "Windows PowerShell" console, not PowerShell 7) has no reliable way to detect a script's encoding without a BOM, and on some systems misreads those characters badly enough to break string/brace parsing elsewhere in the file — even though the script logic itself was correct. Any future edits to `install.ps1` should stick to plain ASCII to avoid reintroducing this.

**"Native host has exited" / download does nothing:**
- **macOS, repo lives under `~/Downloads`/`~/Desktop`/`~/Documents`:** these are TCC-protected folders — macOS can silently block Chrome from *executing* `doi_host.py` out of one, with no prompt and no useful error. Move the whole repo somewhere else (e.g. `~/doi-extension`), update the `path` in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.doi_grabber.host.json` (or just re-run `./install.sh` from the new location), and fully restart Chrome. This is the most common cause if *every* native-host action fails identically (mirror health, download stats, updates, downloads — not just one feature).
- **macOS, quarantine flag:** check `doi_host.py` doesn't have a `com.apple.quarantine` extended attribute: `xattr -l native-host/doi_host.py`. If it does, `xattr -d com.apple.quarantine native-host/doi_host.py`.
- **Windows:** the generated manifest lives at `%LOCALAPPDATA%\doi-grabber\com.doi_grabber.host.json` (not inside the repo checkout) — confirm `doi_host.bat`'s `path` value there matches where you actually placed `native-host/`, and that either the `py` launcher or `python` is on your PATH (`py --version` or `python --version` in PowerShell). If you installed before this path changed, re-run `.\install.ps1` once to regenerate it in the new location.
- Make sure you fully restarted Chrome after installing/editing the native host, not just reloaded the extension.
- If you moved the extension's *own* folder (not just `native-host/`) to a new path, its ID changes too (unpacked extensions with no `"key"` in `manifest.json` get an ID derived from their absolute path) — you'll need to update `allowed_origins` in `com.doi_grabber.host.json` to the new ID as well.

**Download runs but fails immediately with `ModuleNotFoundError: No module named 'requests'`:**
- Chrome spawned a Python interpreter that doesn't have `requests`/`beautifulsoup4` installed — usually because more than one Python is installed and the native host auto-detected the wrong one. Fix either way:
  - Install the packages for whichever interpreter you actually want used: `python -m pip install requests beautifulsoup4` (or `py -m pip install requests beautifulsoup4` on Windows).
  - Or explicitly set **Settings → Python interpreter path** to the full path of a `python`/`python.exe` that already has them — this always overrides auto-detection. Find candidates on Windows with `py -0`; check one has the packages with `<path> -c "import requests, bs4"`.
- On Windows specifically, the auto-detect (`find_python_with_requests()` in `doi_host.py`) checks PATH, the `py` launcher (`py -3`), and the standard python.org/Microsoft Store install locations — but an unusual install location (e.g. a custom drive/folder, or a venv) can still fall outside all of those, landing on some other interpreter without the packages. Setting the Python interpreter path in Settings is the reliable fix in that case.
- More generally, check the Python interpreter set in Settings actually has `requests` and `beautifulsoup4` installed: `<your-python-path> -c "import requests, bs4"`.

**"Scan Page for DOIs" on a PDF fails with something like "PDF scanning needs the 'pypdf' package":**
- This is the one dependency that isn't installed by the main setup steps, since it's only needed for scanning PDFs opened directly in Chrome (a regular web page doesn't need it). Install it for whichever Python interpreter the native host is using: `python3 -m pip install pypdf` (or `py -m pip install pypdf` on Windows) — see [Prerequisites](#prerequisites).

**No DOI detected on a page that clearly has one:**
- Some publishers (SAGE was one) put author/title metadata in nonstandard places `content.js` may not check yet — file a bug report from Settings with the URL and what you'd expect it to detect.

**Popup shows the right DOI but every action button stays disabled:**
- The background availability check may still be running — give it a few seconds, or check `chrome://extensions` for a service worker error.

**"Check for Updates" / "Update Now" fails or says "native host unreachable":**
- Confirm `git` is installed and on the PATH the native host sees (it inherits Chrome's environment, which may differ from your Terminal's — try running `which git` from the same shell you'd normally use, and if it's in a nonstandard location, that's a real gap this feature doesn't currently work around).
- "Local changes exist in the repo checkout" means you (or a tool) edited a tracked file directly — run `git status` in the repo to see what, then commit or stash it before retrying.
- Confirm the checkout has a real `origin` remote pointed at this GitHub repo (`git remote -v` from the repo root) — this feature assumes a normal clone, not a folder of copied files.
