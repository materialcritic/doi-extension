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
from urllib.parse import quote, urljoin

import requests
from bs4 import BeautifulSoup

MIRROR_HEALTH_PATH = Path(__file__).resolve().parent / 'mirror_health.json'
# Contact address sent on every Unpaywall request, per their usage policy —
# not a login, just how they reach someone if the API is being misused.
# Replace with your own address if you're running this yourself.
UNPAYWALL_EMAIL = '111hui@protonmail.com'
MIRROR_COOLDOWN_MINUTES = 10
MIRROR_FAIL_THRESHOLD = 3
MIRROR_HEALTH_MAX_AGE_DAYS = 4
# Samples kept per hour-of-day bucket — enough to smooth out one-off blips
# without mirror_health.json growing unbounded over months of use.
HOURLY_LATENCY_MAX_SAMPLES = 10


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
    
    def __init__(self, output_dir='papers', verbose=False, mirrors=None):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.verbose = verbose
        if mirrors:
            self.SCIHUB_URLS = mirrors
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
        for attempt in range(retries):
            pdf_url = self._race_mirrors_once(identifier)
            if pdf_url:
                return pdf_url
            if attempt < retries - 1:
                self.log(f"All mirrors failed (attempt {attempt + 1}/{retries}), retrying in {retry_delay}s...")
                time.sleep(retry_delay)
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
            response = self.session.get(url, params={'email': UNPAYWALL_EMAIL}, timeout=15)
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
            print("\n❌ Could not find paper on Sci-Hub or as an open-access copy.", flush=True)
            print("\nPossible reasons:", flush=True)
            print("  • The paper might not be in Sci-Hub's database", flush=True)
            print("  • It isn't openly available anywhere Unpaywall or the publisher page expose", flush=True)
            print("  • Sci-Hub mirrors might be blocked in your region", flush=True)
            print("  • The DOI might be incorrect", flush=True)
            print("\nTry:", flush=True)
            print("  • Using a VPN", flush=True)
            print("  • Checking the DOI is correct", flush=True)
            print("  • Trying again later", flush=True)
            self.log_download(identifier, "FAILED", error="No PDF found on Sci-Hub or as an open-access copy")
            self.emit_result("error", detail="No PDF found on Sci-Hub or as an open-access copy")
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
        help='DOI, PMID, or paper URL'
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
        '--check',
        action='store_true',
        help='Only check whether a PDF is available, without downloading it'
    )

    args = parser.parse_args()

    mirrors = [m.strip() for m in args.mirrors.split(',') if m.strip()] if args.mirrors else None
    downloader = SciHubDownloader(output_dir=args.directory, verbose=args.verbose, mirrors=mirrors)

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
