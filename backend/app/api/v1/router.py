from fastapi import APIRouter
from app.api.v1.endpoints import (
    auth,
    belts,
    dashboard,
    demo,
    health,
    leads,
    programs,
    schedule,
    staff,
    students,
    studios,
)

router = APIRouter()

router.include_router(health.router)
router.include_router(auth.router)
router.include_router(dashboard.router)
router.include_router(demo.router)
router.include_router(studios.router)
router.include_router(students.router)
router.include_router(programs.router)
router.include_router(schedule.router)
router.include_router(belts.router)
router.include_router(leads.router)
router.include_router(staff.router)
