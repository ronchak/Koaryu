from typing import Optional

from fastapi import HTTPException, UploadFile
from postgrest.exceptions import APIError as PostgrestAPIError
from storage3.utils import StorageException


STUDENT_PHOTO_BUCKET = "student-photos"
STUDENT_PHOTO_MAX_BYTES = 5 * 1024 * 1024
STUDENT_PHOTO_SIGNED_URL_SECONDS = 15 * 60
STUDENT_PHOTO_ALLOWED_CONTENT_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}
STUDENT_PHOTO_CONTENT_TYPE_ALIASES = {
    "image/jpg": "image/jpeg",
    "image/jpeg": "image/jpeg",
    "image/png": "image/png",
    "image/webp": "image/webp",
}


class StudentPhotoStore:
    def __init__(self, supabase):
        self.supabase = supabase
        self._columns_available: Optional[bool] = None

    def columns_available(self) -> bool:
        if self._columns_available is not None:
            return self._columns_available
        try:
            (
                self.supabase.table("students")
                .select("id, photo_path, photo_updated_at")
                .limit(1)
                .execute()
            )
            self._columns_available = True
        except PostgrestAPIError as exc:
            if "photo_path" not in (getattr(exc, "message", "") or str(exc)):
                raise
            self._columns_available = False
        return self._columns_available

    def path_for(self, student: dict, extension: str) -> str:
        return f"{student['studio_id']}/students/{student['id']}/profile"

    def find_stored_path(self, student: dict) -> Optional[str]:
        photo_path = self.path_for(student, "webp")
        try:
            objects = self._bucket().list(f"{student['studio_id']}/students/{student['id']}")
        except StorageException:
            return None
        if any((item.get("name") if isinstance(item, dict) else None) == "profile" for item in objects or []):
            return photo_path
        return None

    def create_signed_url(self, photo_path: Optional[str]) -> Optional[str]:
        if not photo_path:
            return None
        try:
            payload = self._bucket().create_signed_url(
                photo_path,
                STUDENT_PHOTO_SIGNED_URL_SECONDS,
            )
        except StorageException:
            return None
        return self._extract_signed_url(payload)

    def create_signed_urls(self, photo_paths: list[str]) -> dict[str, Optional[str]]:
        ordered_paths = [
            path
            for path in dict.fromkeys(photo_paths)
            if path
        ]
        if not ordered_paths:
            return {}

        try:
            signed_payloads = self._bucket().create_signed_urls(
                ordered_paths,
                STUDENT_PHOTO_SIGNED_URL_SECONDS,
            )
        except StorageException:
            return {path: None for path in ordered_paths}

        urls_by_path: dict[str, Optional[str]] = {}
        for index, payload in enumerate(signed_payloads or []):
            path = payload.get("path") or payload.get("name")
            if not path and index < len(ordered_paths):
                path = ordered_paths[index]
            if path:
                urls_by_path[path] = self._extract_signed_url(payload)

        for path in ordered_paths:
            urls_by_path.setdefault(path, None)
        return urls_by_path

    async def read_validated_file(self, file: UploadFile) -> tuple[bytes, str, str]:
        declared_content_type = self._normalize_content_type(file.content_type)
        if declared_content_type not in STUDENT_PHOTO_ALLOWED_CONTENT_TYPES:
            raise HTTPException(
                status_code=400,
                detail="Student photo must be a JPEG, PNG, or WebP image.",
            )

        content = await file.read(STUDENT_PHOTO_MAX_BYTES + 1)
        if not content:
            raise HTTPException(status_code=400, detail="Student photo file is empty.")
        if len(content) > STUDENT_PHOTO_MAX_BYTES:
            raise HTTPException(
                status_code=413,
                detail="Student photo must be 5 MB or smaller.",
            )

        detected_content_type = self._detect_content_type(content)
        if detected_content_type != declared_content_type:
            raise HTTPException(
                status_code=400,
                detail="Student photo content does not match its declared image type.",
            )

        extension = STUDENT_PHOTO_ALLOWED_CONTENT_TYPES[detected_content_type]
        return content, detected_content_type, extension

    def upload(self, photo_path: str, content: bytes, content_type: str) -> None:
        file_options = {
            "content-type": content_type,
            "cache-control": "3600",
            "upsert": "true",
        }
        bucket = self._bucket()
        try:
            bucket.upload(photo_path, content, file_options=file_options)
        except StorageException as exc:
            if not self._is_storage_conflict(exc):
                raise HTTPException(
                    status_code=502,
                    detail="Failed to store student photo.",
                ) from exc
            try:
                bucket.update(photo_path, content, file_options=file_options)
            except StorageException as update_exc:
                raise HTTPException(
                    status_code=502,
                    detail="Failed to replace student photo.",
                ) from update_exc

    def remove(self, photo_paths: list[str], *, raise_on_failure: bool = True) -> None:
        paths = [
            path
            for path in dict.fromkeys(photo_paths)
            if path
        ]
        if not paths:
            return
        try:
            self._bucket().remove(paths)
        except StorageException as exc:
            if self._storage_error_status(exc) == 404:
                return
            if raise_on_failure:
                raise HTTPException(
                    status_code=502,
                    detail="Failed to remove student photo.",
                ) from exc

    def _bucket(self):
        return self.supabase.storage.from_(STUDENT_PHOTO_BUCKET)

    def _storage_error_status(self, exc: StorageException) -> Optional[int]:
        if not exc.args:
            return None
        payload = exc.args[0]
        if not isinstance(payload, dict):
            return None
        status_code = payload.get("statusCode") or payload.get("status_code")
        try:
            return int(status_code)
        except (TypeError, ValueError):
            return None

    def _is_storage_conflict(self, exc: StorageException) -> bool:
        status_code = self._storage_error_status(exc)
        if status_code == 409:
            return True
        payload = exc.args[0] if exc.args else {}
        if not isinstance(payload, dict):
            return False
        message = str(payload.get("message") or payload.get("error") or "").lower()
        return "already exists" in message or "duplicate" in message

    def _extract_signed_url(self, payload: dict) -> Optional[str]:
        return (
            payload.get("signedURL")
            or payload.get("signedUrl")
            or payload.get("signed_url")
            or payload.get("url")
        )

    def _normalize_content_type(self, content_type: Optional[str]) -> Optional[str]:
        if not content_type:
            return None
        return STUDENT_PHOTO_CONTENT_TYPE_ALIASES.get(
            content_type.split(";")[0].strip().lower()
        )

    def _detect_content_type(self, content: bytes) -> Optional[str]:
        if content.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if content.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if (
            len(content) >= 12
            and content[:4] == b"RIFF"
            and content[8:12] == b"WEBP"
        ):
            return "image/webp"
        return None
