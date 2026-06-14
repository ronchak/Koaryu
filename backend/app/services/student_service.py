from typing import Any, Optional
from supabase import Client
from fastapi import UploadFile
from app.schemas.student import (
    StudentCreate, StudentUpdate, StudentResponse, StudentListResponse,
    GuardianResponse,
    CsvImportOptions, CsvImportResult,
    BulkTagUpdate, BulkStatusUpdate,
    StudentListSortDir, StudentListSortKey, StudentStatus,
    StudentProgramMembershipCreate, StudentProgramMembershipResponse, StudentProgramMembershipUpdate,
)
from app.services.student_bulk_actions import StudentBulkActions
from app.services.student_crud_actions import StudentCrudActions
from app.services.student_import_csv import (
    auto_map_csv_header,
    parse_student_csv,
)
from app.services.student_import_executor import StudentImportExecutor
from app.services.student_import_planner import StudentImportPlanner
from app.services.student_list_query import StudentListQuery
from app.services.student_membership_actions import StudentMembershipActions
from app.services.student_photo_actions import StudentPhotoActions
from app.services.student_photo_store import StudentPhotoStore
from app.services.student_program_memberships import StudentProgramMembershipStore
from app.services.student_response_builder import PHOTO_URL_UNSET, StudentResponseBuilder
from app.services.student_write_payload import (
    prepare_student_write_payload,
)


