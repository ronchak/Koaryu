"""Finite V57 typed-destination exception; all other source and metadata stay exact."""

import hashlib
import re

BASE = "35561d6b8f851ea0309723637e0996a064ba4c82"
BASE_HASH = "cab98ab987acf0c24a383be94f3e0499c6d891b922d7fd1de217e788c2a339b5"
TIMED_FUNCTION = "private.workflow_timed_candidates_v1"
TIMED_SIGNATURE = TIMED_FUNCTION + "(integer,timestamp with time zone)"
TIMED_BODY_HASHES = (
    "38ac23048c419ef2a64455aca124d0b8a5c46a122aaf6653e9170e5530685ca1",
    "07e98ac269cc740feac349b98223d486bec3ad4670e4c6f81521173fd4074493",
)


def source_functions(source):
    result = {}
    for match in re.finditer(
        r"CREATE(?: OR REPLACE)? FUNCTION\s+([\w.]+)\s*\(", source
    ):
        tail = source[match.start() :]
        marker = re.search(r"\bAS\s+(\$[A-Za-z_0-9]*\$)", tail)
        if marker is None:
            raise RuntimeError("Function delimiter missing")
        end = tail.index(marker.group(1), marker.end())
        result.setdefault(match.group(1), []).append(tail[marker.end() : end])
    return result


def reviewed_timed_bodies(before, after):
    return (
        isinstance(before, str)
        and isinstance(after, str)
        and tuple(hashlib.sha256(body.encode()).hexdigest() for body in (before, after))
        == TIMED_BODY_HASHES
    )


def require_reviewed_timed_sources(before, after):
    if (
        len(before) != 1
        or len(after) != 1
        or not reviewed_timed_bodies(before[0], after[0])
    ):
        raise RuntimeError(
            "Timed candidate differs from the exact reviewed old/new bodies"
        )


def verify_retained_sources(accepted, current):
    if hashlib.sha256(accepted.encode()).hexdigest() != BASE_HASH:
        raise RuntimeError("Frozen complete V57 source pin differs")
    before, after = source_functions(accepted), source_functions(current)
    added = {
        "public.koaryu_release_schema_preflight_v37",
        "public.koaryu_release_schema_preflight_v38",
    }
    if len(before) != 212 or len(after) != 214 or after.keys() != before.keys() | added:
        raise RuntimeError(
            "V57 source function inventory differs from the reviewed 212/214 names"
        )
    if any(len(bodies) != 1 for bodies in before.values()) or any(
        len(bodies) != 1 for bodies in after.values()
    ):
        raise RuntimeError("V57 source contains an unexpected function overload")
    require_reviewed_timed_sources(before[TIMED_FUNCTION], after[TIMED_FUNCTION])
    for name, bodies in before.items():
        if name != TIMED_FUNCTION and after[name] != bodies:
            raise RuntimeError("Unaffected retained source body changed: " + name)
    return {
        "frozen_functions": len(before),
        "current_functions": len(after),
        "reviewed_change": TIMED_FUNCTION,
    }


def retained_function_equal(signature, before, after):
    if signature != TIMED_SIGNATURE:
        return before == after
    if (
        not isinstance(before, dict)
        or not isinstance(after, dict)
        or before.keys() != after.keys()
    ):
        return False
    if not reviewed_timed_bodies(before.get("body"), after.get("body")):
        return False
    return all(before[key] == after[key] for key in before if key != "body")
