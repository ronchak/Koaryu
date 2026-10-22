"""Duplicate review for CSV student imports.

This module is the single owner of the duplicate label rules shared with the
synthetic import corpus (``backend/tests/fixtures/csv_import/corpus``). It is
pure: no database access, no side effects. The planner feeds it planned rows
plus the studio roster; the executor feeds it the same inputs again at
execution start so decisions are honoured only against what is actually there.

Identity rules (students):

* Only normalised legal names plus date of birth or the student's own email or
  phone identify a student. Preferred name never participates. Guardian email,
  guardian phone and surname alone never identify a student, because that is
  exactly what siblings look like.
* Earlier rows in the same file are compared first; ``of_row`` is the earliest
  matching row. Existing students are compared second. When both match at the
  same confidence, the in-file match names the class. A ``RowMatch`` describes
  the best overall match only, so exactly one of ``of_row`` and
  ``of_existing_key`` is set; the other source stays in ``candidates``.

Identity rules (guardians) mirror the database row writer: the guardian name is
split on the first space. Guardian matches are family context only in A1; the
import row RPC does not reuse guardians until the A2 migration.

Row numbers are the parser's compacted numbers (first data row is 2, blank
lines are not counted), exactly as receipts use them.
"""

from __future__ import annotations

import re
import unicodedata
from bisect import insort
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

NAME_SUFFIX_TOKENS = {"jr", "sr", "ii", "iii", "iv"}
STRONG_CLASSES = {"in_file_strong", "existing_strong"}
FLAGGED_CLASSES = {
    "in_file_strong",
    "in_file_possible",
    "existing_strong",
    "existing_possible",
    "archived_match",
}
CONFIDENCE_RANK = {"strong": 3, "possible": 2, "different_person": 1}
REASON_WORDS = {
    "name": "same name",
    "date_of_birth": "same birth date",
    "email": "same email",
    "phone": "same phone",
    "birth_date_conflict": "different birth date",
    "first_name": "same first name",
    "last_name": "same last name",
    "name_mismatch": "different name",
    "strong": "strong match",
    "possible": "possible match",
}
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def name_key(value: Any) -> str:
    """Casefolded, accent-stripped name of any script with a trailing suffix dropped."""
    if value is None:
        return ""
    text = unicodedata.normalize("NFKD", str(value))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).casefold()
    # Letters and digits of any script survive; punctuation, spaces and
    # underscores do not, so "O'Neill", "Ava-Grace" and CJK names all key.
    tokens = re.findall(r"[^\W_]+", text)
    if len(tokens) > 1 and tokens[-1] in NAME_SUFFIX_TOKENS:
        tokens = tokens[:-1]
    return "".join(tokens)


def email_key(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip().lower()
    return text or None


def phone_key(value: Any) -> Optional[str]:
    if value is None:
        return None
    digits = re.sub(r"\D", "", str(value))
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) < 7:
        return None
    return digits[-10:]


def date_key(value: Any) -> Optional[str]:
    if isinstance(value, str) and ISO_DATE.match(value):
        return value
    return None


def split_guardian_name(value: Any) -> tuple[str, str]:
    """Split on the first space, as the import row RPC does."""
    text = "" if value is None else str(value).strip()
    if not text:
        return "", ""
    first, _, rest = text.partition(" ")
    return first, rest.strip()


@dataclass(frozen=True)
class StudentIdentity:
    first: str
    last: str
    date_of_birth: Optional[str]
    email: Optional[str]
    phone: Optional[str]

    @property
    def has_name(self) -> bool:
        return bool(self.first and self.last)


@dataclass(frozen=True)
class GuardianIdentity:
    first: str
    last: str
    email: Optional[str]
    phone: Optional[str]

    @property
    def present(self) -> bool:
        return bool(self.first or self.last or self.email or self.phone)


@dataclass
class MatchCandidate:
    source: str  # "row" | "existing"
    confidence: str  # strong | possible | different_person
    reasons: list[str]
    row_number: Optional[int] = None
    existing_key: Optional[str] = None
    archived: bool = False
    display_name: str = ""


