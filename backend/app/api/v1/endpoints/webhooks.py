from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from supabase import Client

from app.core.deps import get_supabase
from app.core.request_body_limits import STRIPE_WEBHOOK_REQUEST_MAX_BYTES
from app.schemas.billing import WebhookProcessResponse
from app.services.webhook_service import StripeWebhookService

router = APIRouter(prefix="/webhooks/stripe", tags=["stripe-webhooks"])

async def read_stripe_webhook_payload(request: Request) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_bytes = int(content_length)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header.") from exc
        if declared_bytes < 0:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header.")
        if declared_bytes > STRIPE_WEBHOOK_REQUEST_MAX_BYTES:
            raise HTTPException(status_code=413, detail="Webhook payload is too large.")

    payload = bytearray()
    async for chunk in request.stream():
        if len(payload) + len(chunk) > STRIPE_WEBHOOK_REQUEST_MAX_BYTES:
            raise HTTPException(status_code=413, detail="Webhook payload is too large.")
        payload.extend(chunk)
    return bytes(payload)


@router.post("/platform", response_model=WebhookProcessResponse)
async def stripe_platform_webhook(
    request: Request,
    stripe_signature: Optional[str] = Header(None, alias="Stripe-Signature"),
    supabase: Client = Depends(get_supabase),
):
    payload = await read_stripe_webhook_payload(request)
    return await StripeWebhookService(supabase).handle_platform_webhook(payload, stripe_signature)


@router.post("/connect", response_model=WebhookProcessResponse)
async def stripe_connect_webhook(
    request: Request,
    stripe_signature: Optional[str] = Header(None, alias="Stripe-Signature"),
    supabase: Client = Depends(get_supabase),
):
    payload = await read_stripe_webhook_payload(request)
    return await StripeWebhookService(supabase).handle_connect_webhook(payload, stripe_signature)
