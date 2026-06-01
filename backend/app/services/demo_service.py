from typing import Callable, Optional, TypeVar

from supabase import Client

from app.schemas.demo import DemoResetCounts, DemoResetResponse, StudioDataClearResponse
from app.services.demo_billing_seed import DemoBillingSeeder
from app.services.demo_data_access import DemoDataAccess
from app.services.demo_lead_seed import DemoLeadSeeder
from app.services.demo_program_belt_seed import DemoProgramBeltSeeder
from app.services.demo_reset_response_builder import DemoResetResponseBuilder
from app.services.demo_schedule_seed import DemoScheduleSeeder
from app.services.demo_student_seed import DemoStudentSeeder


T = TypeVar("T")


class DemoResetPhaseError(RuntimeError):
    def __init__(self, phase: str):
        super().__init__(f"Demo reset failed during {phase}.")
        self.phase = phase


class DemoService:
    def __init__(self, supabase: Client):
        self.supabase = supabase
        self.data_access = DemoDataAccess(supabase)

    def _id(self, studio_id: str, key: str) -> str:
        return self.data_access.id_for(studio_id, key)

    def _today(self):
        return self.data_access.today()

    def _date(self, days_from_today: int) -> str:
        return self.data_access.date_for(days_from_today)

    def _timestamp(self, days_from_today: int = 0, hour: int = 9, minute: int = 0) -> str:
        return self.data_access.timestamp_for(days_from_today, hour, minute)

    def _weekday(self, days_from_today: int = 0) -> int:
        return self.data_access.weekday_for(days_from_today)

    def _insert(self, table: str, rows: list[dict]) -> None:
        self.data_access.insert(table, rows)

    def _insert_optional(self, table: str, rows: list[dict]) -> None:
        self.data_access.insert_optional(table, rows)

    def _clear_counts(self, studio_id: str) -> DemoResetCounts:
        return self.data_access.clear_counts(studio_id)

    def _studio_name(self, studio_id: str) -> str:
        return self.data_access.studio_name(studio_id)

    def _clear_demo_surface(self, studio_id: str) -> None:
        self.data_access.clear_demo_surface(studio_id)

    def _clear_studio_surface(self, studio_id: str, *, include_platform_rows: bool) -> None:
        self.data_access.clear_studio_surface(studio_id, include_platform_rows=include_platform_rows)

    async def clear_studio_data(self, studio_id: str) -> StudioDataClearResponse:
        counts = self._clear_counts(studio_id)
        studio_name = self._studio_name(studio_id)
        self._clear_studio_surface(studio_id, include_platform_rows=False)
        return StudioDataClearResponse(studio_name=studio_name, counts=counts)

    def _program_belt_seeder(self) -> DemoProgramBeltSeeder:
        return DemoProgramBeltSeeder(
            id_for=self._id,
            timestamp_for=self._timestamp,
            insert=self._insert,
        )

    def _seed_programs(self, studio_id: str) -> dict[str, str]:
        return self._program_belt_seeder().seed_programs(studio_id)

    def _seed_belts(self, studio_id: str, program_ids: dict[str, str]) -> dict[str, str]:
        return self._program_belt_seeder().seed_belts(studio_id, program_ids)

    def _seed_students(
        self,
        studio_id: str,
        program_ids: dict[str, str],
        rank_ids: dict[str, str],
    ) -> dict[str, str]:
        return DemoStudentSeeder(
            id_for=self._id,
            date_for=self._date,
            timestamp_for=self._timestamp,
            insert=self._insert,
            insert_optional=self._insert_optional,
        ).seed_students(studio_id, program_ids, rank_ids)

    def _seed_promotions(
        self,
        studio_id: str,
        actor_id: str,
        program_ids: dict[str, str],
        student_ids: dict[str, str],
        rank_ids: dict[str, str],
    ) -> None:
        self._program_belt_seeder().seed_promotions(
            studio_id,
            actor_id,
            program_ids,
            student_ids,
            rank_ids,
        )

    def _seed_schedule(
        self,
        studio_id: str,
        program_ids: dict[str, str],
        student_ids: dict[str, str],
    ) -> None:
        DemoScheduleSeeder(
            id_for=self._id,
            date_for=self._date,
            timestamp_for=self._timestamp,
            weekday_for=self._weekday,
            insert=self._insert,
        ).seed_schedule(studio_id, program_ids, student_ids)

    def _seed_leads(self, studio_id: str, actor_id: str, student_ids: dict[str, str]) -> None:
        DemoLeadSeeder(
            id_for=self._id,
            date_for=self._date,
            timestamp_for=self._timestamp,
            insert=self._insert,
        ).seed_leads(studio_id, actor_id, student_ids)

    def _seed_billing(
        self,
        studio_id: str,
        program_ids: dict[str, str],
        student_ids: dict[str, str],
    ) -> None:
        DemoBillingSeeder(self.supabase).seed(studio_id, program_ids, student_ids)

    def _write_audit_log(self, studio_id: str, actor_id: str) -> None:
        self.data_access.write_reset_audit(studio_id, actor_id)

    def _write_reset_failure_audit(
        self,
        studio_id: str,
        actor_id: str,
        *,
        phase: str,
        error: Exception,
        cleanup_succeeded: bool,
        cleanup_error: Optional[Exception] = None,
    ) -> None:
        self.data_access.write_reset_failure_audit(
            studio_id,
            actor_id,
            phase=phase,
            error=error,
            cleanup_succeeded=cleanup_succeeded,
            cleanup_error=cleanup_error,
        )

    def _run_demo_reset_phase(self, phase: str, action: Callable[[], T]) -> T:
        try:
            return action()
        except Exception as exc:
            raise DemoResetPhaseError(phase) from exc

    def _update_studio_for_demo(self, studio_id: str) -> None:
        self.data_access.update_studio_for_demo(studio_id)

    def _seed_demo_surface(self, studio_id: str, actor_id: str) -> None:
        program_ids = self._run_demo_reset_phase(
            "seed_programs",
            lambda: self._seed_programs(studio_id),
        )
        rank_ids = self._run_demo_reset_phase(
            "seed_belts",
            lambda: self._seed_belts(studio_id, program_ids),
        )
        student_ids = self._run_demo_reset_phase(
            "seed_students",
            lambda: self._seed_students(studio_id, program_ids, rank_ids),
        )
        self._run_demo_reset_phase(
            "seed_promotions",
            lambda: self._seed_promotions(studio_id, actor_id, program_ids, student_ids, rank_ids),
        )
        self._run_demo_reset_phase(
            "seed_schedule",
            lambda: self._seed_schedule(studio_id, program_ids, student_ids),
        )
        self._run_demo_reset_phase(
            "seed_leads",
            lambda: self._seed_leads(studio_id, actor_id, student_ids),
        )
        self._run_demo_reset_phase(
            "seed_billing",
            lambda: self._seed_billing(studio_id, program_ids, student_ids),
        )

    def _handle_failed_demo_reset(
        self,
        studio_id: str,
        actor_id: str,
        phase: str,
        error: Exception,
    ) -> None:
        cleanup_succeeded = False
        cleanup_error = None
        if phase.startswith("seed_"):
            try:
                self._clear_demo_surface(studio_id)
                cleanup_succeeded = True
            except Exception as exc:
                cleanup_error = exc
        try:
            self._write_reset_failure_audit(
                studio_id,
                actor_id,
                phase=phase,
                error=error,
                cleanup_succeeded=cleanup_succeeded,
                cleanup_error=cleanup_error,
            )
        except Exception:
            pass

    async def reset_demo_studio(self, studio_id: str, actor_id: str) -> DemoResetResponse:
        try:
            self._run_demo_reset_phase("clear_existing_data", lambda: self._clear_demo_surface(studio_id))
            self._run_demo_reset_phase("update_studio", lambda: self._update_studio_for_demo(studio_id))
            self._seed_demo_surface(studio_id, actor_id)
            self._run_demo_reset_phase("write_audit_log", lambda: self._write_audit_log(studio_id, actor_id))
        except DemoResetPhaseError as exc:
            original_error = exc.__cause__ or exc
            self._handle_failed_demo_reset(studio_id, actor_id, exc.phase, original_error)
            if original_error is exc:
                raise
            raise original_error from exc

        return await self._build_reset_response(studio_id)

    async def _build_reset_response(self, studio_id: str) -> DemoResetResponse:
        return await DemoResetResponseBuilder(self.supabase, self._date).build(studio_id)