@dataclass
class GuardianCandidate:
    source: str  # "row" | "existing"
    strength: str  # link | separate
    reasons: list[str]
    row_number: Optional[int] = None
    existing_key: Optional[str] = None
    student_display_name: str = ""


@dataclass
class RowMatch:
    row_number: int
    duplicate_class: str = "none"
    of_row: Optional[int] = None
    of_existing_key: Optional[str] = None
    reasons: list[str] = field(default_factory=list)
    guardian_class: str = "none"
    guardian_of_row: Optional[int] = None
    guardian_of_existing_key: Optional[str] = None
    guardian_reasons: list[str] = field(default_factory=list)
    candidates: list[MatchCandidate] = field(default_factory=list)
    guardian_candidates: list[GuardianCandidate] = field(default_factory=list)
    # The row's own identity and a lookup shared by every row of one
    # ``match_rows`` call, so a reference that the bounded candidate list does
    # not hold can still be compared directly (see ``candidate_for_reference``).
    identity: Optional["StudentIdentity"] = field(default=None, repr=False, compare=False)
    references: dict[tuple[str, Any], "_Reference"] = field(
        default_factory=dict, repr=False, compare=False
    )

    @property
    def is_flagged(self) -> bool:
        return self.duplicate_class in FLAGGED_CLASSES

    @property
    def requires_decision(self) -> bool:
        return self.duplicate_class in STRONG_CLASSES or self.duplicate_class == "archived_match"

    @property
    def has_archived_candidate(self) -> bool:
        return any(
            candidate.archived and candidate.confidence in {"strong", "possible"}
            for candidate in self.candidates
        )

    @property
    def suggested_action(self) -> str:
        # Any archived strong or possible candidate needs the owner's call,
        # even when an active match outranks it.
        if self.duplicate_class == "archived_match" or self.has_archived_candidate:
            return "decide"
        if self.duplicate_class in STRONG_CLASSES:
            return "skip"
        return "create"

    @property
    def acknowledge_student_ids(self) -> list[str]:
        return [
            candidate.existing_key
            for candidate in self.candidates
            if candidate.source == "existing"
            and candidate.existing_key is not None
            and needs_acknowledgement(candidate)
        ]

    @property
    def acknowledge_rows(self) -> list[int]:
        return [
            candidate.row_number
            for candidate in self.candidates
            if candidate.source == "row"
            and candidate.row_number is not None
            and needs_acknowledgement(candidate)
        ]


def student_identity_from_row(data: dict[str, Any]) -> StudentIdentity:
    return StudentIdentity(
        first=name_key(data.get("legal_first_name")),
        last=name_key(data.get("legal_last_name")),
        date_of_birth=date_key(data.get("date_of_birth")),
        email=email_key(data.get("email")),
        phone=phone_key(data.get("phone")),
    )


def student_identity_from_existing(entry: dict[str, Any]) -> StudentIdentity:
    return StudentIdentity(
        first=name_key(entry.get("legal_first_name")),
        last=name_key(entry.get("legal_last_name")),
        date_of_birth=date_key(entry.get("date_of_birth")),
        email=email_key(entry.get("email")),
        phone=phone_key(entry.get("phone")),
    )


def guardian_identity_from_row(data: dict[str, Any]) -> GuardianIdentity:
    first, last = split_guardian_name(data.get("guardian_name"))
    return GuardianIdentity(
        first=name_key(first),
        last=name_key(last),
        email=email_key(data.get("guardian_email")),
        phone=phone_key(data.get("guardian_phone")),
    )


def guardian_identity_from_existing(entry: dict[str, Any]) -> GuardianIdentity:
    return GuardianIdentity(
        first=name_key(entry.get("first_name")),
        last=name_key(entry.get("last_name")),
        email=email_key(entry.get("email")),
        phone=phone_key(entry.get("phone")),
    )


