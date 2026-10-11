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

Concurrency: a save is a read-modify-write of the whole metadata object with no
lock. One user's saves are rare and debounced by the client, so the cost of a
race is one lost layout change or one stale copy of another top-level key
written in the same instant. No lock is held across the Auth admin calls.
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


def merge_home_preferences_metadata(
    user_metadata: Mapping[str, Any], studio_id: str, entry: Mapping[str, Any]
) -> dict[str, Any]:
    """The complete ``user_metadata`` to send when saving ``entry`` for ``studio_id``.

    Every other top-level key is copied exactly as read. The namespace is
    rewritten to hold only this studio's entry: other studios' entries are
    stale (an account belongs to one studio) and are dropped.
    """

    return {**user_metadata, HOME_PREFERENCES_METADATA_KEY: {studio_id: dict(entry)}}


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
            # Never overwrite metadata this service cannot read back intact.
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

        # Read immediately before writing to keep the lost-update window small.
        metadata = self._read_user_metadata_sync(user_id)
        merged = merge_home_preferences_metadata(metadata, studio_id, entry)
        if merged != metadata:
            # GoTrue merges top-level user_metadata keys on admin update; sending
            # the complete object keeps every other key even where it would replace it.
            self.supabase.auth.admin.update_user_by_id(user_id, {"user_metadata": merged})
        return reconciled
