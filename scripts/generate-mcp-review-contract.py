#!/usr/bin/env python3
"""Export the actual read MCP tool schemas without starting services or reading credentials."""

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.mcp_read.catalog import CATALOG
from app.mcp_read.server import Runtime, build_server


async def contract():
    # These unused origins exist only to construct SDK schemas. No provider is
    # started, token validated or network request made by list_tools().
    class SchemaSettings:
        SUPABASE_URL = "https://schema.supabase.co"

        def validated_mcp_url(self):
            return "https://schema.koaryu.invalid/mcp"

        def validated_frontend_origin(self):
            return "https://schema.koaryu.invalid"

    settings = SchemaSettings()
    server, _ = build_server(settings, Runtime())
    tools = await server.list_tools()
    return {
        "tools": [
            tool.model_dump(mode="json", by_alias=True, exclude_none=True)
            for tool in tools
        ],
        "datasets": sorted(CATALOG),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    destination = ROOT / "integrations/chatgpt/tool-contract.json"
    expected = json.dumps(asyncio.run(contract()), indent=2, sort_keys=True) + "\n"
    if args.check:
        if not destination.exists() or destination.read_text() != expected:
            print(
                "MCP review contract differs. Run npm run generate:mcp-review-contract."
            )
            return 1
        print("MCP review contract matches the implemented tools and dataset catalog.")
        return 0
    destination.write_text(expected)
    print("Generated integrations/chatgpt/tool-contract.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