def compare_students(
    candidate: StudentIdentity, other: StudentIdentity
) -> Optional[tuple[str, list[str]]]:
    if not candidate.has_name or not other.has_name:
        return None
    if candidate.first != other.first or candidate.last != other.last:
        return None
    same_email = bool(candidate.email) and candidate.email == other.email
    if candidate.date_of_birth and other.date_of_birth:
        if candidate.date_of_birth == other.date_of_birth:
            return "strong", ["name", "date_of_birth"]
        if same_email:
            return "possible", ["name", "email", "birth_date_conflict"]
        return "different_person", ["name", "birth_date_conflict"]
    if same_email:
        return "strong", ["name", "email"]
    if candidate.phone and candidate.phone == other.phone:
        return "possible", ["name", "phone"]
    return "possible", ["name"]


def compare_guardians(
    candidate: GuardianIdentity, other: GuardianIdentity
) -> Optional[tuple[str, list[str]]]:
    if not candidate.present or not other.present:
        return None
    same_first = bool(candidate.first) and candidate.first == other.first
    same_last = bool(candidate.last) and candidate.last == other.last
    same_name = same_first and same_last
    if candidate.email and candidate.email == other.email:
        if same_first or same_last:
            # One name part is enough for a link; first name wins when both agree.
            return "link", ["email", "first_name" if same_first else "last_name"]
        return "separate", ["email", "name_mismatch"]
    if same_name and candidate.phone and candidate.phone == other.phone:
        return "link", ["name", "phone"]
    if same_name:
        return "separate", ["name"]
    return None


def display_name_for_existing(entry: dict[str, Any]) -> str:
    preferred = (entry.get("preferred_name") or "").strip()
    first = (entry.get("legal_first_name") or "").strip()
    last = (entry.get("legal_last_name") or "").strip()
    return " ".join(part for part in (preferred or first, last) if part) or "Student"


def display_name_for_row(data: dict[str, Any]) -> str:
    first = str(data.get("legal_first_name") or "").strip()
    last = str(data.get("legal_last_name") or "").strip()
    return " ".join(part for part in (first, last) if part) or "Student"


def reason_words(reasons: list[str]) -> list[str]:
    return [REASON_WORDS.get(reason, reason.replace("_", " ")) for reason in reasons]


def _candidate_sort_key(candidate: MatchCandidate) -> tuple[int, int, int, int]:
    return (
        -CONFIDENCE_RANK[candidate.confidence],
        1 if candidate.archived else 0,
        0 if candidate.source == "row" else 1,
        candidate.row_number or 0,
    )


def _class_for(candidate: MatchCandidate) -> tuple[str, list[str]]:
    """Class and reasons for the best candidate; different_person carries no reasons."""
    if candidate.confidence == "different_person":
        return "different_person", []
    if candidate.source == "row":
        if candidate.confidence == "strong":
            return "in_file_strong", list(candidate.reasons)
        return "in_file_possible", list(candidate.reasons)
    if candidate.archived:
        return "archived_match", [*candidate.reasons, candidate.confidence]
    if candidate.confidence == "strong":
        return "existing_strong", list(candidate.reasons)
    return "existing_possible", list(candidate.reasons)


DISPLAY_CANDIDATE_CAP = 5
# Earlier rows of the same file kept per signal bucket, and guardian records
# kept per guardian bucket. A file that repeats one person thousands of times
# would otherwise compare every row with every earlier row and send every pair
# to the browser (1,000 identical rows produced an 80 MB preview).
MATCH_BUCKET_CAP = 5


def _bounded_add(
    bucket: list[Any], record: Any, cap: Optional[int], order: Optional[Callable[[Any], int]]
) -> None:
    """Append, or keep only the ``cap`` records that sort first by ``order``.

    Without ``order`` the earliest inserted records are kept.
    """
    if cap is None:
        bucket.append(record)
    elif order is not None:
        insort(bucket, record, key=order)
        del bucket[cap:]
    elif len(bucket) < cap:
        bucket.append(record)


