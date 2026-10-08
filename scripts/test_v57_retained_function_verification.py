"""Exact accepted source and metadata boundaries for the one V57 body repair."""

import copy
from pathlib import Path
import subprocess
import unittest

import v57_retained_function_verification as verification

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = "supabase/migrations/20261005105341_automation_workflow_graph_v57.sql"


class RetentionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.accepted = subprocess.check_output(
            ["git", "show", verification.BASE + ":" + MIGRATION], cwd=ROOT
        ).decode()
        cls.current = (ROOT / MIGRATION).read_text()
        cls.old_body = verification.source_functions(cls.accepted)[
            verification.TIMED_FUNCTION
        ][0]
        cls.new_body = verification.source_functions(cls.current)[
            verification.TIMED_FUNCTION
        ][0]

    def test_exact_source_inventory_and_reviewed_pair(self):
        self.assertEqual(
            verification.verify_retained_sources(self.accepted, self.current),
            {
                "frozen_functions": 212,
                "current_functions": 214,
                "reviewed_change": verification.TIMED_FUNCTION,
            },
        )

    def test_wrong_frozen_source_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "Frozen complete"):
            verification.verify_retained_sources(self.accepted + "\n", self.current)

    def test_unknown_timed_body_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "exact reviewed"):
            verification.verify_retained_sources(
                self.accepted,
                self.current.replace(self.new_body, self.new_body + "\n", 1),
            )

    def test_other_function_body_is_refused(self):
        name = next(
            name
            for name in verification.source_functions(self.accepted)
            if name != verification.TIMED_FUNCTION
        )
        body = verification.source_functions(self.accepted)[name][0]
        with self.assertRaisesRegex(RuntimeError, "Unaffected retained"):
            verification.verify_retained_sources(
                self.accepted, self.current.replace(body, body + "\n-- drift", 1)
            )

    def test_unknown_function_and_overload_are_refused(self):
        for name in ("private.unexpected_v57_owner", verification.TIMED_FUNCTION):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                verification.verify_retained_sources(
                    self.accepted,
                    self.current
                    + f"\nCREATE FUNCTION {name}() RETURNS integer LANGUAGE sql AS $$SELECT 1$$;",
                )

    def test_only_exact_body_changes_and_every_metadata_field_remains_equal(self):
        before = {
            "body": self.old_body,
            "acl": "postgres=X/postgres",
            "owner": "postgres",
            "settings": ["search_path="],
            "volatility": "v",
            "security_definer": False,
        }
        after = {**before, "body": self.new_body}
        self.assertTrue(
            verification.retained_function_equal(
                verification.TIMED_SIGNATURE, before, after
            )
        )
        for field in before:
            changed = copy.deepcopy(after)
            changed[field] = "unreviewed drift"
            with self.subTest(field=field):
                self.assertFalse(
                    verification.retained_function_equal(
                        verification.TIMED_SIGNATURE, before, changed
                    )
                )
        self.assertFalse(
            verification.retained_function_equal(
                verification.TIMED_SIGNATURE, before, {**after, "extra": 1}
            )
        )
        self.assertFalse(
            verification.retained_function_equal(
                verification.TIMED_SIGNATURE,
                before,
                {key: value for key, value in after.items() if key != "acl"},
            )
        )
        self.assertFalse(
            verification.retained_function_equal(
                "private.other(integer)", before, after
            )
        )
        self.assertTrue(
            verification.retained_function_equal(
                "private.other(integer)", before, before
            )
        )


if __name__ == "__main__":
    unittest.main()
