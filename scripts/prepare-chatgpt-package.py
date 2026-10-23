#!/usr/bin/env python3
"""Check Koaryu's package source, or build after actual public activation and listing setup."""

import argparse
import hashlib
import io
import ipaddress
import json
import re
import socket
import struct
import zipfile
from copy import deepcopy
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "integrations/chatgpt"
TOOLS = {"get_context", "describe_data", "query_data", "get_record"}
URL_FIELDS = {"websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"}
FACT_FIELDS = {
    "developer_name",
    "countries",
    "commerce",
    "commerce_description",
    "demo_recording_url",
    "urls",
    "mcp_url",
}
MAX_RESPONSE = 2_000_000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text(value, field, maximum):
    require(
        isinstance(value, str) and value.strip() and len(value) <= maximum,
        f"Invalid {field}.",
    )
    require(not any(ord(c) < 32 for c in value), f"Control characters in {field}.")
    return value


def https_url(value):
    text(value, "public URL", 1024)
    parsed = urlsplit(value)
    require(
        parsed.scheme == "https"
        and parsed.hostname
        and not parsed.username
        and not parsed.password
        and not parsed.fragment
        and parsed.port in {None, 443},
        "Public URLs must use HTTPS without credentials, fragments or nonstandard ports.",
    )
    host = parsed.hostname.lower()
    require(
        "." in host
        and host != "localhost"
        and not host.endswith((".localhost", ".local", ".invalid", ".test", ".example"))
        and host not in {"example.com", "example.org", "example.net"}
        and "placeholder" not in host,
        "Supply an actual public URL, not a local, reserved or placeholder address.",
    )
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        require(
            address.is_global, "Public URLs cannot use private or loopback addresses."
        )
    return value


def png_asset(source, relative, minimum):
    require(
        isinstance(relative, str) and relative.startswith("./assets/"),
        "Icon must be in ./assets/.",
    )
    path = source / relative[2:]
    require(
        not path.is_symlink() and path.resolve().is_relative_to(source.resolve()),
        "Icon path must be contained and not a symlink.",
    )
    data = path.read_bytes()
    require(
        len(data) <= 5 * 1024 * 1024
        and data[:16] == b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR",
        "Icon must be a PNG up to 5 MiB.",
    )
    width, height = struct.unpack(">II", data[16:24])
    require(
        minimum <= width == height <= 4096,
        f"Icon must be square and at least {minimum}px.",
    )
    return data


def check_source(source=SOURCE):
    require(not (source / "plugin.json").is_symlink(), "Manifest cannot be a symlink.")
    manifest = json.loads((source / "plugin.json").read_text())
    require(
        set(manifest) == {"$schema", "name", "version", "description", "extensions"},
        "Unexpected portable manifest fields.",
    )
    require(
        manifest["$schema"]
        == "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        "Wrong plugin schema.",
    )
    require(
        manifest["name"] == "koaryu"
        and re.fullmatch(
            r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", manifest["version"]
        ),
        "Invalid package identity or version.",
    )
    extension = manifest["extensions"]["com.openai"]
    require(
        set(extension) == {"interface", "review", "publication"},
        "Unexpected OpenAI extension fields.",
    )
    interface = extension["interface"]
    for field, maximum in [
        ("displayName", 30),
        ("shortDescription", 30),
        ("longDescription", 4000),
    ]:
        text(interface[field], field, maximum)
    require(interface["category"] == "Business & Operations", "Unexpected category.")
    prompts = interface["defaultPrompt"]
    require(
        isinstance(prompts, list) and 1 <= len(prompts) <= 3,
        "Supply one to three starter prompts.",
    )
    for prompt in prompts:
        text(prompt, "starter prompt", 128)
    require(
        len({" ".join(p.split()) for p in prompts}) == len(prompts),
        "Duplicate starter prompts.",
    )
    assets = {}
    for field, minimum in [("logo", 256), ("composerIcon", 48)]:
        relative = interface[field]
        assets[relative[2:]] = png_asset(source, relative, minimum)
    cases = extension["review"]["test_cases"]
    require(
        len(cases["positive"]) == 5 and len(cases["negative"]) == 3,
        "Review needs five positive and three negative cases.",
    )
    for case in cases["positive"] + cases["negative"]:
        text(case["description"], "case description", 4000)
        text(case["prompt"], "case prompt", 4000)
        require(
            set(case)
            <= {"description", "prompt", "tools_triggered", "expected_behavior"},
            "Unexpected review-case field.",
        )
    for case in cases["positive"]:
        text(case["tools_triggered"], "expected tools", 4000)
        text(case["expected_behavior"], "expected result", 4000)
        require(
            set(case["tools_triggered"].split(", ")) <= TOOLS,
            "Case refers to an unimplemented tool.",
        )
    contract = json.loads((source / "tool-contract.json").read_text())
    require(
        {tool["name"] for tool in contract["tools"]} == TOOLS,
        "Review contract must expose the four implemented read tools.",
    )
    for tool in contract["tools"]:
        require(
            all(
                tool["annotations"].get(key) is value
                for key, value in {
                    "readOnlyHint": True,
                    "destructiveHint": False,
                    "openWorldHint": False,
                }.items()
            ),
            "Review contract must retain explicit read-only annotations.",
        )
    return manifest, assets


