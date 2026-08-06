#!/usr/bin/env python3
"""
Sci-Hub Paper Downloader - A CLI tool for downloading academic papers
Usage: python scihub_download.py <DOI or PMID or URL>
"""

import argparse
import json
import os
import queue
import re
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse, unquote

import requests
from bs4 import BeautifulSoup

# On Windows, stdout/stderr are frequently attached to a legacy codepage
# (cp1252, cp437, ...) rather than UTF-8 — this script prints Unicode symbols
# (checkmarks, an X, etc.) in status lines, which then raises
# UnicodeEncodeError('charmap', ...) and crashes the whole run, even though
# the actual download logic never failed. reconfigure() (Python 3.7+) forces
# UTF-8 regardless of the console's codepage, with a safety-net fallback
# (errors="replace") for the rare stream that can't be reconfigured at all.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass

MIRROR_HEALTH_PATH = Path(__file__).resolve().parent / 'mirror_health.json'
# Contact address sent on every Unpaywall request, per their usage policy —
# not a login, just how they reach someone if the API is being misused.
# Overridable per-request via --email / the extension's Settings page
# (Connection card); this is only the fallback when neither is set.
UNPAYWALL_EMAIL = '111hui@protonmail.com'
MIRROR_COOLDOWN_MINUTES = 10
MIRROR_FAIL_THRESHOLD = 3
MIRROR_HEALTH_MAX_AGE_DAYS = 4
# Samples kept per hour-of-day bucket — enough to smooth out one-off blips
# without mirror_health.json growing unbounded over months of use.
HOURLY_LATENCY_MAX_SAMPLES = 10

# Same char-class-exclusion + trailing-trim shape as content.js's
# findDOI()/cleanDOI() bare-DOI pattern (kept in sync by hand, same as every
# other DOI-shaped regex duplicated across the JS/Python boundary in this
# codebase) — used here to find *every* DOI-shaped token in a document's
# text rather than just the first one.
DOI_SCAN_PATTERN = re.compile(r'\b10\.\d{4,}(?:\.\d+)*/[^\s,;\])"\'>]+', re.IGNORECASE)


def extract_all_dois(text, limit=500):
    """Scan arbitrary text for every DOI-shaped token, deduplicated
    case-insensitively (first-seen casing kept) and capped at `limit` so a
    pathological document (e.g. a PDF with a huge reference list) can't
    balloon the result unboundedly.

    Known limitation, deliberately not worked around here: pypdf's
    extract_text() can inject stray single spaces/newlines mid-token on some
    PDFs (confirmed live against a real PLOS ONE article, where
    "10.1371/journal.pone.0270949" came back as "10.1371/j ournal.\\npone.
    027094 9") -- a font/kerning quirk that affects the whole document's
    text, not something specific to DOIs. A regex tolerant of embedded
    whitespace was tried and rejected: it can't distinguish an artifact
    break from a genuine word boundary, so it either misses real
    continuations or swallows following prose depending on the input, with
    no reliable way to tell which. Left as a plain non-tolerant match
    instead, which can come back truncated on an affected PDF -- the
    downstream Crossref lookup (background.js's resolveDoiList) is expected
    to 404 on a truncated DOI and flag it for the user rather than silently
    guessing at a repair.
    """
    if not text:
        return []
    seen = set()
    results = []
    for m in DOI_SCAN_PATTERN.finditer(text):
        doi = m.group(0).rstrip('.,;)]}"\'>').strip()
        if len(doi) < 8 or '/' not in doi:
            continue
        key = doi.lower()
        if key in seen:
            continue
        seen.add(key)
        results.append(doi)
        if len(results) >= limit:
            break
    return results