def _keep_first(
    mapping: dict[Any, Any], key: Any, record: Any, order: Optional[Callable[[Any], int]]
) -> None:
    current = mapping.get(key)
    if current is None or (order is not None and order(record) < order(current)):
        mapping[key] = record


class _StudentIndex:
    """Keyed lookup so each row compares only against records that can match.

    The roster index (``order`` absent) keeps insertion order and never
    truncates a bucket keyed by a shared signal: every existing student that
    could be a strong match is compared, because execution refuses a row whose
    strong matches were not acknowledged.

    The in-file index (``order`` = row number) keeps only the ``cap`` earliest
    rows per bucket, whatever order rows arrive in (receipt-backed rows of a
    retried run arrive first). The earliest strong match is never dropped: a
    row with a birth date is strong against rows with the same birth date
    (``by_name_dob``) or with none and the same email (``by_name_email_no_dob``),
    and a row without one is strong against every row with the same email
    (``by_name_email``); each of those buckets keeps its earliest rows. Every
    row that repeats an earlier person therefore still needs a decision naming
    the earliest copies, and the work stays linear in the file size.

    Only the plain-name buckets use representatives, since a name alone can
    yield at most a possible or different-person outcome. ``compare_students``
    remains the single classification rule.
    """

    def __init__(
        self, *, cap: Optional[int] = None, order: Optional[Callable[[Any], int]] = None
    ) -> None:
        self.cap = cap
        self.order = order
        self.by_name_dob: dict[tuple[str, str, str], list[Any]] = defaultdict(list)
        self.by_name_email: dict[tuple[str, str, str], list[Any]] = defaultdict(list)
        self.by_name_email_no_dob: dict[tuple[str, str, str], list[Any]] = defaultdict(list)
        self.by_name_phone: dict[tuple[str, str, str], list[Any]] = defaultdict(list)
        # Active records collapse to plain-name representatives, because a
        # plain-name match on an active record can only be possible or
        # different-person, which never needs acknowledgement.
        self.first_by_name: dict[tuple[str, str], Any] = {}
        self.first_missing_dob_by_name: dict[tuple[str, str], Any] = {}
        self.first_by_name_and_dob: dict[tuple[str, str], dict[str, Any]] = defaultdict(dict)
        # Archived records never collapse: every one must reach enforcement.
        self.archived_by_name: dict[tuple[str, str], list[Any]] = defaultdict(list)

    def add(self, identity: StudentIdentity, record: Any, *, archived: bool = False) -> None:
        if not identity.has_name:
            return
        name = (identity.first, identity.last)
        cap, order = self.cap, self.order
        if identity.date_of_birth:
            _bounded_add(self.by_name_dob[(*name, identity.date_of_birth)], record, cap, order)
        if identity.email:
            _bounded_add(self.by_name_email[(*name, identity.email)], record, cap, order)
            if not identity.date_of_birth:
                _bounded_add(self.by_name_email_no_dob[(*name, identity.email)], record, cap, order)
        if identity.phone:
            _bounded_add(self.by_name_phone[(*name, identity.phone)], record, cap, order)
        if archived:
            self.archived_by_name[name].append(record)
            return
        _keep_first(self.first_by_name, name, record, order)
        if identity.date_of_birth:
            _keep_first(self.first_by_name_and_dob[name], identity.date_of_birth, record, order)
        else:
            _keep_first(self.first_missing_dob_by_name, name, record, order)

    def lookup(self, identity: StudentIdentity) -> list[Any]:
        if not identity.has_name:
            return []
        name = (identity.first, identity.last)
        pool: list[Any] = []
        if identity.date_of_birth:
            pool.extend(self.by_name_dob.get((*name, identity.date_of_birth), []))
        if identity.email:
            pool.extend(self.by_name_email.get((*name, identity.email), []))
            if identity.date_of_birth:
                pool.extend(self.by_name_email_no_dob.get((*name, identity.email), []))
        if identity.phone:
            pool.extend(self.by_name_phone.get((*name, identity.phone), []))
        if identity.date_of_birth:
            representative = self.first_missing_dob_by_name.get(name)
            if representative is not None:
                pool.append(representative)
            for dob, record in self.first_by_name_and_dob.get(name, {}).items():
                if dob != identity.date_of_birth:
                    pool.append(record)
                    break
        else:
            representative = self.first_by_name.get(name)
            if representative is not None:
                pool.append(representative)
        pool.extend(self.archived_by_name.get(name, []))
        return _unique_records(pool)


