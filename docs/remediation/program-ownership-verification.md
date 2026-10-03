# Program data ownership

Earlier program reads could overwrite a confirmed archive or a newer program list.
Ordinary token renewal could also hide a successful write. Program bootstrap, CSV
import refresh, and successful data resets used separate paths that could bypass
any correction limited to the program action hook.

This change keeps one program resource scope in the existing StoreProvider. It
orders reads, tracks pending writes and invalidates abandoned work after reset or
clear. All four live program commands share a commit rule that checks both the
captured resource scope and access identity. A successful write can settle after
token renewal; writes are never replayed. The program scope settles before the
existing create/edit belt refresh, so unrelated read latency does not block program
readers.

All program setters update the canonical reference synchronously with React state.
Acknowledgements for different programs in the same turn therefore retain both
changes. Bootstrap
program rows, loading flags and errors use the same owner. A failed older workspace
reload still closes the workspace access gate but cannot replace newer program
metadata flags. Successful clear and demo reset replace the scope; old reads and
write acknowledgements cannot repopulate it.

Equivalent current reads still share transport. Newer reads supersede older ones;
reads invalidated by a mutation wait for settlement and retry within the existing
bounded approach. Import uses an explicit fresh read after its confirmed receipt,
so it cannot reuse a request sent before the imported programs existed.

## Behavioral verification

Six mounted groups use the real StoreProvider and action hooks, the existing test
packer, production React, and frozen dispatch-time API snapshots:

- A stale read cannot reverse an acknowledged archive or certify usage while a
  write is pending. Rejected writes release waiting readers.
- Confirmed writes survive token renewal without replay, and simultaneous
  acknowledgements retain both changes. Belt refresh uses current credentials.
- Newest reads own rows and errors; equivalent current reads still deduplicate.
- Bootstrap success and failures cannot overwrite later program data or flags.
  An older workspace failure preserves the newer program result while still
  requiring identity recovery.
- A confirmed CSV import causes a program GET begun after its receipt.
- Clear and identity replacement reject old acknowledgements and stop abandoned
  mutation waiters before they issue a new transport.

All six groups fail at the intended assertions on unchanged main `342d545`, using
fixtures shaped like the generated ProgramResponse contract. All pass on the
candidate. Review separately exposed the outer workspace-error flag bypass; its
regression failed before the guard and passed after it. Cold fixture startup also
requires actual program rows and loaded metadata, not merely a ready identity.

Existing initialization, preview-model and CSV tests cover distinct behavior and
remain. No existing program concurrency coverage was found to duplicate these new
cases. The focused lifecycle/model/CSV suite passed 93 tests before the final
workspace-error correction; the corrected mounted groups also passed separately.
The final full frontend suite passed 928 tests. Focused lint and the production
build using example environment values passed. Required PR checks and committed
review binding remain prerequisites to merge.

## Scope and remaining work

This is partial progress on FSH2-01, FSH2-02 and FT2-04. Staff, current-user profile,
lead and promotion owners remain separate. This change does not define new billing
retry semantics, refresh every usage count after unrelated student/schedule work,
or change backend authorization, database state, program business rules or preview
transformations. Metadata loading and usage loading remain distinct.