def complete_manifest(manifest, facts):
    require(
        isinstance(facts, dict) and set(facts) == FACT_FIELDS,
        "Supply all listing facts; unknown settings are refused. See integrations/chatgpt/README.md.",
    )
    result = deepcopy(manifest)
    extension = result["extensions"]["com.openai"]
    extension["interface"]["developerName"] = text(
        facts["developer_name"], "verified publisher name", 80
    )
    urls = facts["urls"]
    require(
        isinstance(urls, dict) and set(urls) == URL_FIELDS,
        "Supply all four actual listing URLs.",
    )
    for field, value in urls.items():
        extension["interface"][field] = https_url(value)
    countries = facts["countries"]
    require(
        isinstance(countries, list)
        and all(
            isinstance(code, str) and re.fullmatch(r"[A-Z]{2}", code)
            for code in countries
        ),
        "Choose uppercase country codes, or explicitly [] for all available countries.",
    )
    require(len(set(countries)) == len(countries), "Duplicate country targeting.")
    extension["publication"]["countries"] = countries
    require(type(facts["commerce"]) is bool, "Commerce must be an explicit boolean.")
    extension["review"]["commerce"] = facts["commerce"]
    extension["review"]["commerce_description"] = text(
        facts["commerce_description"], "commerce description", 4000
    )
    extension["review"]["demo_recording_url"] = https_url(facts["demo_recording_url"])
    endpoint = https_url(facts["mcp_url"])
    parsed = urlsplit(endpoint)
    require(
        parsed.path == "/mcp" and not parsed.query,
        "Use the exact deployed canonical /mcp endpoint.",
    )
    mcp = {
        "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        "mcpServers": {
            "koaryu": {
                "type": "streamable-http",
                "url": endpoint,
                "extensions": {
                    "com.openai": {
                        "auth": {
                            "type": "oauth",
                            "client": {"mode": "dcr"},
                            "baseScopes": ["offline_access"],
                            "defaultScopes": ["offline_access"],
                            "oidcEnabled": False,
                        }
                    }
                },
            }
        },
    }
    return result, mcp


def public_host(value):
    https_url(value)
    addresses = socket.getaddrinfo(
        urlsplit(value).hostname, 443, type=socket.SOCK_STREAM
    )
    require(
        addresses
        and all(ipaddress.ip_address(row[4][0]).is_global for row in addresses),
        "URL resolves to a private address.",
    )


class PublicRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        public_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(value, *, method="GET", data=None, headers=None):
    public_host(value)
    opener = build_opener(ProxyHandler({}), PublicRedirects())
    request = Request(
        value,
        data=data,
        method=method,
        headers={"User-Agent": "Koaryu-Package-Check/0.1", **(headers or {})},
    )
    try:
        response = opener.open(request, timeout=8)
    except HTTPError as error:
        response = error
    with response:
        body = response.read(MAX_RESPONSE + 1)
        require(len(body) <= MAX_RESPONSE, "Verification response exceeded 2 MB.")
        return response.status, response.headers, body


