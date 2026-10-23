"""Server-rendered owner review. Stored text is always escaped; no browser scripts."""

import json
from datetime import UTC, datetime
from html import escape

STYLE = """
:root { color-scheme:light; --paper:#f7f3e9; --ink:#3b2f1c; --line:#d9d0bf; }
* {box-sizing:border-box} body {margin:0;background:var(--paper);color:var(--ink);font:17px/1.5 system-ui,sans-serif}
main {max-width:860px;padding:32px 24px 80px;margin:auto} header {border-bottom:1px solid var(--line);padding-bottom:24px}
h1 {font-size:clamp(30px,6vw,48px);line-height:1.1;letter-spacing:-.04em} h2 {font-size:24px;line-height:1.2}
.banner {font-size:13px;text-transform:uppercase;letter-spacing:.09em;font-weight:700} .muted {font-size:14px}
article,section {border-top:1px solid var(--line);padding-top:24px;margin-top:28px;min-width:0} article {overflow-wrap:anywhere}
pre {font:14px/1.5 ui-monospace,monospace;background:#eee7d8;padding:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.compare {display:grid;grid-template-columns:1fr 1fr;gap:16px} .compare>div{min-width:0} .digest {font:12px/1.6 monospace;overflow-wrap:anywhere}
label {display:block;margin:16px 0} input {padding:10px;font:inherit;border:1px solid var(--line);border-radius:6px;background:white;max-width:100%}
input[type=email],input[type=password]{width:100%} button {min-height:44px;border:1px solid var(--ink);border-radius:6px;padding:10px 18px;font:inherit;background:var(--ink);color:var(--paper);cursor:pointer}
button.secondary {background:transparent;color:var(--ink)} form+form{margin-top:12px} a {color:inherit;text-underline-offset:3px} :focus-visible{outline:3px solid #9d712d;outline-offset:3px}
@media(max-width:560px){.compare{grid-template-columns:1fr}main{padding:24px 18px 60px}}
"""


def document(title, content):
    return f'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(title)} | Koaryu synthetic lab</title><style>{STYLE}</style><body><main><header><p class="banner">Koaryu · synthetic action lab</p><p>Local sample data only. This is separate from the read-only Koaryu connector.</p></header>{content}</main></body></html>'


def hidden(name, value):
    return f'<input type="hidden" name="{escape(name)}" value="{escape(value, quote=True)}">'


def login(proposal_id=""):
    return document(
        "Owner sign-in",
        f'<h1>Review as the owner</h1><p>Use the synthetic owner credentials in the demo’s private credential file. An assistant bearer key cannot sign in here.</p><form method="post" action="/owner/login">{hidden("proposal_id", proposal_id)}<label>Owner email<input name="username" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form>',
    )


def values(value):
    return escape(json.dumps(value, ensure_ascii=False, indent=2))


def owner_page(view):
    sections = [
        f"<h1>{escape(view['studio_name'])}</h1><p>Approve only changes you have reviewed. Approval alone changes no studio record: the assistant must execute that exact approved proposal.</p>"
    ]
    for proposal in view["proposals"]:
        proposal_id = proposal["proposal_id"]
        expires = datetime.fromtimestamp(proposal["expires_at"], UTC).isoformat()
        fields = hidden("csrf", view["csrf"]) + hidden("digest", proposal["digest"])
        sections.append(
            f'<article data-proposal="{escape(proposal_id)}"><p class="banner">{escape(proposal["status"])}</p><h2>{escape(proposal["action"])} · {escape(proposal["target_name"])}</h2><p class="muted">Target: {escape(proposal["target_id"])} · Version {proposal["target_version"]}</p><div class="compare"><div><h3>Before</h3><pre>{values(proposal["before"])}</pre></div><div><h3>After</h3><pre>{values(proposal["after"])}</pre></div></div><p class="muted">Expires {escape(expires)}</p><p class="digest">Review digest: {escape(proposal["digest"])}</p>'
        )
        if not proposal["change_required"]:
            sections.append(
                "<p>The requested value is already present. Execution will record a no-change receipt.</p>"
            )
        if proposal.get("notice"):
            sections.append(f'<p role="alert">{escape(proposal["notice"])}</p>')
        if proposal["status"] == "pending" and proposal["reviewable"]:
            sections.append(
                f'<form method="post" action="/owner/proposals/{escape(proposal_id)}/decision">{fields}{hidden("decision", "approve")}<label><input type="checkbox" name="confirm" value="reviewed" required> I reviewed this exact target and change.</label><button type="submit">Approve this change</button></form><form method="post" action="/owner/proposals/{escape(proposal_id)}/decision">{fields}{hidden("decision", "deny")}<button type="submit" class="secondary">Deny</button></form>'
            )
        elif proposal["status"] == "pending":
            sections.append(
                f'<form method="post" action="/owner/proposals/{escape(proposal_id)}/decision">{fields}{hidden("decision", "deny")}<button type="submit" class="secondary">Deny</button></form>'
            )
        elif proposal["status"] == "approved" and proposal["reviewable"]:
            sections.append(
                "<p>Approved. Return to the assistant to execute this exact proposal before it expires.</p>"
            )
        sections.append("</article>")
    if not view["proposals"]:
        sections.append(
            "<p>No proposals yet. Ask the synthetic assistant to preview a change.</p>"
        )
    sections.append("<section><h2>Assistant access</h2>")
    for connection in view["connections"]:
        sections.append(f'<p class="digest">{escape(connection["id"])}</p>')
        if connection["revoked"]:
            sections.append("<p>Revoked. Future assistant calls are refused.</p>")
        else:
            sections.append(
                f'<form method="post" action="/owner/connections/{escape(connection["id"])}/revoke">{hidden("csrf", view["csrf"])}<button type="submit" class="secondary">Revoke assistant access</button></form>'
            )
    sections.append("</section><section><h2>Execution receipts</h2>")
    for receipt in view["receipts"]:
        sections.append(
            f"<p>{escape(receipt['outcome'])} · {escape(receipt['action'])}</p><pre>{values(receipt)}</pre>"
        )
    if not view["receipts"]:
        sections.append("<p>No action has executed.</p>")
    sections.append('</section><p><a href="/owner">All proposals</a></p>')
    return document("Owner review", "".join(sections))


def error_page(message):
    return document(
        "Action unavailable",
        f'<h1>Action unavailable</h1><p role="alert">{escape(message)}</p><p><a href="/owner">Return to owner review</a></p>',
    )
