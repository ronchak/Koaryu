import unittest

from fastapi.testclient import TestClient

from app.main import app


class HealthEndpointTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_health_endpoints_accept_get_and_head(self):
        for path in ("/health", "/api/v1/health"):
            with self.subTest(method="GET", path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["status"], "ok")

            with self.subTest(method="HEAD", path=path):
                response = self.client.head(path)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.text, "")


if __name__ == "__main__":
    unittest.main()
