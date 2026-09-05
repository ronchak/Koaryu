import json
import unittest

from tests.performance.dashboard_summary_fixture import build_tables, load_manifest, measure_profile


class DashboardSummaryPerformanceFixtureTest(unittest.TestCase):
    def test_manifest_cardinalities_are_fully_realized_without_emitting_rows(self):
        manifest = load_manifest()
        for profile, definition in manifest["profiles"].items():
            tables = build_tables(definition["cardinalities"])
            self.assertEqual(
                {table: len(rows) for table, rows in tables.items()},
                definition["cardinalities"],
            )
            self.assertNotIn("rows", json.dumps({"profile": profile, "cardinalities": definition["cardinalities"]}))

    def test_real_summary_measurement_has_expected_query_and_row_counts(self):
        expected = {name: (27, 30) for name in ("small", "medium", "large")}
        for profile, (query_count, row_count) in expected.items():
            with self.subTest(profile=profile):
                evidence = measure_profile(profile, "a" * 40)
                metrics = evidence["metrics"]
                self.assertEqual(metrics["table_query_count"], query_count)
                self.assertEqual(metrics["rpc_count"], 3)
                self.assertEqual(metrics["auth_call_count"], 7)
                self.assertEqual(metrics["cache_hit_rpc_count"], 0)
                self.assertEqual(metrics["concurrent_miss_rpc_count"], 1)
                self.assertEqual(metrics["invalidation_rpc_count"], 1)
                self.assertEqual(metrics["denied_rpc_count"], 0)
                self.assertEqual(metrics["total_provider_call_count"], query_count + 10)
                self.assertEqual(metrics["returned_row_count"], row_count)
                # Context table rows plus three fact objects; no raw fixture rows emitted.
                self.assertTrue(metrics["data_ready"])
                self.assertGreater(metrics["serialized_response_payload_bytes"], 0)
                self.assertNotIn("Fixture", json.dumps(evidence))
                self.assertNotIn("fixture-student", json.dumps(evidence))


if __name__ == "__main__":
    unittest.main()
