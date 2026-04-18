from fastapi import APIRouter
from app.api.v1.endpoints import health, auth, studios, students, schedule, belts, leads

router = APIRouter()

router.include_router(health.router)
router.include_router(auth.router)
router.include_router(studios.router)
router.include_router(students.router)
router.include_router(schedule.router)
router.include_router(belts.router)
router.include_router(leads.router)

