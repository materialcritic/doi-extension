"""
Tests for doi_host.py's pure-function security/correctness fixes.

These specifically lock in the fixes from the code audit dated 2026-08-28:
path validation (H2), the interpreter/script allowlist (H2), the
native-message size guard (H3), the origin-verification regex (M4), and the
calendar-month arithmetic fix (L4). None of these spawn a real subprocess,
touch the network, or require Chrome/native-messaging — they exercise the
functions directly.

Run with: cd native-host && python3 -m pytest tests/ -v
(pytest isn't a hard dependency of the project itself — only needed if
you're running this suite.)
"""

import contextlib
import json
import os
import struct
import sys
import tempfile
import shutil
from datetime import datetime, timezone, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import doi_host


@pytest.fixture(autouse=True)
def _isolated_debug_log(tmp_path, monkeypatch):
    """The host appends to native-host/debug_log.txt, which feeds the logs the
    extension exports for bug reports -- keep test chatter out of the real one."""
    monkeypatch.setattr(doi_host, "DEBUG_LOG_PATH", str(tmp_path / "debug_log.txt"))


# ---------------------------------------------------------------------------
# _validate_path (H2)
# ---------------------------------------------------------------------------

class TestValidatePath:
    def setup_method(self):
        self.tmp_output = tempfile.mkdtemp(prefix="doi_test_output_")

    def teardown_method(self):
        shutil.rmtree(self.tmp_output, ignore_errors=True)

    def test_accepts_path_under_configured_output_dir(self):
        settings = {"outputDir": self.tmp_output}
        legit = os.path.join(self.tmp_output, "SubFolder", "download_log.txt")
        result = doi_host._validate_path(legit, settings)
        assert result == os.path.realpath(legit)

    def test_rejects_traversal_out_of_output_dir(self):
        settings = {"outputDir": self.tmp_output}
        evil = os.path.join(self.tmp_output, "..", "..", "..", "etc", "passwd")
        try:
            doi_host._validate_path(evil, settings)
            assert False, "traversal should have been rejected"
        except ValueError:
            pass

    def test_rejects_unrelated_absolute_path(self):
        settings = {"outputDir": self.tmp_output}
        try:
            doi_host._validate_path("/etc/passwd", settings)
            assert False, "arbitrary path should have been rejected"
        except ValueError:
            pass

    def test_accepts_default_download_dir_with_no_settings(self):
        default_path = os.path.join(os.path.expanduser("~"), "Downloads", "autorename", "x.pdf")
        result = doi_host._validate_path(default_path, {})
        assert result == os.path.realpath(default_path)

    def test_rejects_empty_path(self):
        try:
            doi_host._validate_path("", {"outputDir": self.tmp_output})
            assert False, "empty path should have been rejected"
        except ValueError:
            pass


# ---------------------------------------------------------------------------
# _validate_script_path / _validate_python_bin (H2)
# ---------------------------------------------------------------------------

class TestValidateScriptPath:
    def test_accepts_real_script_inside_script_dir(self):
        real = os.path.join(doi_host.SCRIPT_DIR, "scihub_download.py")
        assert doi_host._validate_script_path(real) == os.path.realpath(real)

    def test_rejects_script_outside_script_dir(self):
        try:
            doi_host._validate_script_path("/tmp/evil.py")
            assert False, "script outside SCRIPT_DIR should have been rejected"
        except ValueError:
            pass


class TestValidatePythonBin:
    def test_accepts_real_interpreter(self):
        # sys.executable is always a real, executable Python interpreter.
        result = doi_host._validate_python_bin(sys.executable)
        assert os.path.isfile(result)

    def test_rejects_non_python_executable(self):
        for candidate in ("/bin/bash", "/bin/sh"):
            if os.path.isfile(candidate):
                try:
                    doi_host._validate_python_bin(candidate)
                    assert False, f"{candidate} should have been rejected"
                except ValueError:
                    pass
                break

    def test_rejects_nonexistent_path(self):
        try:
            doi_host._validate_python_bin("/no/such/interpreter")
            assert False, "nonexistent interpreter should have been rejected"
        except ValueError:
            pass

    def test_rejects_null_byte(self):
        try:
            doi_host._validate_python_bin("python3\x00/etc/passwd")
            assert False, "null byte should have been rejected"
        except ValueError:
            pass


# ---------------------------------------------------------------------------
# _read_capped (H3)
# ---------------------------------------------------------------------------

