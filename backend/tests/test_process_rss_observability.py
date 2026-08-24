import json
import os
import subprocess
import sys
import threading
import textwrap
import unittest

from app.services.process_rss_observability import (
    ALERT_COOLDOWN_SECONDS,
    CRITICAL_THRESHOLD_BYTES,
    SAMPLE_INTERVAL_SECONDS,
    WARNING_THRESHOLD_BYTES,
    ProcessRSSObserver,
    _parse_rss_bytes,
)


class FakeClock:
    def __init__(self, value=0.0):
        self.value = value

    def __call__(self):
        return self.value


class RecordingLogger:
    def __init__(self):
        self.records = []

    def info(self, message, *, extra):
        self.records.append(("INFO", message, extra))

    def warning(self, message, *, extra):
        self.records.append(("WARNING", message, extra))


def statm_for_bytes(rss_bytes, page_size=4096):
    assert rss_bytes % page_size == 0
    return f"100 {rss_bytes // page_size} 0 0 0 0 0"


def assert_message_matches_fields(test_case, record):
    _, message, fields = record
    test_case.assertEqual(
        message, json.dumps(fields, sort_keys=True, separators=(",", ":"))
    )
    test_case.assertEqual(json.loads(message), fields)


class ProcessRSSObservabilityTest(unittest.TestCase):
    def make_observer(
        self, *, clock=None, read_statm=None, page_size=4096, environment=None
    ):
        self.clock = clock or FakeClock()
        self.logger = RecordingLogger()
        return ProcessRSSObserver(
            monotonic=self.clock,
            read_statm=read_statm or (lambda: statm_for_bytes(1 * 1024 * 1024)),
            page_size=lambda: page_size,
            environment=environment or (lambda name: None),
            process_id=lambda: 12345,
            utc_timestamp=lambda: "2026-08-24T00:00:00Z",
            event_logger=self.logger,
        )

    def test_resident_pages_are_multiplied_by_page_size_and_invalid_values_rejected(self):
        self.assertEqual(_parse_rss_bytes("10 7 0", 4096), 7 * 4096)
        for statm_contents, page_size in (
            ("", 4096),
            ("10", 4096),
            ("10 -1", 4096),
            ("10 nope", 4096),
            ("10 0", 4096),
            ("10 2", 0),
            ("10 2", -1),
            ("10 2", 1.0),
            ("10 " + "9" * 100, 4096),
        ):
            with self.subTest(statm_contents=statm_contents, page_size=page_size):
                with self.assertRaises(ValueError):
                    _parse_rss_bytes(statm_contents, page_size)

    def test_threshold_boundaries_are_normal_warning_and_critical(self):
        for rss_bytes, expected_state, expected_level in (
            (WARNING_THRESHOLD_BYTES - 4096, "normal", "INFO"),
            (WARNING_THRESHOLD_BYTES, "warning", "WARNING"),
            (CRITICAL_THRESHOLD_BYTES, "critical", "WARNING"),
        ):
            with self.subTest(rss_bytes=rss_bytes):
                observer = self.make_observer(
                    read_statm=lambda rss_bytes=rss_bytes: statm_for_bytes(rss_bytes)
                )
                observer.observe()
                self.assertEqual(len(self.logger.records), 1)
                level, message, fields = self.logger.records[0]
                self.assertEqual(level, expected_level)
                self.assertEqual(json.loads(message)["event"], "process_rss_observation")
                self.assertEqual(fields["rss_bytes"], rss_bytes)
                self.assertEqual(fields["threshold_state"], expected_state)

    def test_normal_and_unavailable_samples_are_bounded_to_five_minutes(self):
        clock = FakeClock()
        reads = []
        observer = self.make_observer(
            clock=clock,
            read_statm=lambda: reads.append("read") or statm_for_bytes(1 * 1024 * 1024),
        )

        observer.observe()
        clock.value = SAMPLE_INTERVAL_SECONDS - 1
        observer.observe()
        self.assertEqual(len(reads), 1)
        self.assertEqual(len(self.logger.records), 1)
        clock.value = SAMPLE_INTERVAL_SECONDS
        observer.observe()
        self.assertEqual(len(reads), 2)
        self.assertEqual(len(self.logger.records), 2)

        unavailable_logger = RecordingLogger()
        unavailable_clock = FakeClock()
        unavailable_reads = []
        unavailable = ProcessRSSObserver(
            monotonic=unavailable_clock,
            read_statm=lambda: unavailable_reads.append("read") or "not statm",
            event_logger=unavailable_logger,
        )
        unavailable.observe()
        unavailable_clock.value = SAMPLE_INTERVAL_SECONDS - 1
        unavailable.observe()
        self.assertEqual(len(unavailable_reads), 1)
        self.assertEqual(len(unavailable_logger.records), 1)

    def test_alert_cooldown_suppresses_repeats_but_allows_warning_to_critical_escalation(self):
        clock = FakeClock()
        rss_bytes = [WARNING_THRESHOLD_BYTES]
        observer = self.make_observer(
            clock=clock,
            read_statm=lambda: statm_for_bytes(rss_bytes[0]),
        )

        observer.observe()
        self.assertEqual(len(self.logger.records), 1)
        for elapsed in (300, 600, 900, 1200, 1500):
            clock.value = elapsed
            observer.observe()
        self.assertEqual(len(self.logger.records), 1)

        clock.value = ALERT_COOLDOWN_SECONDS
        observer.observe()
        self.assertEqual(len(self.logger.records), 2)
        self.assertEqual(self.logger.records[-1][2]["threshold_state"], "warning")

        rss_bytes[0] = CRITICAL_THRESHOLD_BYTES
        clock.value += SAMPLE_INTERVAL_SECONDS
        observer.observe()
        self.assertEqual(len(self.logger.records), 3)

        immediate_clock = FakeClock()
        immediate_logger = RecordingLogger()
        immediate_rss = [WARNING_THRESHOLD_BYTES]
        immediate = ProcessRSSObserver(
            monotonic=immediate_clock,
            read_statm=lambda: statm_for_bytes(immediate_rss[0]),
            page_size=lambda: 4096,
            process_id=lambda: 12345,
            utc_timestamp=lambda: "2026-08-24T00:00:00Z",
            event_logger=immediate_logger,
        )
        immediate.observe()
        immediate_rss[0] = CRITICAL_THRESHOLD_BYTES
        immediate_clock.value = SAMPLE_INTERVAL_SECONDS
        immediate.observe()
        self.assertEqual(len(immediate_logger.records), 2)
        self.assertEqual(
            immediate_logger.records[-1][2]["threshold_state"], "critical"
        )
        self.assertEqual(self.logger.records[-1][2]["threshold_state"], "critical")

        clock.value += SAMPLE_INTERVAL_SECONDS
        observer.observe()
        self.assertEqual(len(self.logger.records), 3)

    def test_fields_are_private_sanitized_and_timestamped(self):
        commit = "a" * 40
        secret = "sk_live_secret-shaped-value"
        environment = {
            "RENDER_INSTANCE_ID": "srv-d7mogk1kh4rs73aq6hqg-gftcd",
            "RENDER_GIT_COMMIT": commit,
            "SUPABASE_SERVICE_ROLE_KEY": secret,
            "DATABASE_URL": "https://secret.example.invalid/db",
        }
        observer = self.make_observer(environment=environment.get)
        observer.observe()

        level, message, fields = self.logger.records[0]
        self.assertEqual(level, "INFO")
        assert_message_matches_fields(self, self.logger.records[0])
        self.assertEqual(fields["event"], "process_rss_observation")
        self.assertIsInstance(fields["rss_bytes"], int)
        self.assertEqual(fields["process_id"], 12345)
        self.assertEqual(fields["render_instance_id"], environment["RENDER_INSTANCE_ID"])
        self.assertEqual(fields["render_git_commit"], commit)
        self.assertEqual(fields["timestamp_utc"], "2026-08-24T00:00:00Z")
        serialized = repr((message, fields))
        self.assertNotIn(secret, serialized)
        self.assertNotIn(environment["DATABASE_URL"], serialized)

    def test_regex_valid_secret_shaped_instance_id_becomes_null(self):
        secret_instance = "Sk_live_secret-shaped-instance"
        observer = self.make_observer(
            environment=lambda name: {
                "RENDER_INSTANCE_ID": secret_instance,
                "RENDER_GIT_COMMIT": "a" * 40,
            }.get(name)
        )

        observer.observe()

        message = self.logger.records[0][1]
        fields = self.logger.records[0][2]
        self.assertIsNone(fields["render_instance_id"])
        self.assertNotIn(secret_instance, message)
        self.assertNotIn(secret_instance, repr(fields))

    def test_invalid_metadata_becomes_null_without_raw_values(self):
        secret_instance = "https://host.invalid/secret"
        secret_sha = "A" * 40
        observer = self.make_observer(
            environment=lambda name: {
                "RENDER_INSTANCE_ID": secret_instance,
                "RENDER_GIT_COMMIT": secret_sha,
            }.get(name)
        )
        observer.observe()
        fields = self.logger.records[0][2]
        self.assertIsNone(fields["render_instance_id"])
        self.assertIsNone(fields["render_git_commit"])
        self.assertNotIn(secret_instance, repr(fields))
        self.assertNotIn(secret_sha, repr(fields))

    def test_unavailable_source_is_sanitized_and_does_not_raise(self):
        secret_error = "SUPABASE_SERVICE_ROLE_KEY=secret customer@example.com https://private.invalid"
        observer = self.make_observer(
            read_statm=lambda: (_ for _ in ()).throw(RuntimeError(secret_error))
        )
        observer.observe()

        level, message, fields = self.logger.records[0]
        self.assertEqual(level, "WARNING")
        assert_message_matches_fields(self, self.logger.records[0])
        self.assertIsNone(fields["rss_bytes"])
        self.assertEqual(fields["threshold_state"], "unavailable")
        serialized = repr((message, fields))
        self.assertNotIn(secret_error, serialized)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", serialized)
        self.assertNotIn("customer@example.com", serialized)
        self.assertNotIn("private.invalid", serialized)

    def test_simultaneous_due_calls_produce_one_read_and_event(self):
        read_started = threading.Event()
        release_read = threading.Event()
        read_count = 0
        read_count_lock = threading.Lock()

        def read_statm():
            nonlocal read_count
            with read_count_lock:
                read_count += 1
            read_started.set()
            self.assertTrue(release_read.wait(timeout=2))
            return statm_for_bytes(1 * 1024 * 1024)

        observer = self.make_observer(read_statm=read_statm)
        threads = [threading.Thread(target=observer.observe) for _ in range(8)]
        for thread in threads:
            thread.start()
        self.assertTrue(read_started.wait(timeout=2))
        release_read.set()
        for thread in threads:
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())

        self.assertEqual(read_count, 1)
        self.assertEqual(len(self.logger.records), 1)

    def test_internal_exception_is_swallowed_and_logged_without_exception_detail(self):
        logger = RecordingLogger()
        observer = ProcessRSSObserver(
            monotonic=lambda: 0.0,
            read_statm=lambda: "10 1",
            page_size=lambda: 4096,
            environment=lambda name: (_ for _ in ()).throw(RuntimeError("secret")),
            process_id=lambda: (_ for _ in ()).throw(RuntimeError("pid secret")),
            utc_timestamp=lambda: (_ for _ in ()).throw(RuntimeError("timestamp secret")),
            event_logger=logger,
        )
        observer.observe()
        self.assertEqual(len(logger.records), 1)
        self.assertNotIn("secret", repr(logger.records[0]))

    def test_exact_uvicorn_configured_logging_shows_normal_and_warning_json(self):
        script = textwrap.dedent(
            """
            import logging
            import os
            import uvicorn

            from app.services.process_rss_observability import (
                ProcessRSSObserver,
                WARNING_THRESHOLD_BYTES,
            )

            assert uvicorn.__version__ == "0.30.0"

            class Clock:
                value = 0.0

            clock = Clock()
            rss_bytes = [1024 * 1024]
            secret_instance = "Sk_live_secret-shaped-instance"
            unrelated_secret = "rk_live_unrelated-secret"
            unrelated_url = "https://private.example.invalid/secret"
            exception_text = "provider exception detail"
            os.environ["SUPABASE_SERVICE_ROLE_KEY"] = unrelated_secret
            os.environ["DATABASE_URL"] = unrelated_url

            def environment(name):
                assert name in {"RENDER_INSTANCE_ID", "RENDER_GIT_COMMIT"}
                return {
                    "RENDER_INSTANCE_ID": secret_instance,
                    "RENDER_GIT_COMMIT": "a" * 40,
                }.get(name)

            observer = ProcessRSSObserver(
                monotonic=lambda: clock.value,
                read_statm=lambda: f"100 {rss_bytes[0] // 4096} 0 0 0 0 0",
                page_size=lambda: 4096,
                environment=environment,
                process_id=lambda: 123,
                utc_timestamp=lambda: "2026-08-24T00:00:00Z",
                event_logger=logging.getLogger(
                    "uvicorn.error.process_rss_observability"
                ),
            )
            uvicorn.Config("example:app").configure_logging()
            observer.observe()
            rss_bytes[0] = WARNING_THRESHOLD_BYTES
            clock.value = 300.0
            observer.observe()

            unavailable = ProcessRSSObserver(
                monotonic=lambda: clock.value,
                read_statm=lambda: (_ for _ in ()).throw(
                    RuntimeError(exception_text)
                ),
                page_size=lambda: 4096,
                environment=environment,
                process_id=lambda: 123,
                utc_timestamp=lambda: "2026-08-24T00:00:00Z",
                event_logger=logging.getLogger(
                    "uvicorn.error.process_rss_observability"
                ),
            )
            unavailable.observe()
            """
        )
        # The child process writes through Uvicorn's configured stderr handler;
        # capturing it avoids mutating pytest's process-global logging state.
        completed = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            check=True,
            env={
                **os.environ,
                "PYTHONPATH": os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
            },
            text=True,
        )

        lines = [
            line
            for line in completed.stderr.splitlines()
            if line.startswith(("INFO:", "WARNING:"))
        ]
        self.assertEqual(len(lines), 3, completed.stderr)
        self.assertTrue(lines[0].startswith("INFO:"), completed.stderr)
        self.assertTrue(lines[1].startswith("WARNING:"), completed.stderr)
        self.assertTrue(lines[2].startswith("WARNING:"), completed.stderr)
        expected_keys = {
            "event",
            "rss_bytes",
            "threshold_state",
            "process_id",
            "render_instance_id",
            "render_git_commit",
            "timestamp_utc",
        }
        for line in lines:
            payload = json.loads(line[line.index("{") :])
            self.assertEqual(set(payload), expected_keys)
            self.assertEqual(payload["event"], "process_rss_observation")
            self.assertIsNone(payload["render_instance_id"])
            self.assertEqual(payload["render_git_commit"], "a" * 40)
        payloads = [json.loads(line[line.index("{") :]) for line in lines]
        self.assertEqual(
            [payload["threshold_state"] for payload in payloads],
            ["normal", "warning", "unavailable"],
        )
        self.assertIsNone(payloads[2]["rss_bytes"])
        self.assertNotIn("Sk_live_secret-shaped-instance", completed.stderr)
        self.assertNotIn("rk_live_unrelated-secret", completed.stderr)
        self.assertNotIn("https://private.example.invalid/secret", completed.stderr)
        self.assertNotIn("provider exception detail", completed.stderr)


if __name__ == "__main__":
    unittest.main()