def load_mirror_health():
    """Load per-mirror failure tracking from disk (empty dict if missing/corrupt)"""
    try:
        with open(MIRROR_HEALTH_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def prune_mirror_health(health):
    """Drop entries not touched in MIRROR_HEALTH_MAX_AGE_DAYS, so mirrors
    that were retired/renamed (or a stale user-configured mirror list)
    don't accumulate in the file forever."""
    cutoff = datetime.now() - timedelta(days=MIRROR_HEALTH_MAX_AGE_DAYS)
    pruned = {}
    for mirror, entry in health.items():
        last_seen = entry.get('last_seen')
        if last_seen:
            try:
                if datetime.fromisoformat(last_seen) < cutoff:
                    continue
            except ValueError:
                pass
        pruned[mirror] = entry
    return pruned


def save_mirror_health(health):
    # Written via a temp file + os.replace (atomic on both POSIX and Windows)
    # rather than a direct 'w' open, so a concurrent reader (e.g. a badge
    # check firing mid-write, or two batch tabs running at once) never sees a
    # half-written file — only ever the old version or the new one.
    try:
        MIRROR_HEALTH_PATH.parent.mkdir(parents=True, exist_ok=True)
        data = json.dumps(prune_mirror_health(health), indent=2)
        fd, tmp = tempfile.mkstemp(dir=str(MIRROR_HEALTH_PATH.parent), suffix='.tmp')
        try:
            with os.fdopen(fd, 'w') as f:
                f.write(data)
            os.replace(tmp, MIRROR_HEALTH_PATH)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError:
        pass


def hourly_avg_latency(entry, hour):
    """Average latency this mirror has historically seen around this hour of
    day, or None if there's no data for it yet."""
    samples = entry.get('latency_by_hour', {}).get(str(hour), [])
    if not samples:
        return None
    return sum(samples) / len(samples)


def seed_order_by_time_of_day(candidates, health):
    """Order mirrors so the one that's historically fastest at the current
    hour is dispatched first. This doesn't change which mirror wins the race
    (all candidates still fire in parallel) — it just means the mirror most
    likely to answer quickly isn't left waiting behind slower ones in thread
    start order. Mirrors with no data for this hour are left in their
    original relative order (untested isn't the same as slow); sort is
    stable so that ordering is preserved."""
    hour = datetime.now().hour

    def rank(mirror):
        avg = hourly_avg_latency(health.get(mirror, {}), hour)
        return (avg is None, avg if avg is not None else 0)

    return sorted(candidates, key=rank)


def is_mirror_unhealthy(health, mirror):
    entry = health.get(mirror)
    if not entry:
        return False
    if entry.get('fail_count', 0) < MIRROR_FAIL_THRESHOLD:
        return False
    last_failed = entry.get('last_failed')
    if not last_failed:
        return False
    try:
        last_failed_dt = datetime.fromisoformat(last_failed)
    except ValueError:
        return False
    return datetime.now() - last_failed_dt < timedelta(minutes=MIRROR_COOLDOWN_MINUTES)


class SciHubDownloader:
    """Handles downloading papers from Sci-Hub"""
    
    # List of Sci-Hub mirrors (these change frequently)
    SCIHUB_URLS = [
        'https://sci-hub.se',
        'https://sci-hub.st',
        'https://sci-hub.ru',
        'https://sci-hub.ee',
        'https://sci-hub.shop',
        'https://sci-hub.vg',
        'https://sci-hub.red',
        'https://sci-hub.su',
    ]

    # Anna's Archive / SciDB mirror domains, tried in order. These rotate under
    # legal pressure, so keep this list current. The user-supplied .pk domain is
    # first, with longer-lived ones as fallbacks. SciDB is the *last* source tried
    # (after Sci-Hub, Unpaywall, and the publisher page), so a slow or dead domain
    # here only ever delays the final "not available" answer.
    SCIDB_MIRRORS = [
        'https://annas-archive.gd',
        'https://annas-archive.pk',
        'https://annas-archive.gl',
        'https://annas-archive.li',
    ]

    def __init__(self, output_dir='papers', verbose=False, mirrors=None, unpaywall_email=None, scidb_mirrors=None):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.verbose = verbose
        if mirrors:
            self.SCIHUB_URLS = mirrors
        if scidb_mirrors:
            self.SCIDB_MIRRORS = scidb_mirrors
        self.unpaywall_email = unpaywall_email or UNPAYWALL_EMAIL
        self._captcha_hits = 0
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        })
    
    def log(self, message):
        """Print verbose logging"""
        if self.verbose:
            print(f"[DEBUG] {message}")

    def log_download(self, identifier, status, filepath=None, size_kb=None, error=None, source=None):
        """Append a record of this download attempt to the log file"""
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        parts = [timestamp, status, identifier]
        if source:
            parts.append(source)
        if filepath:
            parts.append(str(filepath))
        if size_kb is not None:
            parts.append(f"{size_kb:.1f} KB")
        if error:
            parts.append(error)
        line = ' | '.join(parts)
        log_path = Path(__file__).resolve().parent / 'download_log.txt'
        with open(log_path, 'a') as f:
            f.write(line + '\n')
    
    def extract_doi(self, identifier):
        """Extract DOI from various input formats"""
        # If it's already a clean DOI
        doi_pattern = r'10\.\d{4,}/[^\s]+'
        match = re.search(doi_pattern, identifier)
        if match:
            return match.group(0)
        return identifier
    
    # Sci-Hub occasionally serves an "are you a robot?" bot-check page instead
    # of a real result — this returns a real 200, so it's otherwise
    # indistinguishable from "this mirror genuinely has nothing for this DOI"
    # to every parsing method below. Detected by title text rather than a
    # specific challenge widget (e.g. altcha), since that's more likely to
    # stay stable if Sci-Hub swaps the underlying challenge provider again.
    CAPTCHA_MARKER = 'are you are robot'

    def _try_mirror(self, base_url, doi):
        """Attempt to resolve a PDF URL from a single mirror. Returns pdf_url or None."""
        try:
            print(f"Trying {base_url}...", flush=True)
            url = f"{base_url}/{quote(doi)}"
            self.log(f"Requesting: {url}")

            response = self.session.get(url, timeout=15, allow_redirects=True)
            self.log(f"Status code: {response.status_code}")

            if response.status_code != 200:
                self.log("Non-200 status, skipping")
                return None

            if self.CAPTCHA_MARKER in response.text.lower():
                # A genuine hit, just not one we can resolve without a real
                # browser — worth surfacing distinctly from "no PDF found"
                # so a false "not found" caused by this is diagnosable
                # (rather than looking identical to the paper truly being
                # absent from every mirror), and so callers can decide it's
                # worth a retry rather than a hard stop.
                self.log(f"{base_url} served a bot-check page, not a result")
                self._captcha_hits += 1
                return None

            soup = BeautifulSoup(response.content, 'html.parser')

            # Method 1: Look for PDF embed with src attribute
            pdf_embed = soup.find('embed', {'type': 'application/pdf'})
            if pdf_embed and pdf_embed.get('src'):
                pdf_url = pdf_embed['src']
                self.log(f"Found PDF in embed tag: {pdf_url}")
                return self._normalize_url(pdf_url, base_url)

            # Method 2: Look for any embed tag (sometimes type is missing)
            pdf_embed = soup.find('embed', src=True)
            if pdf_embed:
                pdf_url = pdf_embed['src']
                self.log(f"Found PDF in embed (no type): {pdf_url}")
                return self._normalize_url(pdf_url, base_url)

            # Method 3: Look for iframe with id="pdf"
            iframe = soup.find('iframe', {'id': 'pdf'})
            if iframe and iframe.get('src'):
                pdf_url = iframe['src']
                self.log(f"Found PDF in iframe#pdf: {pdf_url}")
                return self._normalize_url(pdf_url, base_url)

            # Method 4: Look for any iframe with src
            iframe = soup.find('iframe', src=True)
            if iframe:
                src = iframe['src']
                # Skip iframes that are clearly not PDFs
                if 'pdf' in src.lower() or not any(x in src.lower() for x in ['facebook', 'twitter', 'analytics', 'ads']):
                    self.log(f"Found PDF in iframe: {src}")
                    return self._normalize_url(src, base_url)

            # Method 5: Look for button with onclick location.href
            download_button = soup.find('button', {'onclick': re.compile(r'location\.href')})
            if download_button:
                onclick = download_button.get('onclick', '')
                url_match = re.search(r"location\.href\s*=\s*['\"]([^'\"]+)['\"]", onclick)
                if url_match:
                    pdf_url = url_match.group(1)
                    self.log(f"Found PDF in button onclick: {pdf_url}")
                    return self._normalize_url(pdf_url, base_url)

            # Method 6: Look in page source for common PDF patterns
            page_text = response.text

            # Pattern 1: //moscow.sci-hub.*/tree/...
            pattern1 = re.search(r'(//[^/]+\.sci-hub[^/]*/tree/[^\s\'"]+)', page_text)
            if pattern1:
                pdf_url = pattern1.group(1)
                self.log(f"Found PDF URL in page source (pattern 1): {pdf_url}")
                return self._normalize_url(pdf_url, base_url)

            # Pattern 2: https://.../*.pdf or similar
            pattern2 = re.search(r'(https?://[^\s\'"]+\.pdf[^\s\'"]*)', page_text)
            if pattern2:
                pdf_url = pattern2.group(1)
                self.log(f"Found PDF URL in page source (pattern 2): {pdf_url}")
                return pdf_url

            # Pattern 3: Look for download links
            for link in soup.find_all('a', href=True):
                href = link['href']
                if '.pdf' in href.lower() or 'download' in href.lower() or 'tree' in href:
                    self.log(f"Found potential PDF link: {href}")
                    return self._normalize_url(href, base_url)

            self.log("No PDF found on this mirror")
            return None

        except requests.RequestException as e:
            self.log(f"Request failed: {e}")
            return None
        except Exception as e:
            self.log(f"Error: {e}")
            return None

    def get_pdf_url(self, identifier, retries=4, retry_delay=3):
        """Race all mirrors, retrying the whole race if every mirror fails.

        Sci-Hub's mirrors are flaky enough that a single race can come back
        empty even when the paper is genuinely available moments later — this
        matters most for the automatic background check that drives the
        toolbar badge/notification, since a false "unavailable" there is
        actively misleading rather than just a missed convenience.
        """
        self._captcha_hits = 0
        for attempt in range(retries):
            pdf_url = self._race_mirrors_once(identifier)
            if pdf_url:
                return pdf_url
            if attempt < retries - 1:
                self.log(f"All mirrors failed (attempt {attempt + 1}/{retries}), retrying in {retry_delay}s...")
                time.sleep(retry_delay)
        if self._captcha_hits:
            print(
                f"\n(Note: {self._captcha_hits} Sci-Hub mirror response(s) were a "
                "bot-check page rather than a definitive answer — this paper may "
                "still be on Sci-Hub; trying again in a few minutes sometimes "
                "succeeds.)",
                flush=True,
            )
        return None

    def _race_mirrors_once(self, identifier):
        """Race all mirrors in parallel and return the first PDF URL found.

        Mirrors that have failed MIRROR_FAIL_THRESHOLD times recently are
        skipped for a cooldown period, unless that would skip every mirror.

        Uses plain daemon threads (not ThreadPoolExecutor) so we can return
        the instant the first mirror succeeds without waiting on slower
        stragglers — concurrent.futures joins all its worker threads at
        interpreter exit regardless of shutdown(wait=False), which would
        silently cancel the speed benefit of racing mirrors in the first place.
        """
        doi = self.extract_doi(identifier)
        health = load_mirror_health()

        candidates = [m for m in self.SCIHUB_URLS if not is_mirror_unhealthy(health, m)]
        if not candidates:
            # Every mirror is in cooldown — try them all anyway rather than giving up.
            candidates = list(self.SCIHUB_URLS)
        candidates = seed_order_by_time_of_day(candidates, health)

        result_queue = queue.Queue()

        def worker(mirror):
            start = time.time()
            pdf_url = self._try_mirror(mirror, doi)
            elapsed_ms = round((time.time() - start) * 1000)
            result_queue.put((mirror, pdf_url, elapsed_ms))

        for mirror in candidates:
            threading.Thread(target=worker, args=(mirror,), daemon=True).start()

        result = None
        for _ in range(len(candidates)):
            mirror, pdf_url, elapsed_ms = result_queue.get()
            entry = health.setdefault(mirror, {'fail_count': 0, 'last_failed': None})
            entry['last_latency_ms'] = elapsed_ms
            entry['last_seen'] = datetime.now().isoformat()
            # Rolling window of recent latencies for the Settings-page
            # sparkline — keep it short so mirror_health.json doesn't grow
            # unbounded over months of use.
            history = entry.setdefault('latency_history', [])
            history.append(elapsed_ms)
            del history[:-20]
            # Same latency sample, bucketed by hour-of-day so future races
            # can seed with whichever mirror is historically fastest right now.
            hour_bucket = entry.setdefault('latency_by_hour', {}).setdefault(str(datetime.now().hour), [])
            hour_bucket.append(elapsed_ms)
            del hour_bucket[:-HOURLY_LATENCY_MAX_SAMPLES]
            if pdf_url:
                entry['fail_count'] = 0
                entry['last_failed'] = None
                result = pdf_url
                break  # first success wins — don't wait for the rest
            else:
                entry['fail_count'] = entry.get('fail_count', 0) + 1
                entry['last_failed'] = datetime.now().isoformat()

        save_mirror_health(health)
        return result

    def get_oa_pdf_url_unpaywall(self, doi):
        """Ask Unpaywall for a legitimate open-access copy of this DOI.

        Used only after Sci-Hub comes up empty — Unpaywall aggregates OA
        locations (repositories, publisher OA copies, etc.) and is a plain
        JSON API, so unlike scraping a publisher page directly there's no
        bot-challenge to fight."""
        try:
            url = f'https://api.unpaywall.org/v2/{quote(doi, safe="")}'
            self.log(f"Checking Unpaywall: {url}")
            response = self.session.get(url, params={'email': self.unpaywall_email}, timeout=15)
            if response.status_code != 200:
                self.log(f"Unpaywall status {response.status_code}")
                return None
            data = response.json()

            locations = []
            if data.get('best_oa_location'):
                locations.append(data['best_oa_location'])
            locations.extend(data.get('oa_locations') or [])

            # Only trust url_for_pdf — Unpaywall's plain "url" field is often
            # just a landing page (sometimes literally the doi.org resolver
            # link), not a direct PDF. Treating that as a found PDF meant
            # download_pdf() would fetch it, fail the %PDF- header check, and
            # misreport a perfectly findable-elsewhere paper as "Corrupt"
            # instead of falling through to the publisher-scrape tier.
            for loc in locations:
                pdf_url = loc.get('url_for_pdf')
                if pdf_url:
                    self.log(f"Unpaywall found: {pdf_url}")
                    return pdf_url
            return None
        except (requests.RequestException, ValueError) as e:
            self.log(f"Unpaywall lookup failed: {e}")
            return None

    def get_oa_pdf_url_publisher(self, doi):
        """Last resort: fetch the DOI's landing page and look for a direct
        PDF link. Many publishers block plain HTTP fetches with a Cloudflare
        bot challenge, so this frequently comes back empty — that's expected,
        not an error, which is why every failure path here just returns None
        rather than raising."""
        try:
            url = f'https://doi.org/{doi}'
            self.log(f"Checking publisher page: {url}")
            response = self.session.get(url, timeout=15, allow_redirects=True)
            if response.status_code != 200:
                self.log(f"Publisher page status {response.status_code}")
                return None

            soup = BeautifulSoup(response.text, 'html.parser')

            # Standard scholarly metadata tag — widely supported, including
            # by publishers that don't put the abstract in Crossref.
            meta = soup.find('meta', attrs={'name': 'citation_pdf_url'})
            if meta and meta.get('content'):
                return self._normalize_url(meta['content'], response.url)

            link = soup.find('a', href=re.compile(r'\.pdf($|\?)', re.I))
            if link and link.get('href'):
                return self._normalize_url(link['href'], response.url)

            return None
        except requests.RequestException as e:
            self.log(f"Publisher page fetch failed: {e}")
            return None

    def get_scidb_pdf_url(self, doi):
        """Final fallback: resolve a DOI to a PDF via Anna's Archive (SciDB).

        Tried only after Sci-Hub, Unpaywall, and the publisher page have all come
        up empty. Returns a directly-downloadable PDF URL, or None.

        Like the Unpaywall resolver, this validates that the candidate is a real
        PDF *before* returning it, so a SciDB viewer/landing page is never handed
        back to download_pdf() and misreported as "Corrupt" -- a miss here should
        fall through cleanly to the final "not available" result.

        NOTE: SciDB's page markup and download URLs change fairly often, and some
        Anna's Archive domains sit behind a Cloudflare bot-challenge that blocks
        plain server-side fetches (the same wall this tool already hits on
        tandfonline etc.). When that happens, every candidate simply fails
        validation and this returns None. If SciDB stops resolving, the selectors
        in _extract_scidb_candidates() are the thing to update first.
        """
        doi = self.extract_doi(doi)
        health = load_mirror_health()
        try:
            for base_url in self.SCIDB_MIRRORS:
                start = time.time()
                try:
                    page_url = f"{base_url}/scidb/{quote(doi)}"
                    print(f"Trying Anna's Archive (SciDB): {base_url}...", flush=True)
                    self.log(f"Requesting SciDB page: {page_url}")
                    resp = self.session.get(page_url, timeout=20, allow_redirects=True)
                    elapsed_ms = round((time.time() - start) * 1000)
                    if resp.status_code != 200:
                        self.log(f"SciDB status {resp.status_code} on {base_url}")
                        self._record_scidb_health(health, base_url, elapsed_ms, success=False)
                        continue

                    candidates = self._extract_scidb_candidates(resp, base_url)
                    found = None
                    for cand in candidates:
                        self.log(f"SciDB candidate: {cand}")
                        if self._scidb_candidate_is_pdf(cand, referer=page_url):
                            self.log(f"SciDB validated PDF: {cand}")
                            found = cand
                            break
                    self._record_scidb_health(health, base_url, elapsed_ms, success=bool(found))
                    if found:
                        return found
                    self.log(f"No valid PDF found via {base_url}")
                except requests.RequestException as e:
                    elapsed_ms = round((time.time() - start) * 1000)
                    self.log(f"SciDB request failed on {base_url}: {e}")
                    self._record_scidb_health(health, base_url, elapsed_ms, success=False)
                    continue
                except Exception as e:
                    elapsed_ms = round((time.time() - start) * 1000)
                    self.log(f"SciDB error on {base_url}: {e}")
                    self._record_scidb_health(health, base_url, elapsed_ms, success=False)
                    continue
            return None
        finally:
            save_mirror_health(health)

    def _record_scidb_health(self, health, mirror, elapsed_ms, success):
        """Tracks Anna's Archive (SciDB) mirrors in the same mirror_health.json
        file/schema already used for Sci-Hub mirrors (fail_count/last_failed/
        last_latency_ms/latency_history/last_seen) -- Settings' Mirror Health
        panel and doi_host.py's mirror_health action just list whatever URLs
        are in the file, with no Sci-Hub-specific assumption, so this is all
        that's needed for SciDB mirrors to show up there too. Deliberately
        skips latency_by_hour/is_mirror_unhealthy-style cooldown skipping --
        those exist for Sci-Hub's parallel mirror race (item 70's time-of-day
        seeding); this tier is a plain sequential fallback, not raced."""
        entry = health.setdefault(mirror, {'fail_count': 0, 'last_failed': None})
        entry['last_latency_ms'] = elapsed_ms
        entry['last_seen'] = datetime.now().isoformat()
        history = entry.setdefault('latency_history', [])
        history.append(elapsed_ms)
        del history[:-20]
        if success:
            entry['fail_count'] = 0
            entry['last_failed'] = None
        else:
            entry['fail_count'] = entry.get('fail_count', 0) + 1
            entry['last_failed'] = datetime.now().isoformat()

    def _extract_scidb_candidates(self, response, base_url):
        """Pull possible direct-PDF URLs out of a SciDB page, best guess first.

        Deliberately broad and ordered most- to least-specific, mirroring the
        multi-method approach in _try_mirror(). Every candidate is validated by
        the caller before use, so over-collecting here is cheap."""
        soup = BeautifulSoup(response.content, 'html.parser')
        candidates = []

        def add(url):
            if not url:
                return
            full = self._normalize_url(url, response.url or base_url)
            if full and full not in candidates:
                candidates.append(full)

        # 1. Embedded viewer iframe pointing at the file (common SciDB layout)
        for iframe in soup.find_all('iframe', src=True):
            src = iframe['src']
            low = src.lower()
            if '.pdf' in low or '/scidb/' in low or 'download' in low:
                add(src)

        # 2. <embed>/<object> PDF viewers
        for tag in soup.find_all(['embed', 'object']):
            src = tag.get('src') or tag.get('data')
            if src and ('.pdf' in src.lower() or 'download' in src.lower()):
                add(src)

        # 3. Explicit download / .pdf anchor links
        for a in soup.find_all('a', href=True):
            href = a['href']
            low = href.lower()
            if '.pdf' in low or 'download' in low or '/scidb/' in low:
                add(href)

        # 4. Bare PDF URLs anywhere in the page source
        for m in re.findall(r'https?://[^\s\'"<>]+\.pdf[^\s\'"<>]*', response.text):
            add(m)

        return candidates

    def _scidb_candidate_is_pdf(self, url, referer=None):
        """Fetch just enough of `url` to confirm it's a real PDF (Content-Type
        says so, or the bytes start with the %PDF- magic number), so a viewer or
        HTML page is never returned as a downloadable file. Returns True/False."""
        headers = {'Referer': referer} if referer else {}
        try:
            r = self.session.get(url, headers=headers, timeout=20,
                                 stream=True, allow_redirects=True)
            if r.status_code != 200:
                r.close()
                return False
            ctype = r.headers.get('content-type', '').lower()
            if 'pdf' in ctype or 'octet-stream' in ctype:
                r.close()
                return True
            if 'html' in ctype or 'text' in ctype:
                r.close()
                return False
            first = next(r.iter_content(chunk_size=5), b'')
            r.close()
            return first[:5] == b'%PDF-'
        except requests.RequestException:
            return False

    def _normalize_url(self, url, base_url):
        """Normalize PDF URL to absolute URL"""
        if url.startswith('http'):
            return url
        elif url.startswith('//'):
            return 'https:' + url
        else:
            # urljoin handles both site-root-relative ("/foo") and
            # page-relative ("foo") links correctly against a full base URL
            # (including one with its own path, e.g. a publisher landing page).
            return urljoin(base_url, url)
    
    def emit_result(self, status, **fields):
        """Print a machine-readable result line for the native host to parse"""
        print("RESULT:" + json.dumps({"status": status, **fields}), flush=True)

    def scan_pdf_for_dois(self, url, max_dois=500):
        """Downloads the PDF at `url` into a temp file, extracts its text with
        pypdf, and regex-scans that text for every DOI-shaped token. Used by
        "Scan Page for DOIs" when the active tab is a PDF opened directly in
        Chrome — Chrome's built-in PDF viewer exposes no readable DOM a
        content script could scan, so this has to happen server-side against
        the original file instead of client-side like a regular web page.

        pypdf is a lazy import here (not a module-level one) so that every
        *other* action in this script keeps working unmodified on an
        existing install that doesn't have it — only this specific action
        needs it, unlike requests/bs4, which the whole script needs
        unconditionally.
        """
        try:
            from pypdf import PdfReader
        except ImportError:
            self.emit_result("error", detail="PDF scanning needs the 'pypdf' package. Install it with: python3 -m pip install pypdf")
            return

        # A PDF opened directly in Chrome from a local file (drag-and-drop, a
        # file:// link, or a previous Sci-Hub/Unpaywall/SciDB download opened
        # back up) has a file:// tab URL, not an http(s) one -- requests has
        # no adapter for that scheme at all ("No connection adapters were
        # found for 'file://...'"), confirmed live against a real local PDF.
        # Read it straight off disk in that case instead of trying to GET it.
        parsed = urlparse(url)
        if parsed.scheme == 'file':
            local_path = unquote(parsed.path)
            # file:///C:/Users/... parses to "/C:/Users/..." -- a leading
            # slash before a Windows drive letter isn't a valid path.
            if re.match(r'^/[A-Za-z]:/', local_path):
                local_path = local_path[1:]
            print(f"Reading local PDF: {local_path}...", flush=True)
            try:
                with open(local_path, 'rb') as f:
                    content = f.read()
            except OSError as e:
                self.emit_result("error", detail=f"Couldn't read the local PDF file: {e}")
                return
        else:
            print(f"Downloading PDF from {url}...", flush=True)
            try:
                response = self.session.get(url, timeout=60, allow_redirects=True)
                response.raise_for_status()
            except requests.RequestException as e:
                self.emit_result("error", detail=f"Couldn't download the PDF: {e}")
                return
            content = response.content

        if content[:5] != b'%PDF-':
            self.emit_result("error", detail="That URL didn't return a real PDF (possibly a login/paywall page).")
            return

        print(f"Extracting text ({len(content) // 1024} KB)...", flush=True)
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as f:
                f.write(content)
                tmp_path = f.name

            reader = PdfReader(tmp_path)
            text_parts = []
            for i, page in enumerate(reader.pages):
                text_parts.append(page.extract_text() or '')
                if (i + 1) % 10 == 0:
                    print(f"Scanned {i + 1}/{len(reader.pages)} pages...", flush=True)
            text = '\n'.join(text_parts)
        except Exception as e:
            self.emit_result("error", detail=f"Couldn't read this PDF's text: {e}")
            return
        finally:
            if tmp_path:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

        dois = extract_all_dois(text, limit=max_dois)
        print(f"Found {len(dois)} DOI(s).", flush=True)
        self.emit_result("ok", dois=dois)

    def download_pdf(self, identifier, filename=None):
        """Download the PDF file"""
        print(f"Searching for: {identifier}", flush=True)

        pdf_url = self.get_pdf_url(identifier)
        source = 'scihub'

        if not pdf_url:
            doi = self.extract_doi(identifier)

            print("\nNot on Sci-Hub — checking Unpaywall for an open-access copy...", flush=True)
            pdf_url = self.get_oa_pdf_url_unpaywall(doi)
            source = 'open_access'

            if not pdf_url:
                print("Not on Unpaywall — checking the publisher page directly...", flush=True)
                pdf_url = self.get_oa_pdf_url_publisher(doi)

            if not pdf_url:
                print("Not open-access anywhere — trying Anna's Archive (SciDB) as a last resort...", flush=True)
                pdf_url = self.get_scidb_pdf_url(doi)
                if pdf_url:
                    source = 'scidb'

        if not pdf_url:
            print("\n❌ Could not find paper on Sci-Hub, as an open-access copy, or on Anna's Archive.", flush=True)
            print("\nPossible reasons:", flush=True)
            print("  • The paper might not be in Sci-Hub's database", flush=True)
            print("  • It isn't openly available anywhere Unpaywall or the publisher page expose", flush=True)
            print("  • Sci-Hub mirrors might be blocked in your region", flush=True)
            print("  • The DOI might be incorrect", flush=True)
            print("\nTry:", flush=True)
            print("  • Using a VPN", flush=True)
            print("  • Checking the DOI is correct", flush=True)
            print("  • Trying again later", flush=True)
            self.log_download(identifier, "FAILED", error="No PDF found on Sci-Hub, open-access, or Anna's Archive")
            self.emit_result("error", detail="No PDF found on Sci-Hub, open-access, or Anna's Archive")
            return False

        print(f"Found PDF at: {pdf_url}" + (" (open access)" if source == 'open_access' else ""), flush=True)

        try:
            self.log(f"Downloading from: {pdf_url}")
            response = self.session.get(pdf_url, timeout=30, stream=True)
            response.raise_for_status()

            # Check if it's actually a PDF
            content_type = response.headers.get('content-type', '').lower()
            self.log(f"Content-Type: {content_type}")

            if 'pdf' not in content_type and 'octet-stream' not in content_type:
                print(f"⚠️  Warning: Response might not be a PDF (Content-Type: {content_type})", flush=True)

            # Generate filename if not provided
            if not filename:
                doi = self.extract_doi(identifier)
                # Clean DOI for filename
                filename = re.sub(r'[^\w\-.]', '_', doi) + '.pdf'

            if not filename.endswith('.pdf'):
                filename += '.pdf'

            filepath = self.output_dir / filename

            # Download with progress, reporting every 10% on its own line
            total_size = int(response.headers.get('content-length', 0))
            downloaded = 0
            last_reported = -1

            with open(filepath, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total_size > 0:
                            progress = int((downloaded / total_size) * 100)
                            if progress >= last_reported + 10:
                                last_reported = progress
                                print(f"Downloading: {progress}%", flush=True)

            size_kb = downloaded / 1024

            with open(filepath, 'rb') as f:
                header = f.read(5)
            if header != b'%PDF-':
                print(f"⚠️  Downloaded file isn't a valid PDF (mirror likely served an error page): {filepath}", flush=True)
                self.log_download(identifier, "CORRUPT", filepath=filepath, size_kb=size_kb, error="Missing %PDF- header", source=source)
                self.emit_result("corrupt", filepath=str(filepath), size_kb=round(size_kb, 1), source=source)
                return False

            print(f"✅ Downloaded successfully: {filepath}" + (" (open access)" if source == 'open_access' else ""), flush=True)
            print(f"   Size: {size_kb:.1f} KB", flush=True)
            self.log_download(identifier, "SUCCESS", filepath=filepath, size_kb=size_kb, source=source)
            self.emit_result("ok", filepath=str(filepath), size_kb=round(size_kb, 1), source=source)
            return True

        except requests.RequestException as e:
            print(f"❌ Download failed: {e}", flush=True)
            self.log_download(identifier, "FAILED", error=str(e), source=source)
            self.emit_result("error", detail=str(e), source=source)
            return False


def main():
    parser = argparse.ArgumentParser(
        description='Download academic papers from Sci-Hub',
        epilog='Example: python scihub_download.py 10.1038/nature12373'
    )
    parser.add_argument(
        'identifier',
        nargs='?',
        help='DOI, PMID, or paper URL (not needed with --scan-pdf-url)'
    )
    parser.add_argument(
        '-o', '--output',
        help='Output filename (default: auto-generated from DOI)'
    )
    parser.add_argument(
        '-d', '--directory',
        default=str(Path.home() / 'Downloads' / 'autorename'),
        help='Output directory (default: ~/Downloads/autorename)'
    )
    parser.add_argument(
        '-v', '--verbose',
        action='store_true',
        help='Enable verbose logging'
    )
    parser.add_argument(
        '-m', '--mirrors',
        help='Comma-separated list of Sci-Hub mirror URLs to use instead of the default list'
    )
    parser.add_argument(
        '--scidb-mirrors',
        help="Comma-separated list of Anna's Archive (SciDB) mirror URLs to use instead of the default list"
    )
    parser.add_argument(
        '--check',
        action='store_true',
        help='Only check whether a PDF is available, without downloading it'
    )
    parser.add_argument(
        '--email',
        help='Contact email sent with Unpaywall API requests (default: the UNPAYWALL_EMAIL constant in this file)'
    )
    parser.add_argument(
        '--scan-pdf-url',
        help='Download the PDF at this URL and scan its text for every DOI-shaped token, instead of downloading a single paper'
    )

    args = parser.parse_args()

    mirrors = [m.strip() for m in args.mirrors.split(',') if m.strip()] if args.mirrors else None
    scidb_mirrors = [m.strip() for m in args.scidb_mirrors.split(',') if m.strip()] if args.scidb_mirrors else None
    downloader = SciHubDownloader(output_dir=args.directory, verbose=args.verbose, mirrors=mirrors, unpaywall_email=args.email, scidb_mirrors=scidb_mirrors)

    if args.scan_pdf_url:
        downloader.scan_pdf_for_dois(args.scan_pdf_url)
        sys.exit(0)

    if not args.identifier:
        parser.error('identifier is required unless --scan-pdf-url is given')

    if args.check:
        pdf_url = downloader.get_pdf_url(args.identifier)
        source = 'scihub'
        if not pdf_url:
            doi = downloader.extract_doi(args.identifier)
            pdf_url = downloader.get_oa_pdf_url_unpaywall(doi)
            source = 'open_access'
            if not pdf_url:
                pdf_url = downloader.get_oa_pdf_url_publisher(doi)
        if pdf_url:
            downloader.emit_result("available", pdf_url=pdf_url, source=source)
            sys.exit(0)
        else:
            downloader.emit_result("unavailable")
            sys.exit(1)

    success = downloader.download_pdf(args.identifier, filename=args.output)

    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()
