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

import json
import os
import struct
import sys
import tempfile
import shutil
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import doi_host


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
