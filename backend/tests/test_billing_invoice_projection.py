import unittest

from app.services.billing_invoice_projection import (
    invoice_line_period_bounds,
    invoice_metadata,
    invoice_subscription_id,
    invoice_subscription_item_id,
    local_invoice_status,
    merge_invoice_identity_from_stored_event,
    object_get,
    stripe_id,
    subscription_period_bounds,
)


class StripeLikeObject:
    def __init__(self, **values):
        self.__dict__.update(values)


class BillingInvoiceProjectionTests(unittest.TestCase):
    def test_stripe_object_helpers_accept_dicts_strings_and_attributes(self):
        self.assertEqual(stripe_id("in_1"), "in_1")
        self.assertEqual(stripe_id({"id": "in_2"}), "in_2")
        self.assertEqual(stripe_id(StripeLikeObject(id="in_3")), "in_3")
        self.assertEqual(object_get(StripeLikeObject(status="paid"), "status"), "paid")
        self.assertEqual(object_get(None, "status", "missing"), "missing")

    def test_invoice_metadata_merges_parent_line_and_invoice_precedence(self):
        invoice = {
            "parent": {
                "type": "subscription_details",
                "subscription_details": {"metadata": {"source": "parent", "payer_id": "payer_parent"}},
            },
            "lines": {
                "data": [{
                    "metadata": {"source": "line", "student_id": "student_1"},
                }]
            },
            "metadata": {"source": "invoice", "invoice_id": "invoice_local"},
        }

        self.assertEqual(invoice_metadata(invoice), {
            "source": "invoice",
            "payer_id": "payer_parent",
            "student_id": "student_1",
            "invoice_id": "invoice_local",
        })

    def test_invoice_subscription_ids_use_direct_parent_or_single_line_values(self):
        self.assertEqual(invoice_subscription_id({"subscription": {"id": "sub_direct"}}), "sub_direct")
        self.assertEqual(invoice_subscription_id({
            "parent": {
                "type": "subscription_details",
                "subscription_details": {"subscription": "sub_parent"},
            }
        }), "sub_parent")
        self.assertEqual(invoice_subscription_id({
            "lines": {
                "data": [
                    {"parent": {"subscription_item_details": {"subscription": "sub_line", "subscription_item": "si_1"}}},
                    {"subscription": "sub_line"},
                ]
            }
        }), "sub_line")
        self.assertIsNone(invoice_subscription_id({
            "lines": {"data": [{"subscription": "sub_1"}, {"subscription": "sub_2"}]}
        }))
        self.assertEqual(invoice_subscription_item_id({
            "lines": {"data": [{"parent": {"subscription_item_details": {"subscription_item": "si_1"}}}]}
        }), "si_1")

    def test_invoice_period_bounds_require_one_non_proration_period(self):
        self.assertEqual(invoice_line_period_bounds({
            "lines": {
                "data": [
                    {"proration": True, "period": {"start": 1, "end": 2}},
                    {"period": {"start": 10, "end": 20}},
                    {"period": {"start": 10, "end": 20}},
                ]
            }
        }), (10, 20))
        self.assertEqual(invoice_line_period_bounds({
            "lines": {"data": [{"period": {"start": 10, "end": 20}}, {"period": {"start": 30, "end": 40}}]}
        }), (None, None))

    def test_subscription_period_bounds_falls_back_to_item_range(self):
        self.assertEqual(subscription_period_bounds({
            "items": {
                "data": [
                    {"current_period_start": 10, "current_period_end": 30},
                    {"current_period_start": 5, "current_period_end": 40},
                ]
            }
        }), (5, 40))
        self.assertEqual(subscription_period_bounds({"current_period_start": 1, "current_period_end": 2}), (1, 2))

    def test_merge_invoice_identity_from_stored_event_fills_missing_parent_lines_and_metadata(self):
        merged = merge_invoice_identity_from_stored_event(
            {"id": "in_1"},
            {
                "parent": {"type": "subscription_details", "subscription_details": {"subscription": "sub_1"}},
                "lines": {"data": [{"subscription": "sub_1"}]},
                "metadata": {"studio_id": "studio_1"},
            },
        )

        self.assertEqual(merged["parent"]["subscription_details"]["subscription"], "sub_1")
        self.assertEqual(merged["lines"]["data"][0]["subscription"], "sub_1")
        self.assertEqual(merged["metadata"]["studio_id"], "studio_1")

    def test_local_invoice_status_maps_unknown_values_to_open(self):
        self.assertEqual(local_invoice_status("void"), "void")
        self.assertEqual(local_invoice_status("uncollectible"), "uncollectible")
        self.assertEqual(local_invoice_status("paid"), "paid")
        self.assertEqual(local_invoice_status("weird_future_status"), "open")


if __name__ == "__main__":
    unittest.main()
