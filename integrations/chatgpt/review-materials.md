# Koaryu read-connector review materials

## Status

Listing text, real icons, the four tool schemas and five positive/three negative cases are drafted in `plugin.json`. The public endpoint is not activated. Publisher identity, country targeting and commerce facts await the owner. No public ZIP, host walkthrough recording, reviewer account or portal draft has been created.

| Verification | State | Evidence or dependency |
| --- | --- | --- |
| Native OAuth/permissions lifecycle | Passed locally | Real disposable native Auth + PostgREST + all156 migrations + backend + official SDK;73 cases including two larger studios and blocked-read isolation |
| Styled owner connection flow | Passed locally | Real native password login, mobile consent/PKCE, permission edit, disconnect; eight checks |
| Source schemas and archive safety | Local checks | `npm run check:mcp-package-source` and `scripts/test_prepare_chatgpt_package.py` |
| Five listing query shapes and programmatic boundaries | Passed locally | Separate real native fixture: filtered roster/record, monthly attendance, overdue leads, projected schedule and per-currency invoices; unchanged business hashes. Not a language-model test. |
| Five positive language prompts | Not run in ChatGPT | Requires intended host development connection and complete synthetic fixture |
| Three unsupported-action prompts | Not run in ChatGPT | Same intended host requirement; transport refusals alone do not prove model behavior |
| Hosted ordinary sign-in and isolation | Blocked on activation | Named owner-authorized hosted setup and exact Auth/ACL verification |
| Recording and reviewer-accessible URL | Not created | Requires actual ChatGPT development connection, sample data and permitted hosting |
| Publisher/domain, scans and attestations | Not completed | Owner's intended organization and final portal workflow |

Local OAuth/browser/direct-query proof does not substitute for a ChatGPT walkthrough or the eight natural-language cases. Never mark those prompts passed merely because direct tool calls pass. Record the packaged version, tool arguments, user-visible answer and evidence when running each case.

## Dedicated fixture

Use a dedicated synthetic studio on the eventual approved reviewer environment. Do not use a real customer account, production records or someone else's studio. Keep the exact account, password, studio identifier and expected-row reference outside Git; supply login instructions and credentials only through the portal's secure reviewer-access fields. Reviewers must not need the owner's mailbox, social account, phone or private network.

Seed the following, checking the actual catalog field types and studio boundaries:

- Programs and students: an active competition-tagged student, an active untagged student, an inactive tagged student, and a deleted student. Use distinguishable synthetic names and program memberships.
- Attendance: recorded rows across two completed calendar months, multiple students per session and a known status mix. Preserve an exact per-month recorded-row reference. A missing row is not proof a student was absent.
- Leads: past/future/null `follow_up_date`, including a past-due converted lead that must be excluded through `converted_student_id`.
- Schedule: a stored class, an unmaterialized recurring occurrence, a canceled occurrence and a stored override in a fixed fourteen-day window. Capture the studio timezone and reference date. Projected identifiers are not UUIDs.
- Invoices: multiple open invoices in each of two currencies and a paid invoice that must not enter the open total. Capture exact integer-cent totals by currency.
- A second unrelated synthetic studio with distinctive names/amounts for isolation checks. It must never appear in this connection's results.

Grant only students/schedule/leads/billing for the positive fixture. Contact, personal and notes permissions stay off. Verify the reviewer can log in, access the active studio and complete OAuth before supplying credentials. Check ordinary sessions and connector account-endpoint refusal using the activation guide.

The current loopback demo is a useful quick start, but its one-currency/one-month sample does not contain every public-review boundary above. The native Auth harness proves auth lifecycle; it is not this complete language-review fixture.

## Walkthrough to rehearse and record

1. Use the actual packaged version in a ChatGPT development connection. Show the Koaryu name and four tools without exposing keys or tokens. A local terminal/client simulation is not the intended-host demonstration.
2. Connect the dedicated studio. Show the Koaryu consent screen, selected data categories, unchecked sensitive categories and expiration. Keep password entry out of the recording.
3. Ask “Which studio am I connected to, and what information can you read?” Show the real context result. Confirm only the test studio is identified.
4. Ask the tagged-student prompt from the package. Show actual query arguments, filtered names/programs, then the returned student's record. Contact details must remain unavailable.
5. Ask the monthly attendance prompt. Show the explicit studio-local dates, row grain and two supported totals. Ask a follow-up about the records used.
6. Ask the recorded open-balance prompt. Show each currency separately and the stored-state qualification. Do not imply a live Stripe refresh.
7. Ask the unsupported tagging or email prompt. Show the assistant explaining the read-only boundary without a fabricated success or write call.
8. Open Koaryu settings, edit a sensitive permission only if that is part of the intended demonstration, then disconnect. Ask again in ChatGPT and show access refusal/reconnection guidance.

Rehearse before recording. Use the host's visible UI and available screen recorder. Keep the recording short enough to review while leaving prompts/results readable. Replay the saved video and check actual playback, results, scope coverage and absence of secrets or unrelated private content. Host it at the owner's chosen reviewer-accessible destination within separately authorized scope, inspect the public link and then supply `demo_recording_url` to the builder. A script, screenshot, native OAuth proof or local video without an accessible URL does not complete that field.

## After the package is complete

Use the intended publisher organization. Uploading a draft, connecting/scanning its exact saved MCP version, supplying reviewer access, submitting for review and publishing are separate actions. This autonomous branch work authorizes none of them. The owner must complete legal/policy attestations. Follow the current platform submission flow and inspect imported metadata; keep all five positive and three negative cases tied to the one MCP server.
