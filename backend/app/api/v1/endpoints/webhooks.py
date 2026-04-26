from typing import Optional

from fastapi import APIRouter, Depends, Header, Request
from supabase import Client

from app.core.deps import get_supabase
from app.schemas.billing import WebhookProcessResponse
from app.services.webhook_service import StripeWebhookService

router = APIRouter(prefix="/webhooks/stripe", tags=["stripe-webhooks"])


@router.post("/platform", response_model=WebhookProcessResponse)
async def stripe_platform_webhook(
    request: Request,
    stripe_signature: Optional[str] = Header(None, alias="Stripe-Signature"),
    supabase: Client = Depends(get_supabase),
):
    payload = await request.body()
    return await StripeWebhookService(supabase).handle_platform_webhook(payload, stripe_signature)


@router.post("/connect", response_model=WebhookProcessResponse)
async def stripe_connect_webhook(
    request: Request,
    stripe_signature: Optional[str] = Header(None, alias="Stripe-Signature"),
    supabase: Client = Depends(get_supabase),
):
    payload = await request.body()
    return await StripeWebhookService(supabase).handle_connect_webhook(payload, stripe_signature)