class TestReadCapped:
    def test_small_file_returned_in_full(self):
        fd, path = tempfile.mkstemp()
        try:
            with open(path, "w") as f:
                f.write("line1\nline2\nline3\n")
            assert doi_host._read_capped(path, 1000) == "line1\nline2\nline3\n"
        finally:
            os.remove(path)

    def test_large_file_truncated_from_the_front(self):
        fd, path = tempfile.mkstemp()
        try:
            with open(path, "w") as f:
                for i in range(10000):
                    f.write(f"log line number {i}\n")
            capped = doi_host._read_capped(path, 500)
            assert capped.startswith("... [truncated")
            assert capped.rstrip().endswith("log line number 9999")
            assert len(capped) < 700
        finally:
            os.remove(path)


# ---------------------------------------------------------------------------
# send_message's size guard (H3)
# ---------------------------------------------------------------------------

class TestSendMessageSizeGuard:
    def test_oversized_payload_replaced_with_error(self):
        big_payload = {"type": "result", "status": "ok", "content": "x" * (1024 * 1024)}

        class FakeStdout:
            def __init__(self):
                self.buffer = self

            def write(self, data):
                self._written = getattr(self, "_written", b"") + data

            def flush(self):
                pass

        fake_stdout = FakeStdout()
        real_stdout = sys.stdout
        sys.stdout = fake_stdout
        try:
            doi_host.send_message(big_payload)
        finally:
            sys.stdout = real_stdout

        raw = fake_stdout._written
        length = struct.unpack("=I", raw[:4])[0]
        decoded = json.loads(raw[4:4 + length])
        assert decoded["status"] == "error"
        assert "too large" in decoded["detail"]
        assert length < doi_host.NATIVE_MESSAGE_SAFE_BYTES


# ---------------------------------------------------------------------------
# _verify_origin_remote's expected-origin pattern (M4)
# ---------------------------------------------------------------------------

class TestOriginPattern:
    def test_accepts_the_real_repo(self):
        import re
        for url in (
            "https://github.com/materialcritic/doi-extension",
            "https://github.com/materialcritic/doi-extension.git",
            "git@github.com:materialcritic/doi-extension.git",
        ):
            assert re.match(doi_host.EXPECTED_ORIGIN_PATTERN, url), url

    def test_rejects_a_different_repo_or_host(self):
        import re
        for url in (
            "https://github.com/attacker/doi-extension.git",
            "https://gitlab.com/materialcritic/doi-extension.git",
            "https://github.com/materialcritic/doi-extension.git.evil.com",
        ):
            assert not re.match(doi_host.EXPECTED_ORIGIN_PATTERN, url), url


# ---------------------------------------------------------------------------
# _months_ago (L4)
# ---------------------------------------------------------------------------

class TestMonthsAgo:
    def test_basic_subtraction(self):
        assert doi_host._months_ago(datetime(2026, 8, 28), 7) == datetime(2026, 1, 28)

    def test_wraps_across_year_boundary(self):
        assert doi_host._months_ago(datetime(2026, 1, 15), 7) == datetime(2025, 6, 15)

    def test_clamps_day_in_shorter_target_month(self):
        # March 31 minus 1 month -> Feb 28 in a non-leap year.
        assert doi_host._months_ago(datetime(2026, 3, 31), 1) == datetime(2026, 2, 28)

    def test_clamps_to_leap_day_in_leap_year(self):
        assert doi_host._months_ago(datetime(2024, 3, 31), 1) == datetime(2024, 2, 29)

    def test_zero_months_is_a_no_op(self):
        now = datetime(2026, 8, 28, 12, 30)
        assert doi_host._months_ago(now, 0) == now

    def test_meaningfully_different_from_the_old_30_times_n_days_formula(self):
        # The bug this replaces: timedelta(days=30*7) drifts from a real
        # 7-calendar-month boundary by several days depending which months
        # are involved -- confirm the new function actually differs from it
        # rather than being a no-op refactor.
        now = datetime(2026, 8, 28)
        old_cutoff = now - timedelta(days=30 * 7)
        new_cutoff = doi_host._months_ago(now, 7)
        assert old_cutoff != new_cutoff


# ---------------------------------------------------------------------------
# compute_prefix_hit_rates (batch "likely unavailable" ordering)
# ---------------------------------------------------------------------------

