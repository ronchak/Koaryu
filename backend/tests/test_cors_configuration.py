from fastapi.testclient import TestClient

from app.main import app


def _preflight(origin: str):
    return TestClient(app).options(
        "/",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
        },
    )


def test_cors_allows_only_canonical_configured_local_origins():
    for origin in ("http://localhost:4000", "http://127.0.0.1:4000"):
        response = _preflight(origin)
        assert response.headers["access-control-allow-origin"] == origin

    for origin in (
        "http://localhost:4000/",
        "http://localhost:4000/path",
        "http://localhost:4000@evil.example",
    ):
        response = _preflight(origin)
        assert "access-control-allow-origin" not in response.headers
