from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator


BillingRole = Literal["admin", "front_desk"]
SubscriptionStatus = Literal["comped", "trialing", "active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"]
PaymentAccountStatus = Literal["not_connected", "onboarding_incomplete", "charges_enabled", "action_required", "deauthorized"]
BillingPlanStatus = Literal["pending", "active", "archived"]
BillingInterval = Literal["weekly", "biweekly", "monthly", "annual", "paid_in_full", "fixed_term", "trial"]
PayerBillingStatus = Literal["current", "upcoming", "past_due", "failed", "unpaid", "externally_paid", "no_payment_method", "no_billing_plan"]
AutopayStatus = Literal["not_configured", "pending", "enabled", "disabled"]
InvoiceStatus = Literal["draft", "open", "paid", "void", "uncollectible", "refunded", "partially_refunded"]
PaymentStatus = Literal["pending", "processing", "succeeded", "failed", "refunded", "disputed", "externally_recorded"]


class BillingLinkResponse(BaseModel):
    url: str


class BillingActionRequest(BaseModel):
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None
    return_url: Optional[str] = None
    refresh_url: Optional[str] = None


class EmailUsageResponse(BaseModel):
    included: int = 500
    sent: int = 0
    overage_count: int = 0
    overage_rate_cents: float = 0.2
    estimated_overage_cents: int = 0
    period_start: str
    period_end: str


class PlatformBillingStatusResponse(BaseModel):
    studio_id: str
    plan_name: str = "Koaryu Core"
    monthly_price_cents: int = 2700
    currency: str = "usd"
    status: SubscriptionStatus = "comped"
    comped: bool = True
    trial_start: Optional[str] = None
    trial_end: Optional[str] = None
    current_period_start: Optional[str] = None
    current_period_end: Optional[str] = None
    cancel_at_period_end: bool = False
    last_payment_status: Optional[str] = None
    stripe_customer_id: Optional[str] = None
    stripe_subscription_id: Optional[str] = None
    email_usage: EmailUsageResponse


class StudioPaymentAccountResponse(BaseModel):
    studio_id: str
    stripe_connected_account_id: Optional[str] = None
    status: PaymentAccountStatus = "not_connected"
    charges_enabled: bool = False
    payouts_enabled: bool = False
    details_submitted: bool = False
    requirements_due: list[str] = Field(default_factory=list)
    platform_fee_bps: int = 50
    liability_note: str = "Disputes and chargebacks on Connect direct charges remain the studio's liability."
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class BillingPlanProgramResponse(BaseModel):
    program_id: str
    program_name: Optional[str] = None
    program_color_hex: Optional[str] = None


class BillingPlanCreate(BaseModel):
    name: str = Field(min_length=1, max_length=140)
    description: Optional[str] = None
    amount_cents: int = Field(ge=0)
    currency: str = "usd"
    billing_interval: BillingInterval = "monthly"
    program_ids: list[str] = Field(default_factory=list)
    signup_fee_cents: int = Field(default=0, ge=0)
    trial_days: int = Field(default=0, ge=0)
    proration_behavior: str = "next_cycle"
    freeze_behavior: Optional[str] = None
    cancellation_policy: Optional[str] = None
    tax_behavior: Optional[str] = None

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: str) -> str:
        return value.strip().lower() or "usd"


class BillingPlanUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=140)
    description: Optional[str] = None
    amount_cents: Optional[int] = Field(default=None, ge=0)
    currency: Optional[str] = None
    billing_interval: Optional[BillingInterval] = None
    program_ids: Optional[list[str]] = None
    signup_fee_cents: Optional[int] = Field(default=None, ge=0)
    trial_days: Optional[int] = Field(default=None, ge=0)
    proration_behavior: Optional[str] = None
    freeze_behavior: Optional[str] = None
    cancellation_policy: Optional[str] = None
    tax_behavior: Optional[str] = None

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: Optional[str]) -> Optional[str]:
        return value.strip().lower() if value else value