class TestComputePrefixHitRates:
    def test_counts_success_and_real_misses_per_prefix(self):
        lines = [
            "2026-09-15 20:00:00 | SUCCESS | 10.1177/abc | /out/a.pdf",
            "2026-09-15 20:01:00 | FAILED | 10.4324/x-1 | No PDF found on Sci-Hub or open-access",
            "2026-09-15 20:02:00 | CORRUPT | 10.4324/x-2 | /out/x-2.pdf | 3.1 KB | Missing %PDF- header",
        ]
        assert doi_host.compute_prefix_hit_rates(lines) == {"10.1177": [1, 1], "10.4324": [0, 2]}

    def test_transient_failures_dont_count_against_a_publisher(self):
        lines = [
            "2026-09-15 20:00:00 | FAILED | 10.1177/abc | Cloudflare bot-challenge",
            "2026-09-15 20:01:00 | FAILED | 10.1177/def | ('Connection aborted.', ConnectionResetError(54))",
        ]
        assert doi_host.compute_prefix_hit_rates(lines) == {}

    def test_only_each_dois_latest_outcome_counts(self):
        lines = [
            "2026-09-15 20:00:00 | FAILED | 10.1515/x | No PDF found on Sci-Hub or open-access",
            "2026-09-15 20:05:00 | FAILED | 10.1515/x | No PDF found on Sci-Hub or open-access",
            "2026-09-16 09:00:00 | SUCCESS | 10.1515/X | /out/x.pdf",
        ]
        assert doi_host.compute_prefix_hit_rates(lines) == {"10.1515": [1, 1]}

    def test_ignores_malformed_and_non_doi_lines(self):
        lines = ["", "garbage", "2026-09-15 | SUCCESS | https://example.com/paper | /out/p.pdf"]
        assert doi_host.compute_prefix_hit_rates(lines) == {}


# ---------------------------------------------------------------------------
# scan_issue_folder / pdf_integrity (resume support for the batch pages)
# ---------------------------------------------------------------------------

GOOD_PDF = b"%PDF-1.4\n" + b"x" * 3000 + b"\n%%EOF\n"
CUT_PDF = b"%PDF-1.4\n" + b"x" * 6000          # header but no %%EOF: cut off mid-download
HTML = b"<!DOCTYPE html><html><body>Access denied</body></html>"


class TestPdfIntegrity:
    def test_complete_truncated_html_empty_and_missing(self, tmp_path):
        for name, data in (("good.pdf", GOOD_PDF), ("cut.pdf", CUT_PDF), ("page.pdf", HTML), ("empty.pdf", b"")):
            (tmp_path / name).write_bytes(data)
        assert doi_host.pdf_integrity(str(tmp_path / "good.pdf")) == "ok"
        assert doi_host.pdf_integrity(str(tmp_path / "cut.pdf")) == "truncated"
        assert doi_host.pdf_integrity(str(tmp_path / "page.pdf")) == "notpdf"
        assert doi_host.pdf_integrity(str(tmp_path / "empty.pdf")) == "notpdf"
        assert doi_host.pdf_integrity(str(tmp_path / "nope.pdf")) == "missing"

    def test_linearized_pdf_cut_short_is_truncated(self, tmp_path):
        # A linearized PDF carries an early %%EOF; a cut-off tail must still be caught.
        (tmp_path / "lin.pdf").write_bytes(b"%PDF-1.5\n" + b"a" * 1000 + b"\n%%EOF\n" + b"b" * 9000)
        assert doi_host.pdf_integrity(str(tmp_path / "lin.pdf")) == "truncated"


class TestDoiFileNames:
    def test_matches_the_downloaders_naming_rule(self):
        assert doi_host.doi_file_names("10.1177/019145377800500101") == ["10.1177_019145377800500101.pdf"]
        assert doi_host.doi_file_names("10.1016/s0002-9149(04)00280-2") == ["10.1016_s0002-9149_04_00280-2.pdf"]

    def test_non_ascii_doi_checks_both_rules(self):
        names = doi_host.doi_file_names("10.1000/café")
        assert "10.1000_café.pdf" in names and "10.1000_caf_.pdf" in names


