# Koaryu ChatGPT package source

This directory contains listing source, real Koaryu icons and the exported read-tool contract. It is **not an installable plugin or a submission-ready ZIP**. There is no verified deployed public MCP endpoint yet, so `mcp.json` is deliberately absent. The builder only creates it from an actual activated endpoint after public HTTP/discovery checks.

The four operations are `get_context`, `describe_data`, `query_data` and `get_record`. Flexible filters, related fields, groups and totals remain available within the owner's permissions. No business-write tools, embedded model service or additional Koaryu runtime dependency are introduced here.

## Check the source

From the repository root, with the existing backend development environment installed:

```sh
npm run generate:mcp-review-contract
npm run check:mcp-package-source
python3 -m unittest discover -s scripts -p test_prepare_chatgpt_package.py -v
```

`tool-contract.json` comes from the actual MCP SDK tool definitions and catalog. Generation starts no server or provider and reads no credentials. The check detects schema/annotation drift; it does not prove that a public host or ChatGPT can connect.

The source check verifies the draft listing, three starter prompts, five positive/three negative cases, exact read tools and contained square PNGs. The icons are copies of Koaryu's existing 512px and 192px brand assets. They have been inspected on light and dark backgrounds.

## Finish the facts before packaging

The owner has not yet supplied a verified publisher identity, country targeting or the connector's commerce/pricing declaration. Keep these values absent from the source. A business name in the app is not proof of the selected verified publisher.

Create a JSON settings file outside Git with exactly these keys once each fact is confirmed:

| Key | Required value |
| --- | --- |
| `developer_name` | The selected verified individual or business name, at most 80 characters |
| `countries` | Explicit uppercase country-code list; use `[]` only for an explicit choice of all available countries. Confirm codes and platform availability in the portal. |
| `commerce` | Explicit boolean declaration about this connector's commerce behavior |
| `commerce_description` | What users buy, if anything, and where payment takes place. Do not infer this from Koaryu's existing subscription. |
| `demo_recording_url` | Actual reviewer-accessible recording of the packaged version operating in ChatGPT, with readable real prompts and results |
| `urls` | Object containing all four actual published URLs: `websiteURL`, `supportURL`, `privacyPolicyURL`, `termsOfServiceURL` |
| `mcp_url` | The exact activated canonical public HTTPS `/mcp` endpoint |

No secrets belong in this settings file. Reviewer account credentials go only into secure portal fields. Never put client secrets, API keys, passwords, access/refresh tokens, dumps or customer records into the package.

The website should identify the assistant connection and Koaryu. The support page must work without a login and show the actual support inbox. The privacy policy must cover the connector's actual data practices. Inspect all four pages and the real recording in a browser; a successful HTTP response alone does not establish content or video playback.

This branch prepares `/ai-connections` and `/support` source. They are not live until a separately authorized frontend deployment. The updated connector privacy text also needs deployment. Do not enter these paths as verified URLs while they return 404 or lack the relevant content.

## Build only after activation

Complete the activation checks in [MCP setup](../../docs/mcp-read-access.md), including ordinary sign-in, native account refusal, scope behavior, refresh/reconnect and hosted ACL matching. Public DCR remains disabled until that proof is complete. The standard OAuth flow is reused; no new token authority is added.

Then run:

```sh
npm run build:mcp-package -- --settings /absolute/private/listing-settings.json --output /absolute/private/koaryu-0.1.0.zip
```

The builder refuses missing facts, guessed/local/reserved endpoints, private DNS, a resource/audience mismatch, missing OAuth discovery/PKCE/DCR metadata, an unpublished connector privacy policy and inaccessible listing pages. It makes no credentialed request, registers no client and changes no hosted setting. It checks recording URL reachability; manually verify actual playback and coverage first. Country syntax is checked locally; the portal validates recognized codes and supported availability.

The generated `mcp.json` uses Streamable HTTP, DCR, `offline_access` as base/default scope and `oidcEnabled: false`. Do not add OpenID, identity scopes or user-info retrieval. Koaryu intentionally refuses those scopes to keep the assistant's principal separate from the owner's account.

The ZIP contains only `koaryu/plugin.json`, `koaryu/mcp.json` and the two referenced PNGs. Archive entries are deterministic. The builder reopens the actual ZIP bytes, checks the inventory, JSON and CRCs, and refuses to overwrite an existing output. It does not upload, create a private plugin, submit, publish or attest anything.

## Public tool review

OpenAI's [tool guidelines](https://developers.openai.com/plugins/plugin-guidelines) require individually reviewable operations. Here, `query_data` is one structured read operation over a fixed Koaryu catalog. It has no arbitrary SQL, command name, executable code, dynamic extension loading or business mutation. `describe_data` describes that read catalog; it cannot create a new operation. The full schema is in `tool-contract.json` and catalog meanings are in the server source.

This is our implementation rationale, not a guarantee that the directory will accept the design. The actual host scan and public review must decide. If a scan flags the generic read interface, preserve the owner's flexible questions and address the concrete finding; do not quietly narrow the product to a few fixed workflows or claim acceptance based on local tests.

`readOnlyHint=true`, `destructiveHint=false` and `openWorldHint=false` describe the bounded private-studio reads. Latest-access operational metadata is recorded without retaining query contents or returned records. The package does not register a separate app identity or bundle a hidden app binding.

## Remaining review setup

See [review materials](review-materials.md) for fixture setup, the walkthrough and current case status. Preparing source is distinct from public package readiness, a portal draft, submission for review and publication. Actual ChatGPT connection, reviewer access, recording playback, scans, publisher/domain verification and authorized legal attestations remain required. Public listing does not guarantee proactive recommendations.

References: [package format](https://developers.openai.com/plugins/build/plugins), [authentication](https://developers.openai.com/plugins/build/auth), [submission](https://developers.openai.com/plugins/deploy/submission).
