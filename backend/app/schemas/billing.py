from typing import Any, Literal, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator


BillingRole = Literal["admin", "front_desk"]
SubscriptionStatus = Literal["comped", "trialing", "active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"]
PaymentAccountStatus = Literal["not_connected", "onboarding_incomplete", "charges_enabled", "action_required", "deauthorized"]
ConnectBusinessEntityType = Literal["company", "individual"]
BillingPlanStatus = Literal["pending", "active", "archived"]
BillingInterval = Literal["weekly", "biweekly", "monthly", "annual", "paid_in_full", "fixed_term", "trial"]
BillingCollectionMode = Literal["autopay", "invoice_link", "external"]
BillingEnrollmentStatus = Literal["pending", "active", "paused", "ended", "canceled"]
BillingSubscriptionStatus = Literal["pending", "trialing", "active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"]
PayerBillingStatus = Literal["current", "upcoming", "past_due", "failed", "unpaid", "externally_paid", "no_payment_method", "no_billing_plan"]
AutopayStatus = Literal["not_configured", "pending", "enabled", "disabled"]
InvoiceStatus = Literal["draft", "open", "paid", "void", "uncollectible", "refunded", "partially_refunded"]
PaymentStatus = Literal["pending", "processing", "succeeded", "failed", "refunded", "disputed", "externally_recorded"]
BillingSystemCheckStatus = Literal["pass", "warn", "fail"]
BillingReconcileObjectType = Literal["connect_account", "payer", "invoice", "subscription", "payment_intent"]
CARD_BRAND_VALUES = {
    "amex",
    "cartes_bancaires",
    "diners",
    "discover",
    "eftpos_au",
    "jcb",
    "mastercard",
    "unionpay",
    "visa",
}
LEGACY_EXTERNAL_STRIPE_SYNC_ERROR_PREFIX = "External payment recorded locally but Stripe sync failed:"
EXTERNAL_STRIPE_SYNC_ERROR_PUBLIC_MESSAGE = (
    "Stripe sync failed after local payment recording. Contact support if it persists."
)


def _frontend_payment_method_type(value: dict[str, Any]) -> Optional[str]:
    if not value.get("default_payment_method_id"):
        return None

    explicit_type = value.get("default_payment_method_type") or value.get("stripe_payment_method_type")
    if explicit_type:
        return str(explicit_type)

    brand = value.get("default_payment_method_brand")
    normalized_brand = str(brand).lower() if brand else None
    if (
        value.get("default_payment_method_last4")
        or value.get("default_payment_method_exp_month")
        or value.get("default_payment_method_exp_year")
        or normalized_brand in CARD_BRAND_VALUES
    ):
        return "card"

    return str(brand) if brand else None


class BillingLinkResponse(BaseModel):
    url: str


class ConnectOnboardingLinkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    return_url: Optional[str] = None
    refresh_url: Optional[str] = None
    business_entity_type: Optional[ConnectBusinessEntityType] = None


class PlatformCheckoutRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


class PlatformPortalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    return_url: Optional[str] = None


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


class BillingSystemCheck(BaseModel):
    name: str
    status: BillingSystemCheckStatus
    detail: str


class BillingWebhookHealthResponse(BaseModel):
    stripe_account_id: Optional[str] = None
    latest_processed_at: Optional[str] = None
    latest_event_type: Optional[str] = None
    pending_count: int = 0
    processing_count: int = 0
    failed_count: int = 0
    stale_processing_count: int = 0
    mode_mismatch_count: int = 0
    error_reference: Optional[str] = None


class BillingSystemStatusResponse(BaseModel):
    studio_id: str
    configured_stripe_mode: Optional[Literal["test", "live"]] = None
    ready_for_configured_mode: bool
    live_payments_authorized: bool
    ready_for_live_payments: bool
    checked_at: str
    payment_account: StudioPaymentAccountResponse
    platform_webhooks: BillingWebhookHealthResponse
    connect_webhooks: BillingWebhookHealthResponse
    checks: list[BillingSystemCheck]


class BillingReconcileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    object_type: BillingReconcileObjectType
    stripe_object_id: Optional[str] = None
    payer_id: Optional[str] = None


class BillingReconcileResponse(BaseModel):
    object_type: BillingReconcileObjectType
    stripe_object_id: Optional[str] = None
    local_object_id: Optional[str] = None
    status: str
    detail: str


class BillingPlanProgramResponse(BaseModel):
    program_id: str
    program_name: Optional[str] = None
    program_color_hex: Optional[str] = None


class BillingPlanCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

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
    model_config = ConfigDict(extra="forbid")

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
    model_config = ConfigDict(extra="forbid")

    display_name: str = Field(min_length=1, max_length=160)
    guardian_id: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(default=None, max_length=40)
    address_line1: Optional[str] = Field(default=None, max_length=200)
    address_city: Optional[str] = Field(default=None, max_length=120)
    address_state: Optional[str] = Field(default=None, max_length=80)
    address_zip: Optional[str] = Field(default=None, max_length=20)


class BillingPayerUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    guardian_id: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(default=None, max_length=40)
    address_line1: Optional[str] = Field(default=None, max_length=200)
    address_city: Optional[str] = Field(default=None, max_length=120)
    address_state: Optional[str] = Field(default=None, max_length=80)
    address_zip: Optional[str] = Field(default=None, max_length=20)


class BillingPayerResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

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
    stripe_account_id: Optional[str] = None
    stripe_customer_id: Optional[str] = None
    default_payment_method_id: Optional[str] = None
    default_payment_method_brand: Optional[str] = None
    default_payment_method_last4: Optional[str] = None
    default_payment_method_exp_month: Optional[int] = None
    default_payment_method_exp_year: Optional[int] = None
    stripe_payment_method_id: Optional[str] = None
    stripe_payment_method_type: Optional[str] = None
    stripe_payment_method_brand: Optional[str] = None
    stripe_payment_method_last4: Optional[str] = None
    autopay_status: AutopayStatus = "not_configured"
    autopay_authorized_at: Optional[str] = None
    autopay_disabled_at: Optional[str] = None
    autopay_terms_accepted_at: Optional[str] = None
    billing_status: PayerBillingStatus = "no_payment_method"
    balance_cents: int = 0
    created_at: str
    updated_at: str

    @model_validator(mode="before")
    @classmethod
    def add_frontend_payment_method_aliases(cls, value: Any) -> Any:
        if isinstance(value, dict):
            value = dict(value)
            value.setdefault("stripe_payment_method_id", value.get("default_payment_method_id"))
            value.setdefault("stripe_payment_method_brand", value.get("default_payment_method_brand"))
            value.setdefault("stripe_payment_method_last4", value.get("default_payment_method_last4"))
            value.setdefault("stripe_payment_method_type", _frontend_payment_method_type(value))
        return value


class BillingPayerAutopaySetupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    success_url: Optional[str] = None
    cancel_url: Optional[str] = None
    return_url: Optional[str] = None
    terms_accepted: bool = False


class BillingSubscriptionResponse(BaseModel):
    id: str
    studio_id: str
    payer_id: str
    stripe_account_id: Optional[str] = None
    stripe_customer_id: Optional[str] = None
    stripe_subscription_id: Optional[str] = None
    collection_mode: BillingCollectionMode = "invoice_link"
    billing_interval: BillingInterval = "monthly"
    currency: str = "usd"
    status: BillingSubscriptionStatus = "pending"
    current_period_start: Optional[str] = None
    current_period_end: Optional[str] = None
    next_bill_date: Optional[str] = None
    cancel_at_period_end: bool = False
    default_payment_method_id: Optional[str] = None
    application_fee_percent: Optional[float] = None
    created_at: str
    updated_at: str

    @model_validator(mode="before")
    @classmethod
    def add_frontend_subscription_aliases(cls, value: Any) -> Any:
        if isinstance(value, dict):
            value = dict(value)
            value.setdefault("next_bill_date", value.get("current_period_end"))
        return value