def verify_public(manifest, mcp):
    extension = manifest["extensions"]["com.openai"]
    for field in sorted(URL_FIELDS):
        status, headers, body = fetch(extension["interface"][field])
        require(
            status == 200 and "text/html" in headers.get("Content-Type", ""),
            f"{field} must be an accessible public HTML page.",
        )
        content = body.decode("utf-8", errors="replace").lower()
        require("koaryu" in content, f"{field} does not identify Koaryu.")
        if field == "supportURL":
            require(
                "mailto:koaryu@outlook.com" in content
                and re.search(r"<h1\b[^>]*>\s*get help with koaryu\.\s*</h1>", content),
                "Support page must identify Koaryu support and show the actual support inbox.",
            )
        if field == "privacyPolicyURL":
            require(
                re.search(
                    r"<h[1-6]\b[^>]*>\s*ai assistants you connect\s*</h[1-6]>", content
                ),
                "Published privacy page does not cover the connector yet.",
            )
    # A 200 video URL alone does not prove playback, permissions or coverage.
    # Inspect those manually in the intended host before supplying this setting.
    status, _, _ = fetch(extension["review"]["demo_recording_url"], method="HEAD")
    require(
        200 <= status < 300,
        "Demo recording is not publicly accessible; inspect playback before building.",
    )
    endpoint = mcp["mcpServers"]["koaryu"]["url"]
    status, headers, _ = fetch(
        endpoint,
        method="POST",
        data=b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    require(status == 401, "Public MCP must require OAuth before serving tools.")
    match = re.search(
        r'resource_metadata="([^"\s]+)"', headers.get("WWW-Authenticate", "")
    )
    require(match, "MCP 401 did not advertise protected-resource discovery.")
    status, _, body = fetch(match.group(1))
    require(status == 200, "Protected-resource discovery failed.")
    resource = json.loads(body)
    require(
        isinstance(resource, dict),
        "Protected-resource discovery must be a JSON object.",
    )
    require(
        resource.get("resource") == endpoint,
        "Discovery resource does not match the exact MCP audience.",
    )
    issuers = resource.get("authorization_servers", [])
    require(
        isinstance(issuers, list) and len(issuers) == 1,
        "Expected one native authorization server.",
    )
    issuer = https_url(issuers[0]).rstrip("/")
    parsed = urlsplit(issuer)
    candidates = [
        f"https://{parsed.netloc}/.well-known/oauth-authorization-server{parsed.path}",
        issuer + "/.well-known/oauth-authorization-server",
    ]
    authorization = None
    for candidate in dict.fromkeys(candidates):
        status, _, body = fetch(candidate)
        if status == 200:
            authorization = json.loads(body)
            break
    require(
        isinstance(authorization, dict)
        and isinstance(authorization.get("issuer"), str)
        and authorization["issuer"].rstrip("/") == issuer,
        "Native OAuth issuer discovery failed.",
    )
    scopes = authorization.get("scopes_supported")
    require(
        isinstance(scopes, list)
        and all(isinstance(scope, str) for scope in scopes)
        and "offline_access" in scopes,
        "Native server must support offline_access.",
    )
    challenges = authorization.get("code_challenge_methods_supported")
    require(
        isinstance(challenges, list)
        and all(isinstance(challenge, str) for challenge in challenges)
        and "S256" in challenges,
        "Native OAuth must support PKCE S256.",
    )
    for field in ["authorization_endpoint", "token_endpoint", "registration_endpoint"]:
        https_url(authorization.get(field))
    return "Public HTTP/discovery checks passed; actual ChatGPT OAuth, scans, cases and recording playback still need verification."


def archive_bytes(manifest, mcp, assets):
    files = {
        "plugin.json": (
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
        ).encode(),
        "mcp.json": (json.dumps(mcp, indent=2) + "\n").encode(),
        **assets,
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo("koaryu/" + name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    result = output.getvalue()
    with zipfile.ZipFile(io.BytesIO(result)) as archive:
        require(
            archive.testzip() is None
            and set(archive.namelist()) == {"koaryu/" + name for name in files},
            "Final archive inventory failed.",
        )
        require(
            json.loads(archive.read("koaryu/plugin.json")) == manifest,
            "Archived manifest differs.",
        )
        require(
            json.loads(archive.read("koaryu/mcp.json")) == mcp,
            "Archived MCP configuration differs.",
        )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check-source",
        action="store_true",
        help="Offline source check; does not claim public readiness or create a ZIP.",
    )
    parser.add_argument(
        "--settings",
        type=Path,
        help="Confirmed publisher/listing/endpoint facts outside Git; no credentials.",
    )
    parser.add_argument(
        "--output", type=Path, help="New ZIP path outside the package source."
    )
    args = parser.parse_args()
    try:
        manifest, assets = check_source()
        if args.check_source:
            require(
                not args.settings and not args.output,
                "Source checking cannot also build a package.",
            )
            print(
                "Package source passed. Public build remains blocked until actual endpoint, listing URLs, publisher facts and recording are supplied and verified."
            )
            return 0
        require(
            args.settings and args.output,
            "Public packaging is not available yet. Supply --settings and --output only after activation and actual listing verification.",
        )
        require(
            not args.output.exists()
            and not args.output.resolve().is_relative_to(SOURCE.resolve()),
            "Use a new archive path outside integrations/chatgpt.",
        )
        manifest, mcp = complete_manifest(
            manifest, json.loads(args.settings.read_text())
        )
        verification = verify_public(manifest, mcp)
        archive = archive_bytes(manifest, mcp, assets)
        with args.output.open("xb") as destination:
            destination.write(archive)
        print(f"Prepared {args.output}; SHA256 {hashlib.sha256(archive).hexdigest()}")
        print(verification)
        print(
            "Not submitted or published. This is not a guarantee of directory approval or recommendations."
        )
        return 0
    except (ValueError, KeyError, TypeError, OSError, URLError) as error:
        print(f"Package preparation stopped: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
