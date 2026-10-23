"""Enabling MCP must not turn on logging of private provider query URLs."""

import os
import subprocess
import sys
from pathlib import Path


def test_mcp_startup_does_not_enable_provider_query_url_logging(tmp_path):
    script = """
import io
import logging
import httpx
from app.core.config import Settings
from app.mcp_read.server import Runtime, build_server

root = logging.getLogger()
root.handlers.clear()
root.setLevel(logging.WARNING)
settings = Settings(
    _env_file=None,
    ENVIRONMENT="test",
    SUPABASE_URL="https://placeholder.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY="placeholder-key",
    FRONTEND_URL="https://studio.example.invalid",
    MCP_PUBLIC_URL="https://mcp.example.invalid/mcp",
)
build_server(settings, Runtime())
output = io.StringIO()
root.addHandler(logging.StreamHandler(output))
transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"ok": True}))
with httpx.Client(transport=transport, trust_env=False) as client:
    client.get("https://data.example.invalid/students?email=eq.synthetic-private-filter")
assert "synthetic-private-filter" not in output.getvalue(), "MCP enabled provider URL logging"
assert root.level == logging.WARNING
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=tmp_path,
        env={
            "PATH": os.environ["PATH"],
            "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
            "ENVIRONMENT": "test",
            "SUPABASE_URL": "https://placeholder.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "placeholder-key",
        },
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr
