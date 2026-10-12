import json
import unittest

from tests.performance.dashboard_home_fixture import build_tables, load_manifest, measure_profile

# Measured at the manifest's creation; the budgets allow one more query and row.
EXPECTED_QUERIES_AND_ROWS = {
    "small": (72, 750),
    "medium": (93, 19818),
    "large": (282, 107184),
}
# Machine-dependent metrics; the gate still enforces their ceilings.
ENVIRONMENT_METRICS = {"total_duration_ms", "max_stage_duration_ms", "peak_rss_bytes"}


class DashboardHomePerformanceFixtureTest(unittest.TestCase):
    def test_manifest_cardinalities_are_fully_realized_without_emitting_rows(self):
        manifest = load_manifest()
        for profile, definition in manifest["profiles"].items():
            tables = build_tables(definition["cardinalities"])
            self.assertEqual(
                {table: len(rows) for table, rows in tables.items()},
                definition["cardinalities"],
            )
            self.assertNotIn(
                "rows",
                json.dumps({"profile": profile, "cardinalities": definition["cardinalities"]}),
            )

    def test_real_home_measurement_has_expected_counts_within_budget(self):
        manifest = load_manifest()
        for profile, (query_count, row_count) in EXPECTED_QUERIES_AND_ROWS.items():
            with self.subTest(profile=profile):
                evidence = measure_profile(profile, "a" * 40)
                metrics = evidence["metrics"]
                self.assertEqual(evidence["route"], "dashboard-home")
                self.assertEqual(metrics["table_query_count"], query_count)
                self.assertEqual(metrics["returned_row_count"], row_count)
                self.assertEqual(metrics["auth_call_count"], 7)
                self.assertEqual(metrics["rpc_count"], 3)
                self.assertEqual(metrics["cache_hit_rpc_count"], 0)
                self.assertEqual(metrics["concurrent_miss_rpc_count"], 1)
                self.assertEqual(metrics["invalidation_rpc_count"], 1)
                self.assertEqual(metrics["denied_rpc_count"], 0)
                self.assertEqual(metrics["materialize_rpc_count"], 0)
                self.assertEqual(metrics["promotion_load_count"], 3)
                # Due rows plus the separate overdue count on six authorized requests.
                self.assertEqual(metrics["follow_up_query_count"], 12)
                self.assertEqual(metrics["total_provider_call_count"], query_count + 10)
                self.assertTrue(metrics["data_ready"])
                self.assertGreater(metrics["peak_rss_bytes"], 0)
                self.assertGreater(metrics["serialized_response_payload_bytes"], 0)
                for metric, ceiling in manifest["profiles"][profile]["budgets"].items():
                    if metric not in ENVIRONMENT_METRICS:
                        self.assertLessEqual(metrics[metric], ceiling, metric)
                # Aggregate-only: no names, ids or payload text.
                self.assertNotIn("Fixture", json.dumps(evidence))
                self.assertNotIn("fixture-", json.dumps(evidence))


if __name__ == "__main__":
    unittest.main()
