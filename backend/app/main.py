from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import get_settings
from app.api.v1.router import router as v1_router

settings = get_settings()
settings.validate_production_configuration()
allowed_origins = {settings.FRONTEND_URL}

if settings.FRONTEND_URL.startswith("http://localhost:"):
    allowed_origins.add(
        settings.FRONTEND_URL.replace("http://localhost:", "http://127.0.0.1:")
    )
elif settings.FRONTEND_URL.startswith("http://127.0.0.1:"):
    allowed_origins.add(
        settings.FRONTEND_URL.replace("http://127.0.0.1:", "http://localhost:")
    )

app = FastAPI(
    title="Koaryu API",
    description="Backend API for Koaryu — Martial Arts Studio OS",
    version="1.0.0",
    docs_url="/docs" if settings.ENVIRONMENT == "development" else None,
    redoc_url="/redoc" if settings.ENVIRONMENT == "development" else None,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Server-Timing", "Cache-Control", "Vary", "Content-Disposition"],
)

# Include API v1 routes
app.include_router(v1_router, prefix=settings.API_V1_PREFIX)


@app.get("/")
async def root():
    return {"name": "Koaryu API", "version": "1.0.0"}


@app.api_route("/health", methods=["GET", "HEAD"])
async def root_health():
    return {"status": "ok", "version": "1.0.0", "service": "koaryu-api"}
