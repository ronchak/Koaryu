import json
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from experiments.mcp_actions.store import ActionError, Store


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.at = 1_800_000_000
        self.store = Store.create(
            Path(self.directory.name) / "state", clock=lambda: self.at
        )
        self.a, self.b = self.store.seed()
        self.owner = self.store.login(self.a["username"], self.a["password"])

    def preview(self, tag="competition"):
        return self.store.preview(
            self.a["assistant_token"], "student_tag_add", self.a["student_id"], tag
        )

    def approve(self, proposal):
        self.store.decide(
            self.owner["session"],
            self.owner["csrf"],
            proposal["proposal_id"],
            proposal["digest"],
            "approve",
        )
        return proposal

    def execute(self, proposal, key=None, action="student_tag_add"):
        return self.store.execute(
            self.a["assistant_token"],
            action,
            proposal["proposal_id"],
            key or str(uuid4()),
        )

    def row(self, table, record_id=None):
        with self.store.transaction() as db:
            return dict(
                db.execute(
                    f"SELECT * FROM {table} WHERE id=?",
                    (record_id or self.a["student_id"],),
                ).fetchone()
            )

    def count(self, table):
        with self.store.transaction() as db:
            return db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]

    def assert_refused(self, status, operation):
        with self.assertRaises(ActionError) as caught:
            operation()
        self.assertEqual(caught.exception.status, status)

    def test_owner_approved_tag_and_retry_have_one_effect_audit_and_receipt(self):
        proposal = self.preview("  competition  ")
        self.assertEqual(self.row("students")["revision"], 1)
        self.assertEqual(self.count("audit"), 0)
        self.assertNotIn("session_nonce", proposal)
        self.assert_refused(409, lambda: self.execute(proposal))
        self.approve(proposal)
        key = str(uuid4())
        first, again = self.execute(proposal, key), self.execute(proposal, key)
        self.assertEqual(first["after"], {"tags": ["competition", "youth"]})
        self.assertFalse(first["replayed"])
        self.assertTrue(again["replayed"])
        self.assertEqual(first["receipt_id"], again["receipt_id"])
        self.assertEqual(self.row("students")["revision"], 2)
        self.assertEqual((self.count("audit"), self.count("receipts")), (1, 1))

    def test_set_and_clear_followup_never_change_other_lead_fields(self):
        for value in ["2026-11-03", None]:
            before = self.row("leads", self.a["lead_id"])
            proposal = self.store.preview(
                self.a["assistant_token"], "lead_followup_set", self.a["lead_id"], value
            )
            self.approve(proposal)
            receipt = self.execute(proposal, action="lead_followup_set")
            after = self.row("leads", self.a["lead_id"])
            self.assertEqual(after["follow_up_date"], value)
            self.assertEqual(receipt["after"], {"follow_up_date": value})
            for field in ["id", "studio_id", "name", "converted_student_id", "deleted"]:
                self.assertEqual(before[field], after[field])

    def test_target_and_proposal_tenant_boundaries(self):
        self.assert_refused(
            404,
            lambda: self.store.preview(
                self.a["assistant_token"],
                "student_tag_add",
                self.b["student_id"],
                "competition",
            ),
        )
        proposal = self.approve(self.preview())
        self.assert_refused(
            404,
            lambda: self.store.execute(
                self.b["assistant_token"],
                "student_tag_add",
                proposal["proposal_id"],
                str(uuid4()),
            ),
        )
        other = self.store.login(self.b["username"], self.b["password"])
        self.assert_refused(
            404,
            lambda: self.store.decide(
                other["session"],
                other["csrf"],
                proposal["proposal_id"],
                proposal["digest"],
                "approve",
            ),
        )
        self.assert_refused(
            404,
            lambda: self.store.owner_view(other["session"], proposal["proposal_id"]),
        )
        self.assertEqual(self.count("receipts"), 0)

    def test_assistant_or_anonymous_identity_cannot_approve(self):
        proposal = self.preview()
        for session in [None, "", self.a["assistant_token"]]:
            with self.subTest(session_type="missing" if not session else "assistant"):
                self.assert_refused(
                    401,
                    lambda session=session: self.store.decide(
                        session,
                        self.owner["csrf"],
                        proposal["proposal_id"],
                        proposal["digest"],
                        "approve",
                    ),
                )
        self.assertEqual(self.count("receipts"), 0)

    def test_csrf_and_review_digest_are_required(self):
        proposal = self.preview()
        for csrf in [None, "", "forged", "é" * 32]:
            self.assert_refused(
                403,
                lambda csrf=csrf: self.store.decide(
                    self.owner["session"],
                    csrf,
                    proposal["proposal_id"],
                    proposal["digest"],
                    "approve",
                ),
            )
        self.assert_refused(
            409,
            lambda: self.store.decide(
                self.owner["session"],
                self.owner["csrf"],
                proposal["proposal_id"],
                "0" * 64,
                "approve",
            ),
        )
        self.assertEqual(
            self.store.owner_view(self.owner["session"])["proposals"][0]["status"],
            "pending",
        )

    def test_denial_and_second_decision_are_terminal(self):
        proposal = self.preview()
        self.store.decide(
            self.owner["session"],
            self.owner["csrf"],
            proposal["proposal_id"],
            proposal["digest"],
            "deny",
        )
        self.assert_refused(409, lambda: self.execute(proposal))
        self.assert_refused(409, lambda: self.approve(proposal))
        self.assertEqual(self.count("audit"), 0)

    def test_expired_proposal_cannot_be_approved_or_executed(self):
        first, second = self.preview(), self.approve(self.preview("leadership"))
        self.at += 301
        self.assert_refused(409, lambda: self.approve(first))
        self.assert_refused(409, lambda: self.execute(second))
        self.assertEqual(self.row("students")["revision"], 1)

    def test_proposal_never_outlives_grant(self):
        with self.store.transaction() as db:
            db.execute(
                "UPDATE connections SET expires_at=?,revision=revision+1 WHERE id=?",
                (self.at + 20, self.a["connection_id"]),
            )
        proposal = self.approve(self.preview())
        self.assertEqual(proposal["expires_at"], self.at + 20)
        self.at += 21
        self.assert_refused(401, lambda: self.execute(proposal))

    def test_revocation_refuses_pending_execution_and_completed_replay(self):
        completed, pending = (
            self.approve(self.preview()),
            self.approve(self.preview("leadership")),
        )
        key = str(uuid4())
        self.execute(completed, key)
        self.store.revoke(
            self.owner["session"], self.owner["csrf"], self.a["connection_id"]
        )
        self.assert_refused(401, lambda: self.execute(pending))
        self.assert_refused(401, lambda: self.execute(completed, key))
        self.assertEqual(self.count("receipts"), 1)

    def test_current_role_and_studio_eligibility_are_checked(self):
        proposal = self.approve(self.preview())
        with self.store.transaction() as db:
            db.execute(
                "UPDATE actors SET role='instructor' WHERE id=?", (self.a["actor_id"],)
            )
        self.assert_refused(403, lambda: self.execute(proposal))
        self.assert_refused(403, lambda: self.store.owner_view(self.owner["session"]))
        with self.store.transaction() as db:
            db.execute(
                "UPDATE actors SET role='admin' WHERE id=?", (self.a["actor_id"],)
            )
            db.execute("UPDATE studios SET active=0 WHERE id=?", (self.a["studio_id"],))
        self.assert_refused(403, lambda: self.execute(proposal))

    def test_changed_permissions_or_session_invalidates_approval(self):
        proposal = self.approve(self.preview())
        for field in ["revision", "session_nonce"]:
            with self.store.transaction() as db:
                if field == "revision":
                    db.execute(
                        "UPDATE connections SET revision=revision+1 WHERE id=?",
                        (self.a["connection_id"],),
                    )
                else:
                    db.execute(
                        "UPDATE connections SET session_nonce='replacement' WHERE id=?",
                        (self.a["connection_id"],),
                    )
            self.assert_refused(409, lambda: self.execute(proposal))
        with self.store.transaction() as db:
            db.execute(
                "UPDATE connections SET actions=? WHERE id=?",
                (json.dumps(["lead_followup_set"]), self.a["connection_id"]),
            )
        self.assert_refused(403, lambda: self.preview())

    def test_changed_grant_invalidates_old_receipt_replay(self):
        proposal = self.approve(self.preview())
        key = str(uuid4())
        self.execute(proposal, key)
        with self.store.transaction() as db:
            db.execute(
                "UPDATE connections SET revision=revision+1 WHERE id=?",
                (self.a["connection_id"],),
            )
        self.assert_refused(409, lambda: self.execute(proposal, key))
        self.assertEqual(self.count("receipts"), 1)

    def test_stale_target_and_undo_redo_are_refused(self):
        proposal = self.approve(self.preview())
        with self.store.transaction() as db:
            db.execute(
                "UPDATE students SET tags='[\"other\"]',revision=revision+1 WHERE id=?",
                (self.a["student_id"],),
            )
            db.execute(
                "UPDATE students SET tags='[\"youth\"]',revision=revision+1 WHERE id=?",
                (self.a["student_id"],),
            )
        self.assert_refused(409, lambda: self.execute(proposal))
        self.assertEqual(self.row("students")["revision"], 3)
        self.assertEqual(self.count("receipts"), 0)

    def test_deleted_or_converted_target_cannot_execute(self):
        student = self.approve(self.preview())
        lead = self.store.preview(
            self.a["assistant_token"], "lead_followup_set", self.a["lead_id"], None
        )
        self.approve(lead)
        with self.store.transaction() as db:
            db.execute(
                "UPDATE students SET deleted=1 WHERE id=?", (self.a["student_id"],)
            )
            db.execute(
                "UPDATE leads SET converted_student_id=? WHERE id=?",
                (self.a["student_id"], self.a["lead_id"]),
            )
        self.assert_refused(404, lambda: self.execute(student))
        self.assert_refused(409, lambda: self.execute(lead, action="lead_followup_set"))

    def test_noop_has_one_receipt_without_target_revision_change(self):
        proposal = self.approve(self.preview("youth"))
        receipt = self.execute(proposal)
        self.assertFalse(proposal["change_required"])
        self.assertEqual(receipt["outcome"], "no_change")
        self.assertEqual(self.row("students")["revision"], 1)
        self.assertEqual((self.count("receipts"), self.count("audit")), (1, 1))

    def test_retry_key_and_action_cannot_be_rebound(self):
        first = self.approve(self.preview())
        key = str(uuid4())
        self.execute(first, key)
        second = self.approve(self.preview("leadership"))
        self.assert_refused(409, lambda: self.execute(second, key))
        self.assert_refused(409, lambda: self.execute(first))
        self.assert_refused(
            409, lambda: self.execute(second, action="lead_followup_set")
        )
        self.assertEqual(self.count("audit"), 1)

    def test_rollback_after_business_change_does_not_strand_approval_or_receipt(self):
        proposal = self.approve(self.preview())
        key = str(uuid4())
        with (
            patch.object(
                self.store,
                "_after_domain_change",
                side_effect=RuntimeError("synthetic failure"),
            ),
            self.assertRaises(RuntimeError),
        ):
            self.execute(proposal, key)
        self.assertEqual(self.row("students")["revision"], 1)
        self.assertEqual(json.loads(self.row("students")["tags"]), ["youth"])
        self.assertEqual((self.count("audit"), self.count("receipts")), (0, 0))
        self.assertEqual(
            self.store.owner_view(self.owner["session"])["proposals"][0]["status"],
            "approved",
        )
        self.assertFalse(self.execute(proposal, key)["replayed"])

    def test_expiry_during_domain_change_rolls_back(self):
        proposal = self.approve(self.preview())

        def expire():
            self.at += 301

        with patch.object(self.store, "_after_domain_change", side_effect=expire):
            self.assert_refused(409, lambda: self.execute(proposal))
        self.assertEqual(self.row("students")["revision"], 1)
        self.assertEqual(self.count("receipts"), 0)

    def test_concurrent_identical_retries_apply_once(self):
        proposal, key, barrier = self.approve(self.preview()), str(uuid4()), Barrier(2)

        def execute():
            barrier.wait(timeout=2)
            return self.execute(proposal, key)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = [
                future.result(timeout=5)
                for future in [pool.submit(execute), pool.submit(execute)]
            ]
        self.assertEqual(
            sorted(result["replayed"] for result in results), [False, True]
        )
        self.assertEqual(
            {result["receipt_id"] for result in results}, {results[0]["receipt_id"]}
        )
        self.assertEqual(
            (self.row("students")["revision"], self.count("audit")), (2, 1)
        )

    def test_competing_approved_previews_cannot_overwrite(self):
        proposals = [
            self.approve(self.preview(tag)) for tag in ["competition", "leadership"]
        ]
        barrier = Barrier(2)

        def execute(proposal):
            barrier.wait(timeout=2)
            try:
                return self.execute(proposal)["outcome"]
            except ActionError as error:
                return error.status

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(execute, proposals))
        self.assertEqual(set(results), {"applied", 409})
        self.assertEqual(
            (self.row("students")["revision"], self.count("audit")), (2, 1)
        )

    def test_receipt_is_durable_and_retry_is_historical_after_later_target_edit(self):
        proposal, key = self.approve(self.preview()), str(uuid4())
        first = self.execute(proposal, key)
        reopened = Store(self.store.path, clock=lambda: self.at)
        self.at += 301
        with reopened.transaction() as db:
            db.execute(
                "UPDATE students SET tags='[\"later edit\"]',revision=revision+1 WHERE id=?",
                (self.a["student_id"],),
            )
        again = reopened.execute(
            self.a["assistant_token"], "student_tag_add", proposal["proposal_id"], key
        )
        self.assertEqual(again["receipt_id"], first["receipt_id"])
        self.assertEqual(json.loads(self.row("students")["tags"]), ["later edit"])
        self.assertEqual(self.count("audit"), 1)

    def test_proposal_contents_are_immutable_in_database(self):
        proposal = self.preview()
        with self.assertRaises(sqlite3.IntegrityError), self.store.transaction() as db:
            db.execute(
                "UPDATE proposals SET body='{}' WHERE id=?", (proposal["proposal_id"],)
            )

    def test_validation_refuses_sql_paths_other_operations_and_invalid_values(self):
        for target in ["1 OR 1=1", "../students", None]:
            self.assert_refused(
                422,
                lambda target=target: self.store.preview(
                    self.a["assistant_token"], "student_tag_add", target, "tag"
                ),
            )
        for tag in ["", "\n", "tag\n", "a" * 65, False, {"sql": "UPDATE"}]:
            self.assert_refused(422, lambda tag=tag: self.preview(tag))
        for value in ["2026-02-30", "tomorrow", "20261023", True]:
            self.assert_refused(
                422,
                lambda value=value: self.store.preview(
                    self.a["assistant_token"],
                    "lead_followup_set",
                    self.a["lead_id"],
                    value,
                ),
            )
        self.assert_refused(
            422,
            lambda: self.store.preview(
                self.a["assistant_token"], "send_email", self.a["lead_id"], "x"
            ),
        )


if __name__ == "__main__":
    unittest.main()