class _GuardianIndex:
    """Guardian lookups only describe family context and never gate a write,
    so every bucket keeps at most ``cap`` records (the earliest rows for the
    in-file index, the first roster entries otherwise). A placeholder guardian
    shared by the whole roster and the whole file stays linear."""

    def __init__(
        self, *, cap: Optional[int] = None, order: Optional[Callable[[Any], int]] = None
    ) -> None:
        self.cap = cap
        self.order = order
        self.by_email_first: dict[tuple[str, str], list[Any]] = defaultdict(list)
        self.by_email_last: dict[tuple[str, str], list[Any]] = defaultdict(list)
        self.first_by_email: dict[str, Any] = {}
        self.by_name_phone: dict[tuple[str, str, str], list[Any]] = defaultdict(list)
        self.first_by_name: dict[tuple[str, str], Any] = {}

    def add(self, guardian: GuardianIdentity, record: Any) -> None:
        if not guardian.present:
            return
        cap, order = self.cap, self.order
        if guardian.email:
            _keep_first(self.first_by_email, guardian.email, record, order)
            if guardian.first:
                _bounded_add(
                    self.by_email_first[(guardian.email, guardian.first)], record, cap, order
                )
            if guardian.last:
                _bounded_add(
                    self.by_email_last[(guardian.email, guardian.last)], record, cap, order
                )
        if guardian.first and guardian.last:
            name = (guardian.first, guardian.last)
            _keep_first(self.first_by_name, name, record, order)
            if guardian.phone:
                _bounded_add(self.by_name_phone[(*name, guardian.phone)], record, cap, order)

    def lookup(self, guardian: GuardianIdentity) -> list[Any]:
        if not guardian.present:
            return []
        pool: list[Any] = []
        if guardian.email:
            if guardian.first:
                pool.extend(self.by_email_first.get((guardian.email, guardian.first), []))
            if guardian.last:
                pool.extend(self.by_email_last.get((guardian.email, guardian.last), []))
            representative = self.first_by_email.get(guardian.email)
            if representative is not None:
                pool.append(representative)
        if guardian.first and guardian.last:
            name = (guardian.first, guardian.last)
            if guardian.phone:
                pool.extend(self.by_name_phone.get((*name, guardian.phone), []))
            representative = self.first_by_name.get(name)
            if representative is not None:
                pool.append(representative)
        return _unique_records(pool)


def _unique_records(records: list[Any]) -> list[Any]:
    seen: set[int] = set()
    unique: list[Any] = []
    for record in records:
        marker = id(record)
        if marker in seen:
            continue
        seen.add(marker)
        unique.append(record)
    return unique


@dataclass
class _RunRecord:
    row_number: int
    identity: StudentIdentity
    guardian: GuardianIdentity
    display_name: str


@dataclass
class _Reference:
    identity: StudentIdentity
    display_name: str
    archived: bool = False


@dataclass
class _ExistingRecord:
    entry: dict[str, Any]
    identity: StudentIdentity
    display_name: str


@dataclass
class _ExistingGuardianRecord:
    entry: dict[str, Any]
    guardian: GuardianIdentity
    student_display_name: str