class StudentBillingEnrollmentBaseCreate(BaseModel):
    billing_plan_id: str = Field(validation_alias=AliasChoices("billing_plan_id", "plan_id"))
    payer_id: Optional[str] = None
    collection_mode: BillingCollectionMode = "invoice_link"
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    next_bill_on: Optional[str] = Field(default=None, validation_alias=AliasChoices("next_bill_on", "next_bill_date"))

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @model_validator(mode="after")
    def validate_payer_for_stripe_collection(self):
        if self.collection_mode != "external" and not self.payer_id:
            raise ValueError("Payer is required for Stripe billing enrollment.")
        return self


class StudentBillingEnrollmentCreate(StudentBillingEnrollmentBaseCreate):
    student_id: str


class StudentBillingEnrollmentForStudentCreate(StudentBillingEnrollmentBaseCreate):
    pass


class StudentBillingEnrollmentUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    billing_plan_id: Optional[str] = Field(default=None, validation_alias=AliasChoices("billing_plan_id", "plan_id"))
    payer_id: Optional[str] = None
    collection_mode: Optional[BillingCollectionMode] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    next_bill_on: Optional[str] = Field(default=None, validation_alias=AliasChoices("next_bill_on", "next_bill_date"))


class StudentBillingEnrollmentResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    studio_id: str
    student_id: str
    payer_id: Optional[str] = None
    billing_plan_id: str
    plan_id: Optional[str] = None
    billing_subscription_id: Optional[str] = None
    subscription_id: Optional[str] = None
    collection_mode: BillingCollectionMode = "invoice_link"
    status: BillingEnrollmentStatus
    billing_status: PayerBillingStatus
    start_date: str
    end_date: Optional[str] = None
    next_bill_on: Optional[str] = None
    next_bill_date: Optional[str] = None
    stripe_subscription_id: Optional[str] = None
    stripe_subscription_item_id: Optional[str] = None
    created_at: str
    updated_at: str

    @model_validator(mode="before")
    @classmethod
    def add_frontend_enrollment_aliases(cls, value: Any) -> Any:
        if isinstance(value, dict):
            value = dict(value)
            value.setdefault("plan_id", value.get("billing_plan_id"))
            value.setdefault("subscription_id", value.get("billing_subscription_id"))
            value.setdefault("next_bill_date", value.get("next_bill_on"))
        return value


class BillingInvoiceItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: str = Field(min_length=1, max_length=240)
    amount_cents: int = Field(ge=0)
    quantity: int = Field(default=1, ge=1)
    student_id: Optional[str] = None
    enrollment_id: Optional[str] = None
    billing_plan_id: Optional[str] = None


class BillingInvoiceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payer_id: str
    student_id: Optional[str] = None
    enrollment_id: Optional[str] = None
    invoice_type: str = "manual"
    collection_mode: Literal["autopay", "invoice_link"] = "invoice_link"
    currency: str = "usd"
    due_date: Optional[str] = None
    description: Optional[str] = None
    amount_cents: Optional[int] = Field(default=None, ge=0)
    items: list[BillingInvoiceItemCreate] = Field(default_factory=list)
    send_hosted_invoice: bool = False

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: str) -> str:
        return value.strip().lower() or "usd"


class BillingInvoiceResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    studio_id: str
    payer_id: Optional[str] = None
    student_id: Optional[str] = None
    enrollment_id: Optional[str] = None
    stripe_invoice_id: Optional[str] = None
    stripe_account_id: Optional[str] = None
    stripe_customer_id: Optional[str] = None
    stripe_subscription_id: Optional[str] = None
    stripe_payment_intent_id: Optional[str] = None
    invoice_number: Optional[str] = None
    number: Optional[str] = None
    invoice_type: str = "manual"
    status: InvoiceStatus = "draft"
    amount_due_cents: int = 0
    amount_paid_cents: int = 0
    amount_remaining_cents: int = 0
    currency: str = "usd"
    hosted_invoice_url: Optional[str] = None
    invoice_pdf: Optional[str] = None
    due_date: Optional[str] = None
    paid_at: Optional[str] = None
    finalized_at: Optional[str] = None
    voided_at: Optional[str] = None
    collection_method: Optional[str] = None
    last_payment_error: Optional[str] = None
    application_fee_amount_cents: int = 0
    external: bool = False
    created_at: str
    updated_at: str

    @model_validator(mode="before")
    @classmethod
    def add_frontend_invoice_aliases(cls, value: Any) -> Any:
        if isinstance(value, dict):
            value = dict(value)
            value.setdefault("number", value.get("invoice_number"))
        return value

    @field_validator("last_payment_error", mode="before")
    @classmethod
    def redact_legacy_external_stripe_sync_error(cls, value: Any) -> Any:
        if isinstance(value, str) and value.startswith(LEGACY_EXTERNAL_STRIPE_SYNC_ERROR_PREFIX):
            return EXTERNAL_STRIPE_SYNC_ERROR_PUBLIC_MESSAGE
        return value


class BillingPaymentResponse(BaseModel):
    id: str
    studio_id: str
    payer_id: Optional[str] = None
    invoice_id: Optional[str] = None
    stripe_customer_id: Optional[str] = None
    stripe_invoice_id: Optional[str] = None
    stripe_payment_intent_id: Optional[str] = None
    stripe_charge_id: Optional[str] = None
    stripe_account_id: Optional[str] = None
    stripe_payment_method_id: Optional[str] = None
    status: PaymentStatus
    amount_cents: int
    currency: str = "usd"
    payment_method_type: Optional[str] = None
    external_method: Optional[str] = None
    note: Optional[str] = None
    receipt_url: Optional[str] = None
    failure_code: Optional[str] = None
    failure_message: Optional[str] = None
    application_fee_amount_cents: int = 0
    refunded_amount_cents: int = 0
    processed_at: Optional[str] = None
    created_at: str
    updated_at: str


class BillingPaymentCohortSummaryResponse(BaseModel):
    period_start: str
    period_end: str
    timezone: Literal["UTC"] = "UTC"
    payment_count: int = 0
    stripe_net_amount_cents: int = 0
    external_net_amount_cents: int = 0
    net_amount_cents: int = 0
    scope: Literal["payment_cohort_net_of_cumulative_refunds"] = "payment_cohort_net_of_cumulative_refunds"
    disclosure: str = (
        "Payments processed in the current UTC month, net of cumulative refunds recorded on those payments. "
        "Refunds do not expose event dates here, so this is not cash movement or true period-net revenue."
    )


class ExternalPaymentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount_cents: int = Field(ge=1)
    currency: str = "usd"
    payer_id: Optional[str] = None
    invoice_id: Optional[str] = None
    external_method: str = Field(min_length=1, max_length=80)
    note: Optional[str] = None

    @model_validator(mode="after")
    def require_payment_target(self) -> "ExternalPaymentCreate":
        if not self.payer_id and not self.invoice_id:
            raise ValueError("External payments must target a payer or invoice.")
        return self


class ExportJobCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

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


class BillingRefundCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount_cents: Optional[int] = Field(default=None, ge=1)
    reason: Optional[str] = None


class BillingRefundResponse(BaseModel):
    id: str
    studio_id: str
    payment_id: Optional[str] = None
    stripe_refund_id: Optional[str] = None
    stripe_charge_id: Optional[str] = None
    stripe_payment_intent_id: Optional[str] = None
    stripe_account_id: Optional[str] = None
    amount_cents: int
    status: str
    reason: Optional[str] = None
    created_at: str
    updated_at: Optional[str] = None


class BillingDisputeResponse(BaseModel):
    id: str
    studio_id: str
    payment_id: Optional[str] = None
    stripe_dispute_id: Optional[str] = None
    stripe_charge_id: Optional[str] = None
    stripe_payment_intent_id: Optional[str] = None
    stripe_account_id: Optional[str] = None
    amount_cents: int = 0
    status: str
    reason: Optional[str] = None
    liability_owner: str = "studio"
    created_at: str
    updated_at: str
