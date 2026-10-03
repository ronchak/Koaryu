import asyncio
from datetime import date
from unittest.mock import Mock, patch

import pytest

from app.services.student_photo_actions import StudentPhotoActions
from tests.fakes.supabase import TableBackedSupabase


def build_photo_actions():
    supabase = TableBackedSupabase(
        {
            "students": [
                {
                    "id": "student-1",
                    "studio_id": "studio-1",
                    "date_of_birth": "2010-01-01",
                    "photo_path": "studio-1/student-1/old.webp",
                    "deleted_at": None,
                }
            ],
            "studios": [],
            "audit_logs": [],
        }
    )
    photo_store = Mock()
    response_builder = Mock()
    return (
        StudentPhotoActions(supabase, photo_store, response_builder),
        supabase,
        photo_store,
        response_builder,
    )


def test_failed_date_lookup_prevents_photo_upload_side_effects():
    actions, supabase, photo_store, _response_builder = build_photo_actions()

    with pytest.raises(RuntimeError, match="timezone could not be loaded"):
        actions.upload_validated(
            "student-1",
            "studio-1",
            "actor-1",
            b"image",
            "image/webp",
            "webp",
        )

    photo_store.upload.assert_not_called()
    assert supabase.tables["students"][0]["photo_path"] == "studio-1/student-1/old.webp"
    assert supabase.tables["audit_logs"] == []

    actions, supabase, photo_store, response_builder = build_photo_actions()
    supabase.tables["students"][0]["date_of_birth"] = None
    events = []
    reference_date = date(2026, 9, 20)
    photo_store.path_for.return_value = "studio-1/student-1/new.webp"
    photo_store.columns_available.return_value = True
    photo_store.upload.side_effect = lambda *_args: events.append("upload")
    response_builder.row_to_response.side_effect = lambda row, **_kwargs: row

    def concurrent_dob_update(rows):
        events.append("database_update")
        rows[0]["date_of_birth"] = "2010-01-01"

    supabase.before_update = concurrent_dob_update
    with patch(
        "app.services.student_photo_actions.studio_today_for_studio",
        side_effect=lambda *_args: events.append("date_lookup") or reference_date,
    ) as studio_date:
        result = actions.upload_validated(
            "student-1",
            "studio-1",
            "actor-1",
            b"image",
            "image/webp",
            "webp",
        )

    assert events == ["date_lookup", "upload", "database_update"]
    studio_date.assert_called_once_with(supabase, "studio-1")
    assert result["date_of_birth"] == "2010-01-01"
    assert response_builder.row_to_response.call_args.kwargs["today"] == reference_date
    photo_store.remove.assert_called_once_with(
        ["studio-1/student-1/old.webp"], raise_on_failure=False
    )
    assert supabase.tables["audit_logs"][0]["action"] == "student.photo_uploaded"


def test_failed_date_lookup_prevents_photo_delete_side_effects():
    actions, supabase, photo_store, _response_builder = build_photo_actions()

    with pytest.raises(RuntimeError, match="timezone could not be loaded"):
        asyncio.run(actions.delete("student-1", "studio-1", "actor-1"))

    photo_store.remove.assert_not_called()
    assert supabase.tables["students"][0]["photo_path"] == "studio-1/student-1/old.webp"
    assert supabase.tables["audit_logs"] == []

    actions, supabase, photo_store, response_builder = build_photo_actions()
    supabase.tables["students"][0]["date_of_birth"] = None
    events = []
    reference_date = date(2026, 9, 20)
    photo_store.columns_available.return_value = True
    photo_store.remove.side_effect = lambda *_args, **_kwargs: events.append("remove")
    response_builder.row_to_response.side_effect = lambda row, **_kwargs: row

    def concurrent_dob_update(rows):
        events.append("database_update")
        rows[0]["date_of_birth"] = "2010-01-01"

    supabase.before_update = concurrent_dob_update
    with patch(
        "app.services.student_photo_actions.studio_today_for_studio",
        side_effect=lambda *_args: events.append("date_lookup") or reference_date,
    ) as studio_date:
        result = asyncio.run(actions.delete("student-1", "studio-1", "actor-1"))

    assert events == ["date_lookup", "remove", "database_update"]
    studio_date.assert_called_once_with(supabase, "studio-1")
    assert result["date_of_birth"] == "2010-01-01"
    assert response_builder.row_to_response.call_args.kwargs["today"] == reference_date
    assert supabase.tables["audit_logs"][0]["action"] == "student.photo_deleted"