def match_rows(
    planned_rows: list[dict[str, Any]],
    existing_roster: list[dict[str, Any]],
) -> list[RowMatch]:
    """Classify every planned row against earlier rows and the studio roster.

    ``planned_rows`` are planner row dicts with ``row_number`` and ``data``
    (``legal_first_name``, ``legal_last_name``, ``date_of_birth`` as an ISO
    string when parsed, ``email``, ``phone``, ``guardian_name``,
    ``guardian_email``, ``guardian_phone``). Rows flagged ``completed`` are
    receipt replays without row data; they are matched through the roster entry
    that carries their ``import_row_number`` instead. Rows with ``is_valid``
    false are matched themselves but never become a target for later rows,
    because they are never imported.

    ``existing_roster`` entries carry ``key``, ``legal_first_name``,
    ``legal_last_name``, ``preferred_name``, ``date_of_birth``, ``email``,
    ``phone``, ``archived`` and ``guardians`` (``key``, ``first_name``,
    ``last_name``, ``email``, ``phone``). An optional ``import_row_number``
    marks a student this very import already created, so a later row matching
    it is reported as an in-file match of that row.

    Candidates come from keyed indexes (name plus birth date, email or phone
    for students; email plus a name part, or name plus phone, for guardians)
    with one representative per plain-name bucket. Earlier rows of the file and
    guardian records are bounded per bucket (``MATCH_BUCKET_CAP``), so a
    10,000-row file against a large roster stays linear even when one person or
    one placeholder guardian repeats on every row.
    """

    ordered = sorted(planned_rows, key=lambda row: int(row["row_number"]))

    def by_row(record: _RunRecord) -> int:
        return record.row_number

    run_students = _StudentIndex(cap=MATCH_BUCKET_CAP, order=by_row)
    run_guardians = _GuardianIndex(cap=MATCH_BUCKET_CAP, order=by_row)
    # Existing students stay uncapped: enforcement needs every strong match.
    existing_students = _StudentIndex()
    existing_guardians = _GuardianIndex(cap=MATCH_BUCKET_CAP)
    references: dict[tuple[str, Any], _Reference] = {}

    for entry in existing_roster:
        identity = student_identity_from_existing(entry)
        student_name = display_name_for_existing(entry)
        import_row = entry.get("import_row_number")
        if isinstance(import_row, int):
            guardian = GuardianIdentity("", "", None, None)
            for guardian_entry in entry.get("guardians") or []:
                guardian = guardian_identity_from_existing(guardian_entry)
                break
            record = _RunRecord(import_row, identity, guardian, student_name)
            run_students.add(identity, record)
            run_guardians.add(guardian, record)
            references[("row", import_row)] = _Reference(identity, student_name)
            continue
        references[("existing", str(entry.get("key")))] = _Reference(
            identity, student_name, archived=bool(entry.get("archived"))
        )
        existing_students.add(
            identity,
            _ExistingRecord(entry, identity, student_name),
            archived=bool(entry.get("archived")),
        )
        for guardian_entry in entry.get("guardians") or []:
            guardian = guardian_identity_from_existing(guardian_entry)
            existing_guardians.add(
                guardian, _ExistingGuardianRecord(guardian_entry, guardian, student_name)
            )

    results: list[RowMatch] = []
    for row in ordered:
        row_number = int(row["row_number"])
        match = RowMatch(row_number=row_number)
        results.append(match)
        if row.get("completed"):
            continue
        data = row.get("data") or {}
        identity = student_identity_from_row(data)
        guardian = guardian_identity_from_row(data)
        row_name = display_name_for_row(data)
        match.identity = identity
        match.references = references

        candidates: list[MatchCandidate] = []
        for record in run_students.lookup(identity):
            if record.row_number >= row_number:
                continue
            outcome = compare_students(identity, record.identity)
            if outcome:
                candidates.append(
                    MatchCandidate(
                        "row",
                        outcome[0],
                        outcome[1],
                        row_number=record.row_number,
                        display_name=record.display_name,
                    )
                )
        for record in existing_students.lookup(identity):
            outcome = compare_students(identity, record.identity)
            if outcome:
                candidates.append(
                    MatchCandidate(
                        "existing",
                        outcome[0],
                        outcome[1],
                        existing_key=str(record.entry.get("key")),
                        archived=bool(record.entry.get("archived")),
                        display_name=record.display_name,
                    )
                )
        candidates.sort(key=_candidate_sort_key)
        match.candidates = candidates
        if candidates:
            # The RowMatch describes the best overall match only; the other
            # source stays available in ``candidates`` for display and decisions.
            best = candidates[0]
            match.duplicate_class, match.reasons = _class_for(best)
            if best.source == "row":
                match.of_row = best.row_number
            else:
                match.of_existing_key = best.existing_key

        if guardian.present:
            guardian_candidates: list[GuardianCandidate] = []
            for record in run_guardians.lookup(guardian):
                if record.row_number >= row_number:
                    continue
                outcome = compare_guardians(guardian, record.guardian)
                if outcome:
                    guardian_candidates.append(
                        GuardianCandidate(
                            "row",
                            outcome[0],
                            outcome[1],
                            row_number=record.row_number,
                            student_display_name=record.display_name,
                        )
                    )
            for record in existing_guardians.lookup(guardian):
                outcome = compare_guardians(guardian, record.guardian)
                if outcome:
                    guardian_candidates.append(
                        GuardianCandidate(
                            "existing",
                            outcome[0],
                            outcome[1],
                            existing_key=str(record.entry.get("key")),
                            student_display_name=record.student_display_name,
                        )
                    )
            guardian_candidates.sort(
                key=lambda c: (
                    0 if c.strength == "link" else 1,
                    0 if c.source == "row" else 1,
                    c.row_number or 0,
                )
            )
            match.guardian_candidates = guardian_candidates
            if guardian_candidates:
                best_guardian = guardian_candidates[0]
                if best_guardian.strength == "link":
                    match.guardian_class = (
                        "in_file_shared" if best_guardian.source == "row" else "link_existing"
                    )
                else:
                    match.guardian_class = "separate_contact"
                match.guardian_reasons = list(best_guardian.reasons)
                if best_guardian.source == "row":
                    match.guardian_of_row = best_guardian.row_number
                else:
                    match.guardian_of_existing_key = best_guardian.existing_key
            else:
                match.guardian_class = "new"

        if not row.get("is_valid", True):
            # A blocked row is never imported, so a later row cannot repeat it
            # or share its guardian; it is matched itself but never a target.
            continue
        record = _RunRecord(row_number, identity, guardian, row_name)
        run_students.add(identity, record)
        run_guardians.add(guardian, record)
        references[("row", row_number)] = _Reference(identity, row_name)
    return results


