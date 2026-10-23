# Koaryu assistant integration roadmap

The current flexible read MCP is a foundation. The immediate next proof is a complete native OAuth connection using a realistic synthetic studio. The following three milestones turn that proof into a useful product, a distribution path and a safe action interface.

## 1. Owners can use flexible reads independently

An owner connects their preferred assistant, chooses permissions, asks their own questions and manages access without operator support.

Build on the existing consent, settings and help pages. Complete the real OAuth proof, improve recovery for expired/revoked connections and unsupported client settings, protect authentication from slow queries, and exercise simultaneous studios with realistic data. Keep the broad read catalog and flexible query contract. Example prompts should teach possibilities without becoming a fixed workflow menu.

Answers must make their date window, currency, record grain and completeness clear. Keep ordinary Koaryu sign-in working. Connection revocation and reconnect must retain their tested session boundaries.

The implementation exit is a reviewed read-product candidate with realistic browser/client proof, bounded provider capacity and a working operator activation checklist. The subsequent pilot target is that owners connect without technical help and choose to use it repeatedly. Actual customer usage cannot be established by synthetic tests.

## 2. Koaryu has a public ChatGPT integration ready to submit

A studio owner can discover Koaryu, understand what it does, install it, log in and get useful results. Preserve the existing MCP backend and authentication instead of adding a separate integration service or an embedded model subscription.

Prepare the branded plugin package, explicit MCP configuration, accurate capability descriptions, example prompts, appropriate assets, privacy/support links and review materials. Provide reproducible validation and packaging commands. Keep credentials outside the package. Prepare synthetic reviewer-account instructions and positive/negative test cases.

Validate the public tool contract against current platform guidelines early. Expose all public operations for review and preserve broad data access within the owner's permissions. A private MCP connection working does not prove public directory acceptance. Add an interactive result view only when it materially improves reading the result.

The implementation exit is a validated package and complete submission materials with tested target configuration and clearly identified external prerequisites. Public submission and publication are separate owner decisions. Directory acceptance and proactive recommendation are external outcomes, not promised delivery metrics.

## 3. Predefined guarded actions are ready for an opt-in alpha

An assistant can propose a specific change, show the owner exactly what it would do, and execute the approved change safely.

Start with a small number of low-impact actions backed by existing business commands, such as adding a student tag and changing a lead follow-up date. Validate the choice against the actual services before implementation. Preserve read-only v1; develop the action interface in an isolated prototype or separate branch.

Every action needs an exact target and input schema, a before/after preview, current studio and actor authorization, enforceable human confirmation, expiry, stale-state detection, retry safety and an audit receipt. Approval must bind the actor, studio, action and inputs; it cannot be inferred from model text. Test forged, reused, expired and wrong-tenant approvals, concurrent changes and retries.

The alpha does not include arbitrary SQL writes, customer sends, payments/refunds or bulk deletion. Those need their own product and authority decisions.

The implementation exit is a reviewed contract and meaningful synthetic execution proof for the selected actions, with a separate activation decision. Broader actions can then grow through explicit tool contracts.

## Autonomous delivery window

The owner authorized a full day of autonomous work ending October24,2026 at01:45Pacific. The intended allocation is:

| Work | Planning range | Reviewable result |
| --- | --- | --- |
| Native OAuth proof | Hours0–6 | Real disposable Auth exchange and lifecycle proof, or an executable smoke test with honest external prerequisites |
| Read product | Hours6–12 | Owner UX, competing-studio reliability, focused tests and draft PR |
| Public integration | Hours12–18 | Validated package, public-tool review checks and submission materials |
| Guarded-action foundation | Hours18–24 | Isolated prototype/specification, focused review and integrated handoff |

These ranges guide priority rather than guarantee completion times. Native authentication and the read product come first. Continue independent tasks when an external dependency is unavailable.

Local development, disposable verification and draft PRs are in scope. Hosted configuration/deployment, public publication, customer sending and payment activation require their applicable owner authorization. Keep private operator evidence, credentials and dumps outside Git.

## Platform references

- [OpenAI plugin submission](https://developers.openai.com/plugins/deploy/submission)
- [OpenAI plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines)
- [Supabase OAuth server](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
- [Koaryu MCP setup and verification](mcp-read-access.md)
