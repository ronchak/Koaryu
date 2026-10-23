"""Package checks are offline and synthetic; they do not prove a public deployment."""

import importlib.util
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("prepare-chatgpt-package.py")
SPEC = importlib.util.spec_from_file_location("koaryu_package", SCRIPT)
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)


class PackageTest(unittest.TestCase):
    def setUp(self):
        self.manifest, self.assets = package.check_source()
        self.facts = {
            "developer_name": "Synthetic publisher for tests",
            "countries": ["US", "GB"],
            "commerce": False,
            "commerce_description": "Synthetic test declaration only.",
            "demo_recording_url": "https://review.koaryu.app/native-read-walkthrough",
            "urls": {
                "websiteURL": "https://koaryu.app/ai-connections",
                "supportURL": "https://koaryu.app/support",
                "privacyPolicyURL": "https://koaryu.app/privacy",
                "termsOfServiceURL": "https://koaryu.app/terms",
            },
            "mcp_url": "https://mcp.koaryu.app/mcp",
        }

    def test_source_does_not_invent_publisher_or_public_server(self):
        extension = self.manifest["extensions"]["com.openai"]
        self.assertNotIn("developerName", extension["interface"])
        self.assertNotIn("countries", extension["publication"])
        self.assertNotIn("commerce", extension["review"])
        self.assertFalse((package.SOURCE / "mcp.json").exists())

    def test_missing_facts_fail_without_creating_archive(self):
        with self.assertRaisesRegex(ValueError, "all listing facts"):
            package.complete_manifest(self.manifest, {})

    def test_unknown_or_credential_fields_are_not_accepted(self):
        self.facts["client_secret"] = "never-package-test-credentials"
        with self.assertRaisesRegex(ValueError, "unknown settings"):
            package.complete_manifest(self.manifest, self.facts)

    def test_oauth_is_explicitly_non_oidc_and_offline_access_only(self):
        _, mcp = package.complete_manifest(self.manifest, self.facts)
        auth = mcp["mcpServers"]["koaryu"]["extensions"]["com.openai"]["auth"]
        self.assertEqual(
            auth,
            {
                "type": "oauth",
                "client": {"mode": "dcr"},
                "baseScopes": ["offline_access"],
                "defaultScopes": ["offline_access"],
                "oidcEnabled": False,
            },
        )
        self.assertNotIn(
            "developerName", self.manifest["extensions"]["com.openai"]["interface"]
        )

    def test_all_available_countries_is_explicit_not_default(self):
        self.facts["countries"] = []
        manifest, _ = package.complete_manifest(self.manifest, self.facts)
        self.assertEqual(
            manifest["extensions"]["com.openai"]["publication"]["countries"], []
        )
        self.facts.pop("countries")
        with self.assertRaises(ValueError):
            package.complete_manifest(self.manifest, self.facts)

    def test_rejects_private_insecure_reserved_and_credential_urls(self):
        for value in [
            "http://koaryu.app/mcp",
            "https://localhost/mcp",
            "https://127.0.0.1/mcp",
            "https://10.0.0.1/mcp",
            "https://example.com/mcp",
            "https://placeholder.koaryu.app/mcp",
            "https://review.invalid/mcp",
            "https://owner:password@koaryu.app/mcp",
            "https://koaryu.app/mcp#token",
            "https://koaryu.app:8443/mcp",
        ]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                package.https_url(value)

    def test_private_dns_and_redirect_are_refused(self):
        with patch.object(
            package.socket,
            "getaddrinfo",
            return_value=[(2, 1, 6, "", ("127.0.0.1", 443))],
        ):
            with self.assertRaisesRegex(ValueError, "private address"):
                package.public_host("https://koaryu.app/support")
            with self.assertRaises(ValueError):
                package.PublicRedirects().redirect_request(
                    None, None, 302, "", {}, "https://127.0.0.1/private"
                )

    def test_missing_privacy_coverage_stops_before_mcp_probe(self):
        manifest, mcp = package.complete_manifest(self.manifest, self.facts)
        with patch.object(
            package,
            "fetch",
            return_value=(200, {"Content-Type": "text/html"}, b"Koaryu privacy"),
        ) as fetch:
            with self.assertRaisesRegex(ValueError, "privacy page"):
                package.verify_public(manifest, mcp)
            self.assertEqual(fetch.call_count, 1)

    def test_public_discovery_is_bound_to_exact_resource(self):
        manifest, mcp = package.complete_manifest(self.manifest, self.facts)

        def response(url, **kwargs):
            if url == self.facts["mcp_url"]:
                return (
                    401,
                    {
                        "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.koaryu.app/.well-known/oauth-protected-resource/mcp"'
                    },
                    b"",
                )
            if "oauth-protected-resource" in url:
                return (
                    200,
                    {},
                    json.dumps(
                        {
                            "resource": "https://wrong.koaryu.app/mcp",
                            "authorization_servers": ["https://auth.koaryu.app"],
                        }
                    ).encode(),
                )
            return (
                200,
                {"Content-Type": "text/html"},
                b"Koaryu AI connections assistant mailto:koaryu@outlook.com",
            )

        with (
            patch.object(package, "fetch", side_effect=response),
            self.assertRaisesRegex(ValueError, "exact MCP audience"),
        ):
            package.verify_public(manifest, mcp)

    def test_final_zip_has_only_manifest_mcp_and_real_assets(self):
        manifest, mcp = package.complete_manifest(self.manifest, self.facts)
        first = package.archive_bytes(manifest, mcp, self.assets)
        self.assertEqual(first, package.archive_bytes(manifest, mcp, self.assets))
        with zipfile.ZipFile(io.BytesIO(first)) as archive:
            self.assertEqual(
                set(archive.namelist()),
                {
                    "koaryu/plugin.json",
                    "koaryu/mcp.json",
                    "koaryu/assets/logo.png",
                    "koaryu/assets/composer-icon.png",
                },
            )
            self.assertEqual(json.loads(archive.read("koaryu/mcp.json")), mcp)
            self.assertIsNone(archive.testzip())
            self.assertNotIn(b"client_secret", archive.read("koaryu/mcp.json"))

    def test_icon_traversal_symlinks_and_wrong_file_type_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            (source / "assets").mkdir()
            (source / "assets/bad.png").write_text("not a PNG")
            (source / "assets/link.png").symlink_to(package.SOURCE / "assets/logo.png")
            for name in [
                "./assets/../../private.png",
                "./assets/link.png",
                "./assets/bad.png",
            ]:
                with self.subTest(name=name), self.assertRaises(ValueError):
                    package.png_asset(source, name, 48)


if __name__ == "__main__":
    unittest.main()