def displayed_candidates(match: RowMatch) -> list[MatchCandidate]:
    """Every candidate the owner must acknowledge, then the strongest others up to the cap.

    A decision copies the acknowledgement lists, so a record that needs
    acknowledging must always be on screen; the cap only trims the rest.
    """
    required = sum(1 for candidate in match.candidates if needs_acknowledgement(candidate))
    optional_slots = max(0, DISPLAY_CANDIDATE_CAP - required)
    shown: list[MatchCandidate] = []
    for candidate in match.candidates:
        if needs_acknowledgement(candidate):
            shown.append(candidate)
        elif optional_slots > 0:
            shown.append(candidate)
            optional_slots -= 1
    return shown


def build_duplicate_review(match: RowMatch) -> Optional[dict[str, Any]]:
    """Serialisable review payload for one row, or None when nothing was found."""
    if not match.candidates and match.guardian_class not in {
        "link_existing",
        "in_file_shared",
        "separate_contact",
    }:
        return None
    # Enforcement sees every candidate; the preview shows every one that needs
    # acknowledging plus the strongest few of the rest.
    candidates = [
        {
            "student_id": candidate.existing_key,
            "of_row": candidate.row_number,
            "display_name": candidate.display_name,
            "archived": candidate.archived,
            "confidence": candidate.confidence,
            "reasons": reason_words(candidate.reasons),
        }
        for candidate in displayed_candidates(match)
    ]
    family_context: list[str] = []
    for candidate in match.guardian_candidates[:3]:
        where = (
            f"row {candidate.row_number}" if candidate.source == "row" else "an existing student"
        )
        who = candidate.student_display_name or "a student"
        if candidate.strength == "link":
            family_context.append(f"Shares a guardian with {who} ({where}); likely family")
        else:
            family_context.append(
                f"Guardian details partly match {who} ({where}); treated as a separate contact"
            )
    return {
        "candidates": candidates,
        "suggested_action": match.suggested_action if match.is_flagged else "create",
        "family_context": family_context,
        "acknowledge_student_ids": match.acknowledge_student_ids,
        "acknowledge_rows": match.acknowledge_rows,
    }


