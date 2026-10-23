import re
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from fastapi.testclient import TestClient

from experiments.mcp_actions.server import build_app
from experiments.mcp_actions.store import Store

ORIGIN = "http://127.0.0.1:8110"


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.at = 1_800_000_000
        self.store = Store.create(
            Path(self.directory.name) / "state", clock=lambda: self.at
        )
        self.a, self.b = self.store.seed()
        self.app = build_app(self.store, ORIGIN)
        self.client = TestClient(self.app, base_url=ORIGIN, follow_redirects=False)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def mcp(self, name, arguments, token=None):
        return self.client.post(
            "/mcp",
            headers={
                "Authorization": "Bearer " + (token or self.a["assistant_token"]),
                "Accept": "application/json, text/event-stream",
            },
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
        )

    def preview(self, tag="competition"):
        response = self.mcp(
            "preview_student_tag_add", {"student_id": self.a["student_id"], "tag": tag}
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["result"].get("isError"))
        return response.json()["result"]["structuredContent"]

    def login(self, fixture=None):
        fixture = fixture or self.a
        response = self.client.post(
            "/owner/login",
            headers={"Origin": ORIGIN},
            data={
                "username": fixture["username"],
                "password": fixture["password"],
                "proposal_id": "",
            },
        )
        self.assertEqual(response.status_code, 303)
        self.assertIn("HttpOnly", response.headers["set-cookie"])
        self.assertIn("SameSite=strict", response.headers["set-cookie"])
        self.assertIn("Path=/owner", response.headers["set-cookie"])
        view = self.client.get("/owner")
        return re.search(r'name="csrf" value="([^\"]+)"', view.text).group(1)

    def decision(self, proposal, csrf, **changes):
        values = {
            "csrf": csrf,
            "digest": proposal["digest"],
            "decision": "approve",
            "confirm": "reviewed",
            **changes,
        }
        return self.client.post(
            "/owner/proposals/" + proposal["proposal_id"] + "/decision",
            headers={"Origin": ORIGIN},
            data=values,
        )

    def test_real_mcp_preview_owner_form_approval_execution_and_replay(self):
        proposal = self.preview()
        arguments = {
            "proposal_id": proposal["proposal_id"],
            "idempotency_key": str(uuid4()),
        }
        self.assertTrue(
            self.mcp("execute_student_tag_add", arguments).json()["result"]["isError"]
        )
        self.assertEqual(self.decision(proposal, self.login()).status_code, 303)
        first = self.mcp("execute_student_tag_add", arguments).json()["result"]
        self.assertFalse(first.get("isError"))
        self.assertEqual(
            first["structuredContent"]["after"], {"tags": ["competition", "youth"]}
        )
        replay = self.mcp("execute_student_tag_add", arguments).json()["result"][
            "structuredContent"
        ]
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["receipt_id"], first["structuredContent"]["receipt_id"])
        self.assertIn(replay["receipt_id"], self.client.get("/owner").text)

    def test_assistant_bearer_cannot_supply_owner_confirmation(self):
        proposal = self.preview()
        response = self.client.post(
            "/owner/proposals/" + proposal["proposal_id"] + "/decision",
            headers={
                "Origin": ORIGIN,
                "Authorization": "Bearer " + self.a["assistant_token"],
            },
            data={
                "csrf": "forged",
                "digest": proposal["digest"],
                "decision": "approve",
                "confirm": "reviewed",
            },
        )
        self.assertEqual(response.status_code, 401)
        for name in ["approve", "approve_proposal", "run_sql"]:
            response = self.mcp(
                name, {"proposal_id": proposal["proposal_id"], "approved": True}
            )
            self.assertTrue(response.json()["result"]["isError"])

    def test_wrong_origin_host_csrf_and_missing_human_review_are_refused(self):
        proposal = self.preview()
        csrf = self.login()
        path = "/owner/proposals/" + proposal["proposal_id"] + "/decision"
        values = {
            "csrf": csrf,
            "digest": proposal["digest"],
            "decision": "approve",
            "confirm": "reviewed",
        }
        self.assertEqual(self.client.post(path, data=values).status_code, 403)
        self.assertEqual(
            self.client.post(
                path, headers={"Origin": "https://attacker.invalid"}, data=values
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.get("/owner", headers={"Host": "attacker.invalid"}).status_code,
            421,
        )
        self.assertEqual(self.decision(proposal, "forged").status_code, 403)
        self.assertEqual(self.decision(proposal, csrf, confirm="").status_code, 422)
        self.assertEqual(
            self.decision(proposal, csrf, approved="true").status_code, 422
        )

    def test_wrong_owner_cannot_view_or_approve_proposal(self):
        proposal = self.preview()
        csrf = self.login(self.b)
        response = self.client.get("/owner/proposals/" + proposal["proposal_id"])
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("Cedar Example Student", response.text)
        self.assertEqual(self.decision(proposal, csrf).status_code, 404)

    def test_read_tokens_and_anonymous_mcp_requests_are_not_action_authority(self):
        for token in [
            "not-a-real-read-token",
            "eyJhbGciOiJIUzI1NiJ9.synthetic.read-session",
        ]:
            response = self.mcp(
                "preview_student_tag_add",
                {"student_id": self.a["student_id"], "tag": "tag"},
                token,
            )
            self.assertEqual(response.status_code, 401)
        self.assertEqual(self.client.post("/mcp", json={}).status_code, 401)

    def test_extra_model_identity_or_approval_parameters_cannot_be_smuggled(self):
        for field in ["ctx", "studio_id", "actor_id", "approved", "sql"]:
            response = self.mcp(
                "preview_student_tag_add",
                {
                    "student_id": self.a["student_id"],
                    "tag": "competition",
                    field: "untrusted",
                },
            )
            self.assertTrue(response.json()["result"]["isError"])
        with self.store.transaction() as db:
            self.assertEqual(
                db.execute("SELECT count(*) FROM proposals").fetchone()[0], 0
            )

    def test_stored_names_and_tag_values_are_escaped_in_owner_html(self):
        with self.store.transaction() as db:
            db.execute(
                "UPDATE students SET name=? WHERE id=?",
                ('<script>alert("name")</script>', self.a["student_id"]),
            )
        proposal = self.preview("<img src=x onerror=alert(1)>")
        self.login()
        response = self.client.get("/owner/proposals/" + proposal["proposal_id"])
        self.assertIn("&lt;script&gt;", response.text)
        self.assertIn("&lt;img", response.text)
        self.assertNotIn("<script>", response.text)
        self.assertNotIn("<img", response.text)
        self.assertIn(
            "frame-ancestors 'none'", response.headers["content-security-policy"]
        )
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.headers["referrer-policy"], "same-origin")

    def test_expired_or_stale_proposal_is_visible_without_approve_button(self):
        proposal = self.preview()
        self.login()
        self.at += 301
        response = self.client.get("/owner/proposals/" + proposal["proposal_id"])
        self.assertIn("proposal expired", response.text)
        self.assertNotIn("Approve this change", response.text)
        self.assertIn(">Deny<", response.text)

    def test_owner_can_deny_and_revoke_but_model_cannot_execute_afterwards(self):
        proposal = self.preview()
        csrf = self.login()
        self.assertEqual(
            self.decision(proposal, csrf, decision="deny").status_code, 303
        )
        arguments = {
            "proposal_id": proposal["proposal_id"],
            "idempotency_key": str(uuid4()),
        }
        self.assertTrue(
            self.mcp("execute_student_tag_add", arguments).json()["result"]["isError"]
        )
        self.assertEqual(
            self.client.post(
                "/owner/connections/" + self.a["connection_id"] + "/revoke",
                headers={"Origin": ORIGIN},
                data={"csrf": csrf},
            ).status_code,
            303,
        )
        self.assertEqual(
            self.mcp("execute_student_tag_add", arguments).status_code, 401
        )

    def test_owner_form_and_mcp_body_are_bounded(self):
        self.assertEqual(
            self.client.post(
                "/owner/login",
                headers={
                    "Origin": ORIGIN,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                content=b"username=" + b"x" * 9000,
            ).status_code,
            413,
        )
        response = self.mcp(
            "preview_student_tag_add",
            {"student_id": self.a["student_id"], "tag": "x" * 17000},
        )
        self.assertEqual(response.status_code, 413)

    def test_four_predefined_tools_have_no_approval_tool_and_correct_annotations(self):
        response = self.client.post(
            "/mcp",
            headers={
                "Authorization": "Bearer " + self.a["assistant_token"],
                "Accept": "application/json, text/event-stream",
            },
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        )
        tools = {tool["name"]: tool for tool in response.json()["result"]["tools"]}
        self.assertEqual(
            set(tools),
            {
                "preview_student_tag_add",
                "execute_student_tag_add",
                "preview_lead_followup_set",
                "execute_lead_followup_set",
            },
        )
        for name, tool in tools.items():
            self.assertFalse(tool["annotations"]["readOnlyHint"])
            self.assertFalse(tool["annotations"]["openWorldHint"])
            self.assertEqual(
                tool["annotations"]["destructiveHint"],
                name == "execute_lead_followup_set",
            )
            self.assertNotIn("ctx", tool["inputSchema"]["properties"])
        self.assertEqual(
            set(tools["execute_student_tag_add"]["inputSchema"]["properties"]),
            {"proposal_id", "idempotency_key"},
        )


if __name__ == "__main__":
    unittest.main()
