import subprocess
import sys
import unittest
from pathlib import Path


class ApiTypeGenerationTest(unittest.TestCase):
    def test_frontend_api_contract_types_are_current(self):
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run(
            [sys.executable, "scripts/generate-api-types.py", "--check"],
            cwd=root,
            capture_output=True,
            text=True,
        )

        self.assertEqual(
            result.returncode,
            0,
            result.stdout + result.stderr,
        )

    def test_array_item_unions_are_parenthesized(self):
        root = Path(__file__).resolve().parents[2]
        generated_types = (
            root / "frontend" / "src" / "types" / "generated" / "api-contracts.ts"
        ).read_text()

        self.assertIn("loc: (string | number)[];", generated_types)
        self.assertNotIn("loc: string | number[];", generated_types)

    def test_embedded_form_payload_contracts_are_generated(self):
        root = Path(__file__).resolve().parents[2]
        generated_types = (
            root / "frontend" / "src" / "types" / "generated" / "api-contracts.ts"
        ).read_text()

        self.assertIn("export interface ApiCsvImportRequest", generated_types)
        self.assertIn("options?: ApiCsvImportOptions;", generated_types)
        self.assertIn("export interface ApiClassSessionDeleteScope", generated_types)
        self.assertIn("export interface ApiStudentListQueryContract", generated_types)
        self.assertIn('status?: "active" | "trialing" | "inactive" | "paused" | "canceled" | null;', generated_types)


if __name__ == "__main__":
    unittest.main()