class BillingPlanResponse(BaseModel):
    id: str
    studio_id: str
    name: str
    description: Optional[str] = None
    amount_cents: int
    currency: str = "usd"
    billing_interval: BillingInterval = "monthly"
    status: BillingPlanStatus = "pending"
    signup_fee_cents: int = 0
    trial_days: int = 0
    proration_behavior: str = "next_cycle"
    freeze_behavior: Optional[str] = None
    cancellation_policy: Optional[str] = None
    tax_behavior: Optional[str] = None
    stripe_product_id: Optional[str] = None
    stripe_price_id: Optional[str] = None
    programs: list[BillingPlanProgramResponse] = Field(default_factory=list)
    can_accept_payments: bool = False
    pending_reason: Optional[str] = None
    archived_at: Optional[str] = None
    created_at: str
    updated_at: str


class BillingPayerCreate(BaseModel):
    display_name: str = Field(min_length=1, max_length=160)
    guardian_id: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address_line1: Optional[str] = None
    address_city: Optional[str] = None
    address_state: Optional[str] = None
    address_zip: Optional[str] = None


class BillingPayerUpdate(BaseModel):
    display_name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    guardian_id: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address_line1: Optional[str] = None
    address_city: Optional[str] = None
    address_state: Optional[str] = None
    address_zip: Optional[str] = None
    autopay_status: Optional[AutopayStatus] = None
    billing_status: Optional[PayerBillingStatus] = None


class BillingPayerResponse(BaseModel):
    id: str
    studio_id: str
    guardian_id: Optional[str] = None
    display_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    address_line1: Optional[str] = None
    address_city: Optional[str] = None
    address_state: Optional[str] = None
    address_zip: Optional[str] = None
    stripe_customer_id: Optional[str] = None
    autopay_status: AutopayStatus = "not_configured"
    billing_status: PayerBillingStatus = "no_payment_method"
    balance_cents: int = 0
    created_at: str
    updated_at: str


class StudentBillingEnrollmentCreate(BaseModel):
    student_id: Optional[str] = None
    billing_plan_id: str
    payer_id: Optional[str] = None
    start_date: Optional[str] = None
    next_bill_on: Optional[str] = None


class StudentBillingEnrollmentResponse(BaseModel):
    id: str
    studio_id: str
    student_id: str
    payer_id: Optional[str] = None
    billing_plan_id: str
    status: str
    billing_status: PayerBillingStatus
    start_date: str
    end_date: Optional[str] = None
    next_bill_on: Optional[str] = None
    stripe_subscription_id: Optional[str] = None
    created_at: str
    updated_at: str


class BillingInvoiceResponse(BaseModel):
    id: str
    studio_id: str
    payer_id: Optional[str] = None
    student_id: Optional[str] = None
    enrollment_id: Optional[str] = None
    stripe_invoice_id: Optional[str] = None
    stripe_account_id: Optional[str] = None
    invoice_type: str = "manual"
    status: InvoiceStatus = "draft"
    amount_due_cents: int = 0
    amount_paid_cents: int = 0
    currency: str = "usd"
    hosted_invoice_url: Optional[str] = None
    due_date: Optional[str] = None
    paid_at: Optional[str] = None
    external: bool = False
    created_at: str
    updated_at: str


class BillingPaymentResponse(BaseModel):
    id: str
    studio_id: str
    payer_id: Optional[str] = None
    invoice_id: Optional[str] = None
    status: PaymentStatus
    amount_cents: int
    currency: str = "usd"
    payment_method_type: Optional[str] = None
    external_method: Optional[str] = None
    note: Optional[str] = None
    processed_at: Optional[str] = None
    created_at: str
    updated_at: str


class ExternalPaymentCreate(BaseModel):
    amount_cents: int = Field(ge=0)
    currency: str = "usd"
    payer_id: Optional[str] = None
    invoice_id: Optional[str] = None
    external_method: str = Field(min_length=1, max_length=80)
    note: Optional[str] = None


class ExportJobCreate(BaseModel):
    export_type: str = Field(min_length=1, max_length=80)
    filters: dict[str, Any] = Field(default_factory=dict)


class ExportJobResponse(BaseModel):
    id: str
    studio_id: str
    export_type: str
    status: str
    requested_by: Optional[str] = None
    download_url: Optional[str] = None
    error: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    updated_at: str
    completed_at: Optional[str] = None


class WebhookProcessResponse(BaseModel):
    received: bool = True
    status: str