class TestScanIssueFolder:
    def make_base(self, tmp_path):
        base = tmp_path / "autorename"
        issue = base / "Journal Vol 5 Issue 1"
        issue.mkdir(parents=True)
        return base, issue, {"outputDir": str(base)}

    def scan(self, base, issue, settings, dois):
        return doi_host.scan_issue_folder(str(issue), dois, settings, {})

    def test_doi_named_complete_file_is_ok(self, tmp_path):
        base, issue, settings = self.make_base(tmp_path)
        (issue / "10.1177_a1.pdf").write_bytes(GOOD_PDF)
        states, _ = self.scan(base, issue, settings, ["10.1177/a1", "10.1177/a2"])
        assert states == {"10.1177/a1": "ok"}

    def test_file_renamed_by_the_watcher_is_found_through_rename_log(self, tmp_path):
        base, issue, settings = self.make_base(tmp_path)
        (issue / "Some Title - Author.pdf").write_bytes(GOOD_PDF)
        (base / "rename_log.csv").write_text(
            "timestamp,old_name,new_name\n"
            '2026-08-07 19:44:32,"Journal Vol 5 Issue 1/10.1177_a1.pdf","Journal Vol 5 Issue 1/Some Title - Author.pdf"\n'
        )
        states, _ = self.scan(base, issue, settings, ["10.1177/a1"])
        assert states == {"10.1177/a1": "ok"}

    def test_every_duplicate_row_and_uniquified_names_resolve(self, tmp_path):
        base, issue, settings = self.make_base(tmp_path)
        (issue / "T - A (2).pdf").write_bytes(GOOD_PDF)
        (base / "rename_log.csv").write_text(
            "timestamp,old_name,new_name\n"
            '2026-11-12 01:13:35,"Journal Vol 5 Issue 1/10.1177_a1 (1).pdf","Journal Vol 5 Issue 1/T - A (2).pdf"\n'
        )
        assert self.scan(base, issue, settings, ["10.1177/a1"])[0] == {"10.1177/a1": "ok"}

    def test_unrenamed_chrome_uniquified_file_is_found(self, tmp_path):
        base, issue, settings = self.make_base(tmp_path)
        (issue / "10.1177_a1 (3).pdf").write_bytes(GOOD_PDF)
        assert self.scan(base, issue, settings, ["10.1177/a1"])[0] == {"10.1177/a1": "ok"}

    def test_old_format_top_level_rows_resolve_for_top_level_folder(self, tmp_path):
        base = tmp_path / "autorename"
        base.mkdir()
        (base / "Renamed.pdf").write_bytes(GOOD_PDF)
        (base / "rename_log.csv").write_text("timestamp,old_name,new_name\n03/07/26 7:37,10.1111_x.pdf,Renamed.pdf\n")
        states, _ = doi_host.scan_issue_folder(str(base), ["10.1111/x"], {"outputDir": str(base)}, {})
        assert states == {"10.1111/x": "ok"}

    def test_truncated_and_html_files_are_partial_not_downloaded(self, tmp_path):
        base, issue, settings = self.make_base(tmp_path)
        (issue / "10.1177_cut.pdf").write_bytes(CUT_PDF)
        (issue / "10.1177_html.pdf").write_bytes(HTML)
        states, _ = self.scan(base, issue, settings, ["10.1177/cut", "10.1177/html"])
        assert states == {"10.1177/cut": "partial", "10.1177/html": "partial"}

    def test_a_good_copy_beats_a_bad_one(self, tmp_path):
        base, issue, settings = self.make_base(tmp_path)
        (issue / "10.1177_a1.pdf").write_bytes(CUT_PDF)
        (issue / "10.1177_a1 (1).pdf").write_bytes(GOOD_PDF)
        assert self.scan(base, issue, settings, ["10.1177/a1"])[0] == {"10.1177/a1": "ok"}

    def test_log_only_evidence(self, tmp_path):
        base, issue, settings = self.make_base(tmp_path)
        (issue / "download_log.txt").write_text(
            "2026-11-11 19:42:34 | SUCCESS | 10.1/moved | Moved away | /x/10.1_moved.pdf\n"
            "2026-11-11 19:42:35 | FAILED | 10.1/nf | Not found one | No PDF found on Sci-Hub or open-access\n"
            "2026-11-11 19:42:36 | CORRUPT | 10.1/bad | Corrupt one | Missing %PDF- header\n"
            "2026-11-11 19:42:37 | SUMMARY | 3 downloaded\n"
        )
        states, details = self.scan(base, issue, settings, ["10.1/moved", "10.1/nf", "10.1/bad", "10.1/never"])
        assert states == {"10.1/moved": "logged", "10.1/nf": "failed", "10.1/bad": "corrupt"}
        assert details["10.1/nf"] == "No PDF found on Sci-Hub or open-access"

    def test_last_log_line_wins_and_disk_beats_a_false_failure(self, tmp_path):
        base, issue, settings = self.make_base(tmp_path)
        (issue / "download_log.txt").write_text(
            "2026-11-11 19:00:00 | FAILED | 10.1/a | A | Cloudflare challenge wasn't cleared\n"
            "2026-11-11 19:05:00 | SUCCESS | 10.1/a | A | /x/10.1_a.pdf\n"
            "2026-11-11 19:06:00 | FAILED | 10.1/b | B | Cloudflare challenge wasn't cleared\n"
        )
        (issue / "10.1_b.pdf").write_bytes(GOOD_PDF)   # saved despite the FAILED line
        states, _ = self.scan(base, issue, settings, ["10.1/a", "10.1/b"])
        assert states == {"10.1/a": "logged", "10.1/b": "ok"}

    def test_missing_folder_has_no_evidence(self, tmp_path):
        base = tmp_path / "autorename"
        base.mkdir()
        assert doi_host.scan_issue_folder(str(base / "nope"), ["10.1/x"], {"outputDir": str(base)}, {}) == ({}, {})

    def test_rename_log_outside_the_allowed_roots_is_not_read(self, tmp_path):
        outside = tmp_path / "elsewhere"
        issue = outside / "issue"
        issue.mkdir(parents=True)
        (outside / "rename_log.csv").write_text('timestamp,old_name,new_name\nt,"issue/10.1_a.pdf","issue/T.pdf"\n')
        (issue / "T.pdf").write_bytes(GOOD_PDF)
        assert doi_host.find_rename_log(str(issue), {"outputDir": str(tmp_path / "autorename")}) is None


