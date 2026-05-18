from fastapi import APIRouter

router = APIRouter()


@router.api_route("/health", methods=["GET", "HEAD"])
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "version": "1.0.0", "service": "koaryu-api"}
