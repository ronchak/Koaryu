import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import get_settings
from app.core.error_handlers import register_error_handlers
from app.core.provider_runtime import SupabaseLaneConfig, SupabaseProviderRuntime
from app.core.request_body_limits import RequestBodyLimitMiddleware
from app.api.v1.endpoints.health import health_live, health_ready
from app.api.v1.router import router as v1_router

settings = get_settings()
settings.validate_runtime_configuration()
frontend_origin = settings.validated_frontend_origin()
allowed_origins = {frontend_origin}

if frontend_origin.startswith("http://localhost:"):
    allowed_origins.add(
        frontend_origin.replace("http://localhost:", "http://127.0.0.1:")
    )
elif frontend_origin.startswith("http://127.0.0.1:"):
    allowed_origins.add(
        frontend_origin.replace("http://127.0.0.1:", "http://localhost:")
    )


INTERACTIVE_PROVIDER_CONFIG = SupabaseLaneConfig(
    max_workers=4,
    max_queue=16,
    queue_wait_timeout=0.25,
    operation_wait_timeout=30.0,
    postgrest_client_timeout=10.0,
)
BULK_PROVIDER_CONFIG = SupabaseLaneConfig(
    max_workers=1,
    max_queue=2,
    queue_wait_timeout=0.25,
    operation_wait_timeout=120.0,
    postgrest_client_timeout=30.0,
)


@asynccontextmanager
async def _lifespan(application: FastAPI):
    runtime = SupabaseProviderRuntime(
        INTERACTIVE_PROVIDER_CONFIG,
        BULK_PROVIDER_CONFIG,
    )
    application.state.supabase_provider_runtime = runtime
    try:
        yield
    finally:
        # ThreadPoolExecutor.shutdown waits for provider work and cleanup;
        # keep that blocking lifecycle operation off the ASGI event loop.
        await asyncio.to_thread(runtime.shutdown)


# The schema still builds in process for type generation and contract tests, but
# serving it over HTTP publishes the whole route map — internal paths, auth model,
# and header names included — so keep the route itself development-only.
_schema_routes_enabled = settings.ENVIRONMENT == "development"

app = FastAPI(
    title="Koaryu API",
    description="Backend API for Koaryu — Martial Arts Studio OS",
    version="1.0.0",
    openapi_url="/openapi.json" if _schema_routes_enabled else None,
    docs_url="/docs" if _schema_routes_enabled else None,
    redoc_url="/redoc" if _schema_routes_enabled else None,
    lifespan=_lifespan,
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