# ---------------------------------------------------------------------------
# Files the OS lets the host see but not open (macOS privacy gate on ~/Downloads)
# ---------------------------------------------------------------------------

@contextlib.contextmanager
def unreadable(*paths):
    """chmod 000: stat still works, open() raises PermissionError -- the same
    split macOS's TCC makes for a file this process didn't create."""
    if os.geteuid() == 0:
        pytest.skip("root ignores file permissions")
    for p in paths:
        os.chmod(p, 0)
    try:
        yield
    finally:
        for p in paths:
            os.chmod(p, 0o644)


class TestBlockedFiles:
    def test_unreadable_pdf_is_blocked_not_missing(self, tmp_path):
        f = tmp_path / "a.pdf"
        f.write_bytes(GOOD_PDF)
        with unreadable(f):
            assert doi_host.pdf_integrity(str(f)) == "blocked"

    def test_unreadable_empty_file_is_still_known_not_to_be_a_pdf(self, tmp_path):
        f = tmp_path / "empty.pdf"
        f.write_bytes(b"")
        with unreadable(f):
            assert doi_host.pdf_integrity(str(f)) == "notpdf"

    def test_a_stat_that_is_refused_is_never_taken_as_existence(self, tmp_path):
        if os.geteuid() == 0:
            pytest.skip("root ignores file permissions")
        sealed = tmp_path / "sealed"
        sealed.mkdir()
        (sealed / "a.pdf").write_bytes(GOOD_PDF)
        os.chmod(sealed, 0)
        try:
            assert doi_host.pdf_integrity(str(sealed / "a.pdf")) == "missing"
            assert doi_host.pdf_integrity(str(sealed / "nope.pdf")) == "missing"
        finally:
            os.chmod(sealed, 0o755)


