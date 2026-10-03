# Staff directory and Settings command ownership

Staff reads could replace acknowledged changes, ordinary token renewal could hide
successful writes, and Settings could run multiple commands while representing only
one pending row per command family. Together with the program correction in PR159,
this candidate resolves FSH2-01 and FT2-04. The real Settings command owner resolves
FC2-03. FSH2-02 remains pending for promotion/demotion completion.

The existing staff store now owns read sequence, mutation revision and pending
settlement. Its commands commit only within their captured resource and access
scope and are never replayed. Current roster errors retain existing rows and the
existing loaded-with-error behavior. Abandoned readers stop before issuing requests
under replacement credentials.

Live self and other-member legal-name updates share the existing endpoint and
partial roster merge. Only a matching self acknowledgement updates the current
user's legal names. Self setup remains available to a non-admin during subscription
recovery without requiring an existing roster or profile. Preview transformations
remain separate and retain their existing behavior.

Each actual workspace request captures the acknowledged self-name revision and
access epoch. An older response can preserve only the current legal first and last
names, only within the same returned active actor/studio/role identity. A new
transport after token renewal is authoritative. Role, studio, membership,
availability and other profile fields continue through the existing access rules.

A confirmed self role/archive change closes the old access state and starts
an authoritative workspace check. The mutation response does not grant a new role.
The normal SDK USER_UPDATED notification still resets access before updateUser
returns. Old SDK completion cannot restore the previous roster while revalidation
is pending or failed. Verified archived identity remains distinct from active
studio access and uses the existing archived-account route.

Settings now has one synchronous command owner across invitations, role/name
changes and lifecycle actions. Competing handlers refuse a second write even before
React renders disabled controls. Pending labels identify the actual target. An
editor keyed by access generation owns its drafts, messages and modal targets;
late responses cannot alter its replacement. Rejected commands retain their draft
or confirmation and show the relevant error. Only an owning success clears it.

Live operational clear and demo reset preserve staff state and valid pending staff
work. Preview demo reset still replaces its mock roster. Scheduled account deletion
returns a request and preserves the archived row; invitation revoke remains DELETE
for pending invitations. Unarchive retains its separate endpoint and behavior.

## Verification and test reduction

The new mounted file uses the real StoreProvider, staff controls, Input, Button and
ModalFrame, with only external I/O and icons replaced. Member IDs and user IDs are
distinct. Roster and workspace responses are frozen when the request starts.

The final baseline replay on unchanged main `ec48501` reports eight intended defect
failures and three passing preservation controls. It reproduces stale roster state,
lost renewal acknowledgements, reversed reads, concurrent Settings commands, stale
legal-name profiles, missing self-access revalidation, an old UI refresh absorbing
a new identity's load, and a roster transport starting during the SDK write.
All eleven groups pass on the candidate. A group's first failing assertion does not
mean every later phase independently failed on baseline.

The groups also check rejected-write settlement, normalized invitation/legal-name
payloads, legal-field-only merges, non-admin/no-Core setup, fresh profile authority,
late UI errors, SDK success and failed revalidation, exact deletion confirmation,
active-staff DELETE refusal, unarchive, live-clear preservation, last-admin controls
and profile capability rendering.

Seventeen tests in three source-text files were removed. They matched token checks,
variable names, strings and source layout. Eleven mounted groups now protect the
important behavior; existing staff models, authorization, initialization, legal-name
and generated-contract/type checks remain. This is not a claim of a separate
runtime assertion for every deleted source string.

Focused model/auth/program/initialization checks passed 85 tests. The full frontend
suite passed 922 tests and the example-environment production build passed. Final
staff groups passed again after adding the direct revoke/unarchive controls and
making the baseline failure assertion explicit. Focused lint passed. Required PR
checks and committed review binding remain prerequisites to merge.

Account display-name draft handling, promotion/history ownership, financial retry
policy and backend staff rules remain separate work. This candidate makes no
hosted configuration, schema or deployment change.