def needs_acknowledgement(candidate: MatchCandidate) -> bool:
    """Strong matches and any archived match must be named before a row is written."""
    if candidate.confidence == "different_person":
        return False
    return candidate.confidence == "strong" or candidate.archived


def named_references(decision: Optional[Any]) -> tuple[set[str], set[int]]:
    """Existing student ids and earlier rows the owner's decision names."""
    if decision is None:
        return set(), set()
    students = {
        str(value)
        for value in [
            getattr(decision, "matched_student_id", None),
            *(getattr(decision, "acknowledged_student_ids", None) or []),
        ]
        if value
    }
    rows = {
        int(value)
        for value in [
            getattr(decision, "of_row", None),
            *(getattr(decision, "acknowledged_rows", None) or []),
        ]
        if value is not None
    }
    return students, rows


def unacknowledged_candidates(match: RowMatch, decision: Optional[Any]) -> list[MatchCandidate]:
    """Strong or archived candidates found now that the decision does not name."""
    students, rows = named_references(decision)
    return [
        candidate
        for candidate in match.candidates
        if needs_acknowledgement(candidate)
        and (
            (candidate.source == "existing" and candidate.existing_key not in students)
            or (candidate.source == "row" and candidate.row_number not in rows)
        )
    ]


def candidate_for_reference(
    match: RowMatch, reference: tuple[str, Any]
) -> Optional[MatchCandidate]:
    """The row's own strong or possible match with ("existing", key) or ("row", n).

    The candidate list is bounded for earlier rows and uses representatives for
    plain-name matches, so a student retained through a skip chain may be
    missing from it. A reference that is not listed is compared directly with
    the same rule (``compare_students``); only earlier rows and studio students
    seen by this ``match_rows`` call can be compared.
    """
    kind, value = reference
    for candidate in match.candidates:
        if candidate.confidence not in {"strong", "possible"}:
            continue
        if (
            kind == "existing"
            and candidate.source == "existing"
            and candidate.existing_key == str(value)
        ):
            return candidate
        if kind == "row" and candidate.source == "row" and candidate.row_number == int(value):
            return candidate
    if match.identity is None:
        return None
    key: tuple[str, Any] = ("existing", str(value)) if kind == "existing" else ("row", int(value))
    if kind == "row" and key[1] >= match.row_number:
        return None
    target = match.references.get(key)
    if target is None:
        return None
    outcome = compare_students(match.identity, target.identity)
    if outcome is None or outcome[0] not in {"strong", "possible"}:
        return None
    return MatchCandidate(
        "existing" if kind == "existing" else "row",
        outcome[0],
        outcome[1],
        row_number=key[1] if kind == "row" else None,
        existing_key=key[1] if kind == "existing" else None,
        archived=target.archived,
        display_name=target.display_name,
    )


def skip_target(match: RowMatch, decision: Optional[Any]) -> Optional[tuple[str, Any]]:
    """What a skip decision points at: the row's best overall match, if named.

    The target is exactly the reference the top-level class describes
    (``of_row`` or ``of_existing_key``). A decision that does not name that
    reference has no target; a skip never falls back to a weaker candidate.
    """
    if decision is None or not match.is_flagged:
        return None
    students, rows = named_references(decision)
    if match.of_row is not None:
        return ("row", match.of_row) if match.of_row in rows else None
    if match.of_existing_key is not None:
        return ("existing", match.of_existing_key) if match.of_existing_key in students else None
    return None