class TestScanWhenBlocked:
    def make(self, tmp_path):
        base = tmp_path / "autorename"
        issue = base / "Journal Vol 5 Issue 1"
        issue.mkdir(parents=True)
        return base, issue, {"outputDir": str(base)}

    def test_unreadable_pdf_is_present_and_counted(self, tmp_path):
        base, issue, settings = self.make(tmp_path)
        pdf = issue / "10.1177_a1.pdf"
        pdf.write_bytes(GOOD_PDF)
        diag = {}
        with unreadable(pdf):
            states, _ = doi_host.scan_issue_folder(str(issue), ["10.1177/a1", "10.1177/a2"], settings, {}, diag)
        assert states == {"10.1177/a1": "present"}
        assert diag == {"blocked_files": 1}

    def test_unreadable_rename_log_is_reported_and_falls_back_to_the_log(self, tmp_path):
        base, issue, settings = self.make(tmp_path)
        (issue / "T - A.pdf").write_bytes(GOOD_PDF)
        csv_file = base / "rename_log.csv"
        csv_file.write_text('timestamp,old_name,new_name\nt,"Journal Vol 5 Issue 1/10.1177_a1.pdf","Journal Vol 5 Issue 1/T - A.pdf"\n')
        (issue / "download_log.txt").write_text("2026-11-11 19:42:34 | SUCCESS | 10.1177/a1 | T | /x/10.1177_a1.pdf\n")
        diag = {}
        with unreadable(csv_file):
            states, _ = doi_host.scan_issue_folder(str(issue), ["10.1177/a1"], settings, {}, diag)
        # Without the CSV the renamed file can't be located, so only the log vouches for it.
        assert states == {"10.1177/a1": "logged"}
        assert diag == {"unreadable_rename_logs": 1}

    def test_unreadable_folder_log_is_reported(self, tmp_path):
        base, issue, settings = self.make(tmp_path)
        log = issue / "download_log.txt"
        log.write_text("2026-11-11 19:42:34 | SUCCESS | 10.1177/a1 | T | x\n")
        diag = {}
        with unreadable(log):
            states, _ = doi_host.scan_issue_folder(str(issue), ["10.1177/a1"], settings, {}, diag)
        assert states == {}
        assert diag == {"unreadable_logs": 1}

    def test_a_clean_scan_reports_nothing_blocked(self, tmp_path):
        base, issue, settings = self.make(tmp_path)
        (issue / "10.1177_a1.pdf").write_bytes(GOOD_PDF)
        diag = {}
        doi_host.scan_issue_folder(str(issue), ["10.1177/a1"], settings, {}, diag)
        assert diag == {}

    def test_handler_reply_carries_access_and_interpreter(self, tmp_path):
        base, issue, settings = self.make(tmp_path)
        pdf = issue / "10.1177_a1.pdf"
        pdf.write_bytes(GOOD_PDF)
        (issue / "10.1177_a3.pdf").write_bytes(GOOD_PDF)
        msg = {"action": "scan_issue_downloads", "settings": settings,
               "issues": [{"folder": str(issue), "dois": ["10.1177/a1", "10.1177/a3"]}]}
        with unreadable(pdf):
            reply = doi_host.handle_scan_issue_downloads(msg)
        assert reply["status"] == "ok"
        assert reply["states"] == {"10.1177/a1": "present", "10.1177/a3": "ok"}
        assert reply["access"]["blocked_files"] == 1
        assert reply["access"]["unreadable_rename_logs"] == 0
        assert reply["access"]["python"] == sys.executable
        assert reply["access"]["python_version"].count(".") == 2

    def test_handler_clean_reply_has_zero_counts(self, tmp_path):
        base, issue, settings = self.make(tmp_path)
        (issue / "10.1177_a1.pdf").write_bytes(GOOD_PDF)
        reply = doi_host.handle_scan_issue_downloads(
            {"action": "scan_issue_downloads", "settings": settings, "issues": [{"folder": str(issue), "dois": ["10.1177/a1"]}]})
        assert reply["states"] == {"10.1177/a1": "ok"}
        assert (reply["access"]["blocked_files"], reply["access"]["unreadable_logs"], reply["access"]["unreadable_rename_logs"]) == (0, 0, 0)

    def test_handler_rejects_bad_input(self):
        assert doi_host.handle_scan_issue_downloads({"issues": "nope"})["status"] == "error"
        big = {"issues": [{"folder": "x", "dois": ["10.1/a"] * (doi_host.SCAN_MAX_DOIS + 1)}]}
        assert doi_host.handle_scan_issue_downloads(big)["status"] == "error"


# ---------------------------------------------------------------------------
# How Chrome launches the host (macOS privacy rules)
# ---------------------------------------------------------------------------
class TestHostLaunch:
    """macOS decides which files the host may open under ~/Downloads by the
    program Chrome *launched*. With `#!/usr/bin/env python3` that program is
    /usr/bin/env, which gets EPERM on every PDF and rename log it did not
    write itself (stat still works), so a real-Chrome resume scan found nothing
    on disk. Checked with launchd jobs on the author's Mac: the same host and
    the same Apple Python 3.9.6 read all 159 DOIs' files when line 1 named
    /usr/bin/python3 and read none of them when it went through env."""

    def test_host_launch_line(self):
        with open(doi_host.__file__, encoding="utf-8") as f:
            first = f.readline().strip()
        assert first.startswith("#!"), "doi_host.py must start with a shebang"
        interpreter = first[2:].split()[0]
        assert os.path.basename(interpreter) != "env", (
            "line 1 goes through /usr/bin/env: on macOS that launches `env`, which "
            "is refused access to files in ~/Downloads, so the resume scan goes "
            "blind. Point it straight at an interpreter (see the module docstring).")
        assert os.path.isabs(interpreter), "use an absolute interpreter path"