class StudentService:
    def __init__(self, supabase: Client):
        self.supabase = supabase
        self._student_photo_store = StudentPhotoStore(supabase)
        self._student_response_builder = StudentResponseBuilder(supabase, self._student_photo_store)

    def _program_memberships(self) -> StudentProgramMembershipStore:
        return StudentProgramMembershipStore(self.supabase)

    def _import_planner(self) -> StudentImportPlanner:
        return StudentImportPlanner(self.supabase)

    def _student_photos(self) -> StudentPhotoStore:
        self._student_photo_store.supabase = self.supabase
        return self._student_photo_store

    def _student_responses(self) -> StudentResponseBuilder:
        self._student_response_builder.supabase = self.supabase
        self._student_response_builder.photo_store = self._student_photos()
        return self._student_response_builder

    def _student_photo_actions(self) -> StudentPhotoActions:
        return StudentPhotoActions(
            self.supabase,
            self._student_photos(),
            self._student_responses(),
        )

    def _bulk_actions(self) -> StudentBulkActions:
        return StudentBulkActions(self.supabase)

    def _membership_actions(self) -> StudentMembershipActions:
        return StudentMembershipActions(
            self.supabase,
            self._program_memberships(),
            self._student_responses(),
        )

    def _import_executor(self) -> StudentImportExecutor:
        return StudentImportExecutor(self.supabase)

    def _crud_actions(self) -> StudentCrudActions:
        return StudentCrudActions(
            supabase=self.supabase,
            membership_store=self._program_memberships(),
            prepare_student_write=self._prepare_student_write,
            row_to_response=self.row_to_response,
            fetch_memberships_for_student=self._fetch_memberships_for_student,
        )

    # ---- Helpers ----

    def _prepare_student_write(self, payload: dict, *, set_default_is_minor: bool) -> dict:
        return prepare_student_write_payload(payload, set_default_is_minor=set_default_is_minor)

    def _fetch_memberships_for_student(
        self,
        student_id: str,
        studio_id: Optional[str] = None,
    ) -> list[StudentProgramMembershipResponse]:
        return self._student_responses().fetch_memberships_for_student(student_id, studio_id)

    def rows_to_responses(
        self,
        rows: list[dict],
        *,
        include_guardians: bool = True,
        include_photo_urls: bool = True,
    ) -> list[StudentResponse]:
        return self._student_responses().rows_to_responses(
            rows,
            include_guardians=include_guardians,
            include_photo_urls=include_photo_urls,
        )

    def row_to_response(
        self,
        row: dict,
        guardians: Optional[list[GuardianResponse]] = None,
        memberships: Optional[list[StudentProgramMembershipResponse]] = None,
        photo_url: Any = PHOTO_URL_UNSET,
    ) -> StudentResponse:
        return self._student_responses().row_to_response(
            row,
            guardians=guardians,
            memberships=memberships,
            photo_url=photo_url,
        )

    # ---- CRUD ----

    async def list_students(
        self,
        studio_id: str,
        search: Optional[str] = None,
        status_filter: Optional[StudentStatus] = None,
        program_id: Optional[str] = None,
        page: int = 1,
        page_size: int = 50,
        sort_by: StudentListSortKey = "name",
        sort_dir: StudentListSortDir = "asc",
    ) -> StudentListResponse:
        rows, total = StudentListQuery(self.supabase).fetch_page(
            studio_id,
            search=search,
            status_filter=status_filter,
            program_id=program_id,
            page=page,
            page_size=page_size,
            sort_by=sort_by,
            sort_dir=sort_dir,
        )
        return StudentListResponse(
            items=self.rows_to_responses(rows),
            total=total,
            page=page,
            page_size=page_size,
        )

    async def create_student(
        self, data: StudentCreate, studio_id: str, actor_id: str
    ) -> StudentResponse:
        return await self._crud_actions().create_student(data, studio_id, actor_id)

    async def get_student(self, student_id: str, studio_id: str) -> StudentResponse:
        return await self._crud_actions().get_student(student_id, studio_id)

    async def update_student(
        self, student_id: str, data: StudentUpdate, studio_id: str, actor_id: str
    ) -> StudentResponse:
        return await self._crud_actions().update_student(student_id, data, studio_id, actor_id)

    async def upload_student_photo(
        self,
        student_id: str,
        studio_id: str,
        actor_id: str,
        file: UploadFile,
    ) -> StudentResponse:
        return await self._student_photo_actions().upload(student_id, studio_id, actor_id, file)

    async def delete_student_photo(
        self,
        student_id: str,
        studio_id: str,
        actor_id: str,
    ) -> StudentResponse:
        return await self._student_photo_actions().delete(student_id, studio_id, actor_id)

    async def soft_delete_student(
        self, student_id: str, studio_id: str, actor_id: str
    ) -> None:
        await self._crud_actions().soft_delete_student(student_id, studio_id, actor_id)

    async def list_program_memberships(
        self,
        student_id: str,
        studio_id: str,
    ) -> list[StudentProgramMembershipResponse]:
        return await self._membership_actions().list(student_id, studio_id)

    async def add_program_membership(
        self,
        student_id: str,
        data: StudentProgramMembershipCreate,
        studio_id: str,
        actor_id: str,
    ) -> StudentProgramMembershipResponse:
        return await self._membership_actions().add(student_id, data, studio_id, actor_id)

    async def update_program_membership(
        self,
        student_id: str,
        membership_id: str,
        data: StudentProgramMembershipUpdate,
        studio_id: str,
        actor_id: str,
    ) -> StudentProgramMembershipResponse:
        return await self._membership_actions().update(student_id, membership_id, data, studio_id, actor_id)

    async def remove_program_membership(
        self,
        student_id: str,
        membership_id: str,
        studio_id: str,
        actor_id: str,
    ) -> None:
        await self._membership_actions().remove(student_id, membership_id, studio_id, actor_id)

    # ---- Bulk Actions ----

    async def bulk_update_tags(
        self, data: BulkTagUpdate, studio_id: str, actor_id: str
    ) -> int:
        return await self._bulk_actions().update_tags(data, studio_id, actor_id)

    async def bulk_update_status(
        self, data: BulkStatusUpdate, studio_id: str, actor_id: str
    ) -> int:
        return await self._bulk_actions().update_status(data, studio_id, actor_id)

    # ---- CSV Import ----

    def parse_csv(self, content: bytes) -> tuple[list[str], list[dict]]:
        """Parse raw CSV bytes. Returns (headers, rows)."""
        return parse_student_csv(content)

    def auto_map_headers(self, headers: list[str]) -> dict[str, str]:
        """Return a dict mapping CSV header → Koaryu field name using known aliases."""
        mapping: dict[str, str] = {}
        for h in headers:
            mapping[h] = auto_map_csv_header(h)
        return mapping

    def validate_import_rows(
        self,
        rows: list[dict],
        mapping: dict[str, str],
        options: Optional[CsvImportOptions] = None,
        studio_id: Optional[str] = None,
    ) -> CsvImportResult:
        """Validate rows against the mapping. Returns a structured result."""
        effective_options = options or CsvImportOptions()
        result, _ = self._import_planner().prepare_import(rows, mapping, studio_id, effective_options)
        return result

    async def execute_import(
        self,
        rows: list[dict],
        mapping: dict[str, str],
        options: Optional[CsvImportOptions],
        studio_id: str,
        actor_id: str,
        idempotency_key: Optional[str] = None,
    ) -> CsvImportResult:
        """Execute the import for all valid rows."""
        return await self._import_executor().execute_import(
            rows,
            mapping,
            options,
            studio_id,
            actor_id,
            idempotency_key=idempotency_key,
        )
