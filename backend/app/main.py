from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import get_settings
from app.core.error_handlers import register_error_handlers
from app.core.request_body_limits import RequestBodyLimitMiddleware
from app.api.v1.endpoints.health import health_live, health_ready
from app.api.v1.router import router as v1_router

settings = get_settings()
settings.validate_runtime_configuration()
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

register_error_handlers(app, cors_allowed_origins=allowed_origins)

# Bound upload and webhook bodies before Starlette parses multipart forms.
app.add_middleware(
    RequestBodyLimitMiddleware,
    api_v1_prefix=settings.API_V1_PREFIX,
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


@app.api_route("/health", methods=["GET", "HEAD"], include_in_schema=False)
@app.api_route("/health/live", methods=["GET", "HEAD"], include_in_schema=False)
async def root_health_live(response: Response):
    return await health_live(response)


@app.api_route("/health/ready", methods=["GET", "HEAD"], include_in_schema=False)
async def root_health_ready(response: Response):
    return await health_ready(response)
