"""Home preferences, stored in the viewer's Supabase Auth ``user_metadata``.

Layout: ``user_metadata["koaryu_home"] = {"<studio_id>": <preferences>}``. Only
the backend reads or writes the namespace, through the Auth admin API, after
resolving the active studio membership itself; a client never names the user
or the studio. Every read is size-checked and reconciled for the viewer's
current role, because a browser holding its own session can also edit
``user_metadata`` and because roles change.

An account belongs to exactly one studio, so a save keeps only the active
studio's entry; any other entry is stale data from a previous membership and is
dropped. The access token copies ``user_metadata`` into its claims, so the one
entry is capped well below the session cookie budget.

Writes depend on GoTrue's merge. The admin update (``PUT /admin/users/{id}``)
applies ``user_metadata`` through ``User.UpdateUserMetaData``, which sets each
top-level key in the request whose value is not null, deletes each null one,
and leaves every key the request omits untouched. The installed client
(gotrue 2.12.4) sends the attributes unchanged. A save therefore sends only
``{"koaryu_home": {"<studio_id>": <entry>}}``: that replaces our namespace
wholesale (dropping other studios' entries) and never re-sends, reverts or
deletes another key, such as a ``full_name`` changed in the same instant or a
key whose stored value is null.

Concurrency: the pre-read only decides whether a write is needed. With no lock,
two saves of the same user racing can lose one layout change; nothing else is
at risk. No lock is held across the Auth admin calls.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from typing import Any, Optional

from fastapi import HTTPException, status
from supabase import Client

from app.schemas.dashboard_home import (
    DashboardHomePreferences,
    DashboardHomePreferencesUpdate,
)
from app.services.dashboard_home_sections import (
    HOME_PANEL_DEFAULT_ORDER,
    reconcile_home_preferences,
)
from app.services.studio_scope import (
    STAFF_ARCHIVED_DETAIL,
    ensure_platform_subscription_access,
    resolve_staff_membership_state_for_user,
)

HOME_PREFERENCES_METADATA_KEY = "koaryu_home"
HOME_PREFERENCES_ENTRY_MAX_BYTES = 1024
NO_ACTIVE_STUDIO_DETAIL = "Home preferences need an active studio membership."
PREFERENCES_TOO_LARGE_DETAIL = "Home preferences are too large."

logger = logging.getLogger(__name__)


def serialized_bytes(value: Any) -> int:
    """Size of ``value`` as compact JSON, the form stored in ``raw_user_meta_data``."""

    return len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def read_home_preferences(
    user_metadata: Any, studio_id: str, role: Optional[str]
) -> Optional[DashboardHomePreferences]:
    """This studio's saved preferences, reconciled for ``role``; ``None`` if absent or unreadable.

    Never raises: a missing, oversized or malformed entry only omits the section.
    """

    try:
        if not isinstance(user_metadata, Mapping):
            return None
        namespace = user_metadata.get(HOME_PREFERENCES_METADATA_KEY)
        if not isinstance(namespace, Mapping):
            return None
        entry = namespace.get(studio_id)
        if entry is None or serialized_bytes(entry) > HOME_PREFERENCES_ENTRY_MAX_BYTES:
            return None
        # An entry naming no known panel holds no choice to honour; treat it as never saved.
        order = entry.get("order") if isinstance(entry, Mapping) else None
        if not isinstance(order, (list, tuple)) or not any(
            panel in HOME_PANEL_DEFAULT_ORDER for panel in order if isinstance(panel, str)
        ):
            return None
        return reconcile_home_preferences(entry, role)
    except Exception as error:
        logger.warning("Home preferences unreadable", extra={"error_type": type(error).__name__})
        return None


def home_preferences_metadata_update(studio_id: str, entry: Mapping[str, Any]) -> dict[str, Any]:
    """The ``user_metadata`` patch that saves ``entry``: our one top-level key, nothing else.

    GoTrue merges top-level keys, so this replaces the whole namespace with this
    studio's entry and leaves every other key as stored.
    """

    return {HOME_PREFERENCES_METADATA_KEY: {studio_id: dict(entry)}}


def _log_lost_metadata_keys(before: Mapping[str, Any], response: Any) -> None:
    """Report, never repair, top-level keys the update response no longer has."""

    after = getattr(getattr(response, "user", None), "user_metadata", None)
    if not isinstance(after, Mapping):
        return
    lost = [key for key in before if key != HOME_PREFERENCES_METADATA_KEY and key not in after]
    if lost:
        # Key names only; metadata values never reach the logs.
        logger.error(
            "Home preferences save lost Auth metadata keys",
            extra={
                "lost_key_count": len(lost),
                "lost_keys": sorted(str(key)[:64] for key in lost)[:10],
            },
        )


class DashboardHomePreferencesService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def _resolve_active_membership_sync(
        self, user_id: str, requested_studio_id: Optional[str]
    ) -> tuple[str, str]:
        """The server-verified (studio_id, role); the requested studio is only a selector.

        409 for an ambiguous identity and 403 for a foreign selector propagate
        from membership resolution; an archived or missing membership is 403;
        a lapsed subscription is 402.
        """

        membership, membership_status = resolve_staff_membership_state_for_user(
            self.supabase, user_id, requested_studio_id
        )
        if membership_status == "archived":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=STAFF_ARCHIVED_DETAIL)
        if membership_status != "active" or not membership:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail=NO_ACTIVE_STUDIO_DETAIL
            )
        studio_id, role = membership["studio_id"], membership["role"]
        ensure_platform_subscription_access(self.supabase, studio_id)
        return studio_id, role

    def _read_user_metadata_sync(self, user_id: str) -> Mapping[str, Any]:
        user = self.supabase.auth.admin.get_user_by_id(user_id).user
        if not user:
            raise RuntimeError("Auth user not found")
        metadata = user.user_metadata
        if metadata is None:
            return {}
        if not isinstance(metadata, Mapping):
            # Do not write beside metadata this service cannot read.
            raise RuntimeError("Auth user metadata is not an object")
        return metadata

    def save_sync(
        self,
        user_id: str,
        requested_studio_id: Optional[str],
        preferences: DashboardHomePreferencesUpdate,
    ) -> DashboardHomePreferences:
        """Reconcile for the viewer's role, store for the active studio, return what was stored."""

        studio_id, role = self._resolve_active_membership_sync(user_id, requested_studio_id)
        reconciled = reconcile_home_preferences(preferences.model_dump(mode="json"), role)
        if reconciled is None:
            # Unreachable for a validated body; never store an unreconciled value.
            raise RuntimeError("Home preferences did not reconcile")
        entry = reconciled.model_dump(mode="json")
        if serialized_bytes(entry) > HOME_PREFERENCES_ENTRY_MAX_BYTES:
            raise HTTPException(status_code=413, detail=PREFERENCES_TOO_LARGE_DETAIL)

        # The pre-read only decides whether to write; it is never sent back.
        metadata = self._read_user_metadata_sync(user_id)
        update = home_preferences_metadata_update(studio_id, entry)
        if metadata.get(HOME_PREFERENCES_METADATA_KEY) != update[HOME_PREFERENCES_METADATA_KEY]:
            response = self.supabase.auth.admin.update_user_by_id(
                user_id, {"user_metadata": update}
            )
            _log_lost_metadata_keys(metadata, response)
        return reconciled
