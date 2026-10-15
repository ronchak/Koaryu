#!/usr/bin/env python3
"""Read-only timezone parity on an owned disposable target runtime.

Hosted release inspection uses the same SQL and validator through the guarded
rollout. This standalone helper accepts only the local verifier's Unix socket.
"""

import json
import sys
from pathlib import Path

from local_postgres_verification import LocalPostgres, require


def main(args):
    require(len(args) == 4, "Expected psql disposable-socket port database")
    psql, socket, port, database = args
    local = LocalPostgres(psql, socket, port, str(Path(socket).parent))
    module = (
        (Path(__file__).parent / "release-attestation/timezone-names.mjs")
        .resolve()
        .as_uri()
    )
    query = local.run(
        [
            "node",
            "--input-type=module",
            "--eval",
            f"import {{ TIMEZONE_NAMES_PARITY_SQL }} from {json.dumps(module)}; process.stdout.write(TIMEZONE_NAMES_PARITY_SQL);",
        ]
    )
    state = local.sql(database, "BEGIN READ ONLY;\n" + query + ";\nCOMMIT;")
    local.run(
        [
            "node",
            "--input-type=module",
            "--eval",
            f"import {{ validateTimezoneNameParity }} from {json.dumps(module)}; validateTimezoneNameParity(process.argv[1]);",
            state,
        ]
    )
    print("PASS timezone names parity: " + state)


if __name__ == "__main__":
    main(sys.argv[1:])
