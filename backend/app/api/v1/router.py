from fastapi import APIRouter
from app.api.v1.endpoints import (
    auth,
    belts,
    billing,
    dashboard,
    demo,
    health,
    leads,
    platform_billing,
    programs,
    reports,
    schedule,
    staff,
    students,
    studios,
    webhooks,
)

router = APIRouter()

router.include_router(health.router)
router.include_router(auth.router)
router.include_router(dashboard.router)
router.include_router(demo.router)
router.include_router(platform_billing.router)
router.include_router(billing.router)
router.include_router(webhooks.router)
router.include_router(studios.router)
router.include_router(students.router)
router.include_router(programs.router)
router.include_router(reports.router)
router.include_router(schedule.router)
router.include_router(belts.router)
router.include_router(leads.router)
router.include_router(staff.router)
