"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpRight,
  Banknote,
  CheckCircle2,
  Clock3,
  CreditCard,
  Download,
  FileText,
  Link2,
  Loader2,
  Mail,
  Plus,
  Receipt,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { Input } from "@/components/ui/input";
import { api, isSubscriptionRequiredError } from "@/lib/api";
import { subscriptionPeriodCopy } from "@/lib/billing-period";
import { useConfigStore, useProgramStore, useStudentStore, useStudioStore } from "@/lib/store";
import type {
  BillingInvoice,
  BillingInvoiceCreate,
  BillingLinkResponse,
  BillingPayment,
  BillingPlan,
  BillingPlanCreate,
  BillingPayer,
  BillingPayerCreate,
  ConnectBusinessEntityType,
  BillingSubscription,
  ExportJob,
  PlatformBillingStatus,
  Program,
  StudentBillingEnrollment,
  StudentBillingEnrollmentCreate,
  StudioPaymentAccount,
} from "@/types";

type BillingTab = "overview" | "plans" | "families" | "enrollments" | "invoices" | "reports";

const TABS: { id: BillingTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "plans", label: "Plans" },
  { id: "families", label: "Families" },
  { id: "enrollments", label: "Enrollments" },
  { id: "invoices", label: "Invoices" },
  { id: "reports", label: "Reports" },
];

type RequirementGroup = {
  id: string;
  label: string;
  description: string;
  matches: string[];
};

const CONNECT_REQUIREMENT_GROUPS: RequirementGroup[] = [
  {
    id: "business-profile",
    label: "Business profile",
    description: "Category, website or product details, and support contact information.",
    matches: ["business_profile."],
  },
  {
    id: "business-details",
    label: "Business or legal details",
    description: "Studio legal address, phone, tax ID, and ownership confirmation.",
    matches: ["company.", "individual.address.", "individual.phone", "individual.id_number"],
  },
  {
    id: "identity",
    label: "Owner or representative identity",
    description: "Name, birthday, email, title, phone, and SSN last 4 where required.",
    matches: ["owners.", "representative.", "individual.first_name", "individual.last_name", "individual.email", "individual.dob.", "individual.ssn_last_4"],
  },
  {
    id: "payouts",
    label: "Payout bank account",
    description: "Bank account or debit card where Stripe can send payouts.",
    matches: ["external_account"],
  },
  {
    id: "statement",
    label: "Statement descriptor",
    description: "The payment label families see on bank or card statements.",
    matches: ["settings.payments.statement_descriptor"],
  },
  {
    id: "terms",
    label: "Stripe terms acceptance",
    description: "Stripe services agreement acceptance by the account holder.",
    matches: ["tos_acceptance."],
  },
];

const PREVIEW_PLATFORM: PlatformBillingStatus = {
  studio_id: "mock-studio",
  plan_name: "Koaryu Core",
  monthly_price_cents: 2700,
  currency: "usd",
  status: "active",
  comped: false,
  trial_start: null,
  trial_end: null,
  current_period_start: "2026-04-01T00:00:00Z",
  current_period_end: "2026-05-01T00:00:00Z",
  cancel_at_period_end: false,
  last_payment_status: "paid",
  stripe_customer_id: "cus_demo",
  stripe_subscription_id: "sub_demo",
  email_usage: {
    included: 500,
    sent: 348,
    overage_count: 0,
    overage_rate_cents: 0.2,
    estimated_overage_cents: 0,
    period_start: "2026-04-01",
    period_end: "2026-05-01",
  },
};

const PREVIEW_CONNECT: StudioPaymentAccount = {
  studio_id: "mock-studio",
  stripe_connected_account_id: "acct_demo",
  status: "charges_enabled",
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  requirements_due: [],
  platform_fee_bps: 50,
  liability_note: "Disputes and chargebacks on Connect direct charges remain the studio's liability.",
  created_at: "2026-03-15T12:00:00Z",
  updated_at: "2026-04-20T12:00:00Z",
};

const PREVIEW_PLANS: BillingPlan[] = [
  {
    id: "plan-kids-unlimited",
    studio_id: "mock-studio",
    name: "Kids Unlimited",
    description: "Unlimited youth classes with belt testing billed separately.",
    amount_cents: 12900,
    currency: "usd",
    billing_interval: "monthly",
    status: "active",
    signup_fee_cents: 4900,
    trial_days: 14,
    proration_behavior: "next_cycle",
    freeze_behavior: null,
    cancellation_policy: "30 days written notice",
    tax_behavior: null,
    stripe_product_id: "prod_demo_kids",
    stripe_price_id: "price_demo_kids",
    programs: [{ program_id: "program-bjj-core", program_name: "Brazilian Jiu-Jitsu Core", program_color_hex: "#38BDF8" }],
    can_accept_payments: true,
    pending_reason: null,
    archived_at: null,
    created_at: "2026-03-15T12:00:00Z",
    updated_at: "2026-04-15T12:00:00Z",
  },
  {
    id: "plan-tkd-family",
    studio_id: "mock-studio",
    name: "Tae Kwon Do Family",
    description: "Family tuition for one or more students in Tae Kwon Do.",
    amount_cents: 17900,
    currency: "usd",
    billing_interval: "monthly",
    status: "active",
    signup_fee_cents: 0,
    trial_days: 0,
    proration_behavior: "next_cycle",
    freeze_behavior: "pause next invoice while student is on hold",
    cancellation_policy: "Month to month",
    tax_behavior: null,
    stripe_product_id: "prod_demo_tkd",
    stripe_price_id: "price_demo_tkd",
    programs: [{ program_id: "program-tae-kwon-do", program_name: "Tae Kwon Do Fundamentals", program_color_hex: "#F59E0B" }],
    can_accept_payments: true,
    pending_reason: null,
    archived_at: null,
    created_at: "2026-03-20T12:00:00Z",
    updated_at: "2026-04-15T12:00:00Z",
  },
  {
    id: "plan-testing-fees",
    studio_id: "mock-studio",
    name: "Belt Testing Fee",
    description: "One-time exam charge collected when a promotion is approved.",
    amount_cents: 3500,
    currency: "usd",
    billing_interval: "paid_in_full",
    status: "active",
    signup_fee_cents: 0,
    trial_days: 0,
    proration_behavior: "none",
    freeze_behavior: null,
    cancellation_policy: null,
    tax_behavior: null,
    stripe_product_id: "prod_demo_test",
    stripe_price_id: "price_demo_test",
    programs: [
      { program_id: "program-bjj-core", program_name: "Brazilian Jiu-Jitsu Core", program_color_hex: "#38BDF8" },
      { program_id: "program-tae-kwon-do", program_name: "Tae Kwon Do Fundamentals", program_color_hex: "#F59E0B" },
    ],
    can_accept_payments: true,
    pending_reason: null,
    archived_at: null,
    created_at: "2026-04-01T12:00:00Z",
    updated_at: "2026-04-15T12:00:00Z",
  },
];

const PREVIEW_PAYERS: BillingPayer[] = [
  {
    id: "payer-tanaka",
    studio_id: "mock-studio",
    guardian_id: "g-1",
    display_name: "Kenji Tanaka",
    email: "kenji.tanaka@email.com",
    phone: "(555) 234-5678",
    address_line1: null,
    address_city: null,
    address_state: null,
    address_zip: null,
    stripe_customer_id: "cus_tanaka",
    stripe_payment_method_id: "pm_tanaka",
    stripe_payment_method_type: "card",
    stripe_payment_method_last4: "4242",
    stripe_payment_method_brand: "visa",
    stripe_sync_status: "synced",
    stripe_sync_error: null,
    last_synced_at: "2026-04-22T12:00:00Z",
    autopay_status: "enabled",
    billing_status: "current",
    balance_cents: 0,
    created_at: "2026-03-10T12:00:00Z",
    updated_at: "2026-04-22T12:00:00Z",
  },
  {
    id: "payer-park",
    studio_id: "mock-studio",
    guardian_id: null,
    display_name: "Mina Park",
    email: "mina.park@email.com",
    phone: "(555) 987-1122",
    address_line1: null,
    address_city: null,
    address_state: null,
    address_zip: null,
    stripe_customer_id: "cus_park",
    stripe_payment_method_id: "pm_park",
    stripe_payment_method_type: "card",
    stripe_payment_method_last4: "0341",
    stripe_payment_method_brand: "mastercard",
    stripe_sync_status: "synced",
    stripe_sync_error: null,
    last_synced_at: "2026-04-22T12:00:00Z",
    autopay_status: "enabled",
    billing_status: "past_due",
    balance_cents: 12900,
    created_at: "2026-03-14T12:00:00Z",
    updated_at: "2026-04-22T12:00:00Z",
  },
  {
    id: "payer-external",
    studio_id: "mock-studio",
    guardian_id: null,
    display_name: "Omar Haddad",
    email: "omar.haddad@email.com",
    phone: "(555) 222-1818",
    address_line1: null,
    address_city: null,
    address_state: null,
    address_zip: null,
    stripe_customer_id: null,
    stripe_payment_method_id: null,
    stripe_payment_method_type: null,
    stripe_payment_method_last4: null,
    stripe_payment_method_brand: null,
    stripe_sync_status: "missing",
    stripe_sync_error: null,
    last_synced_at: null,
    autopay_status: "not_configured",
    billing_status: "externally_paid",
    balance_cents: 0,
    created_at: "2026-03-21T12:00:00Z",
    updated_at: "2026-04-20T12:00:00Z",
  },
];

const PREVIEW_SUBSCRIPTIONS: BillingSubscription[] = [
  {
    id: "sub-local-tanaka",
    studio_id: "mock-studio",
    payer_id: "payer-tanaka",
    enrollment_id: "enroll-akira",
    plan_id: "plan-kids-unlimited",
    student_id: "student-akira",
    stripe_subscription_id: "sub_demo_tanaka",
    stripe_subscription_item_id: "si_demo_tanaka",
    status: "active",
    collection_mode: "autopay",
    current_period_start: "2026-04-01",
    current_period_end: "2026-05-01",
    next_bill_date: "2026-05-01",
    cancel_at_period_end: false,
    canceled_at: null,
    trial_start: null,
    trial_end: null,
    created_at: "2026-03-10T12:00:00Z",
    updated_at: "2026-04-22T12:00:00Z",
  },
  {
    id: "sub-local-park",
    studio_id: "mock-studio",
    payer_id: "payer-park",
    enrollment_id: "enroll-jun",
    plan_id: "plan-kids-unlimited",
    student_id: "student-jun",
    stripe_subscription_id: "sub_demo_park",
    stripe_subscription_item_id: "si_demo_park",
    status: "past_due",
    collection_mode: "invoice_link",
    current_period_start: "2026-04-01",
    current_period_end: "2026-05-01",
    next_bill_date: "2026-05-01",
    cancel_at_period_end: false,
    canceled_at: null,
    trial_start: null,
    trial_end: null,
    created_at: "2026-03-14T12:00:00Z",
    updated_at: "2026-04-22T12:00:00Z",
  },
];

const PREVIEW_ENROLLMENTS: StudentBillingEnrollment[] = [
  {
    id: "enroll-akira",
    studio_id: "mock-studio",
    student_id: "student-akira",
    payer_id: "payer-tanaka",
    plan_id: "plan-kids-unlimited",
    subscription_id: "sub-local-tanaka",
    stripe_subscription_id: "sub_demo_tanaka",
    stripe_subscription_item_id: "si_demo_tanaka",
    collection_mode: "autopay",
    status: "active",
    start_date: "2026-04-01",
    end_date: null,
    next_bill_date: "2026-05-01",
    paused_at: null,
    canceled_at: null,
    created_at: "2026-03-10T12:00:00Z",
    updated_at: "2026-04-22T12:00:00Z",
  },
  {
    id: "enroll-jun",
    studio_id: "mock-studio",
    student_id: "student-jun",
    payer_id: "payer-park",
    plan_id: "plan-kids-unlimited",
    subscription_id: "sub-local-park",
    stripe_subscription_id: "sub_demo_park",
    stripe_subscription_item_id: "si_demo_park",
    collection_mode: "invoice_link",
    status: "active",
    start_date: "2026-04-01",
    end_date: null,
    next_bill_date: "2026-05-01",
    paused_at: null,
    canceled_at: null,
    created_at: "2026-03-14T12:00:00Z",
    updated_at: "2026-04-22T12:00:00Z",
  },
  {
    id: "enroll-omar",
    studio_id: "mock-studio",
    student_id: "student-omar",
    payer_id: "payer-external",
    plan_id: "plan-tkd-family",
    subscription_id: null,
    stripe_subscription_id: null,
    stripe_subscription_item_id: null,
    collection_mode: "external",
    status: "active",
    start_date: "2026-04-05",
    end_date: null,
    next_bill_date: "2026-05-05",
    paused_at: null,
    canceled_at: null,
    created_at: "2026-03-21T12:00:00Z",
    updated_at: "2026-04-20T12:00:00Z",
  },
];

const PREVIEW_INVOICES: BillingInvoice[] = [
  {
    id: "inv-paid-1",
    studio_id: "mock-studio",
    payer_id: "payer-tanaka",
    student_id: null,
    enrollment_id: null,
    stripe_invoice_id: "in_demo_paid",
    stripe_account_id: "acct_demo",
    invoice_type: "tuition",
    status: "paid",
    amount_due_cents: 12900,
    amount_paid_cents: 12900,
    currency: "usd",
    hosted_invoice_url: "https://dashboard.stripe.com/test/invoices/in_demo_paid",
    due_date: "2026-04-01",
    paid_at: "2026-04-01T10:00:00Z",
    external: false,
    created_at: "2026-04-01T08:00:00Z",
    updated_at: "2026-04-01T10:00:00Z",
  },
  {
    id: "inv-failed-1",
    studio_id: "mock-studio",
    payer_id: "payer-park",
    student_id: null,
    enrollment_id: null,
    stripe_invoice_id: "in_demo_failed",
    stripe_account_id: "acct_demo",
    invoice_type: "tuition",
    status: "open",
    amount_due_cents: 12900,
    amount_paid_cents: 0,
    currency: "usd",
    hosted_invoice_url: "https://dashboard.stripe.com/test/invoices/in_demo_failed",
    due_date: "2026-04-01",
    paid_at: null,
    external: false,
    created_at: "2026-04-01T08:00:00Z",
    updated_at: "2026-04-03T08:00:00Z",
  },
  {
    id: "inv-external-1",
    studio_id: "mock-studio",
    payer_id: "payer-external",
    student_id: null,
    enrollment_id: null,
    stripe_invoice_id: null,
    stripe_account_id: null,
    invoice_type: "tuition",
    status: "paid",
    amount_due_cents: 17900,
    amount_paid_cents: 17900,
    currency: "usd",
    hosted_invoice_url: null,
    due_date: "2026-04-05",
    paid_at: "2026-04-05T15:00:00Z",
    external: true,
    created_at: "2026-04-05T08:00:00Z",
    updated_at: "2026-04-05T15:00:00Z",
  },
];

const PREVIEW_PAYMENTS: BillingPayment[] = [
  {
    id: "pay-card-1",
    studio_id: "mock-studio",
    payer_id: "payer-tanaka",
    invoice_id: "inv-paid-1",
    status: "succeeded",
    amount_cents: 12900,
    currency: "usd",
    payment_method_type: "card",
    external_method: null,
    note: null,
    processed_at: "2026-04-01T10:00:00Z",
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-01T10:00:00Z",
  },
  {
    id: "pay-external-1",
    studio_id: "mock-studio",
    payer_id: "payer-external",
    invoice_id: "inv-external-1",
    status: "externally_recorded",
    amount_cents: 17900,
    currency: "usd",
    payment_method_type: null,
    external_method: "Zelle",
    note: "Recorded by front desk.",
    processed_at: "2026-04-05T15:00:00Z",
    created_at: "2026-04-05T15:00:00Z",
    updated_at: "2026-04-05T15:00:00Z",
  },
];

function formatMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function formatDate(value?: string | null) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function intervalLabel(interval: BillingPlan["billing_interval"]) {
  const labels: Record<BillingPlan["billing_interval"], string> = {
    weekly: "Weekly",
    biweekly: "Every 2 weeks",
    monthly: "Monthly",
    annual: "Annual",
    paid_in_full: "Paid in full",
    fixed_term: "Fixed term",
    trial: "Trial",
  };
  return labels[interval];
}

function requirementGroupItems(requirementsDue: string[]) {
  return CONNECT_REQUIREMENT_GROUPS.map((group) => {
    const dueFields = requirementsDue.filter((field) =>
      group.matches.some((prefix) => field === prefix || field.startsWith(prefix))
    );
    return {
      ...group,
      dueFields,
      complete: dueFields.length === 0,
    };
  });
}

function connectReturnUrl() {
  return `${window.location.origin}/billing?connect=return`;
}

function connectRefreshUrl() {
  return `${window.location.origin}/billing/connect/refresh`;
}

function statusTone(status: string) {
  if (["active", "current", "paid", "succeeded", "charges_enabled", "trialing", "externally_recorded", "externally_paid"].includes(status)) {
    return "border-success/20 bg-success/10 text-success";
  }
  if (["pending", "open", "upcoming", "onboarding_incomplete", "incomplete", "incomplete_expired", "paused"].includes(status)) {
    return "border-warning/20 bg-warning/10 text-warning";
  }
  if (["past_due", "failed", "unpaid", "action_required", "deauthorized", "uncollectible"].includes(status)) {
    return "border-danger/20 bg-danger/10 text-danger";
  }
  return "border-border bg-surface-raised text-muted";
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-[4px] border px-2 py-0.5 text-[11px] font-medium ${statusTone(status)}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-border bg-surface rounded-[6px] p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold text-text-primary">{value}</p>
      {hint ? <p className="mt-1 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

function SectionHeader({ icon: Icon, title, description }: { icon: typeof CreditCard; title: string; description?: string }) {
  return (
    <div className="mb-4 flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 text-accent" />
      <div>
        <h2 className="text-sm font-medium text-text-primary">{title}</h2>
        {description ? <p className="mt-1 text-xs text-muted">{description}</p> : null}
      </div>
    </div>
  );
}

function ProgramChip({ program }: { program: BillingPlan["programs"][number] }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[4px] border border-border px-2 py-0.5 text-xs text-text-secondary">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: program.program_color_hex || "#94A3B8" }} />
      {program.program_name || "Program"}
    </span>
  );
}

export default function BillingPage() {
  const router = useRouter();
  const { isPreviewMode, token, markSubscriptionRequired } = useConfigStore();
  const { currentRole } = useStudioStore();
  const { programs, programsLoaded, refreshPrograms } = useProgramStore();
  const { students, studentsLoaded } = useStudentStore();
  const [activeTab, setActiveTab] = useState<BillingTab>("overview");
  const [platformBilling, setPlatformBilling] = useState<PlatformBillingStatus | null>(null);
  const [paymentAccount, setPaymentAccount] = useState<StudioPaymentAccount | null>(null);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [payers, setPayers] = useState<BillingPayer[]>([]);
  const [subscriptions, setSubscriptions] = useState<BillingSubscription[]>([]);
  const [enrollments, setEnrollments] = useState<StudentBillingEnrollment[]>([]);
  const [invoices, setInvoices] = useState<BillingInvoice[]>([]);
  const [payments, setPayments] = useState<BillingPayment[]>([]);
  const [exportJobs, setExportJobs] = useState<ExportJob[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [showConnectEntityModal, setShowConnectEntityModal] = useState(false);
  const [connectEntityType, setConnectEntityType] = useState<ConnectBusinessEntityType>("company");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [planName, setPlanName] = useState("");
  const [planAmount, setPlanAmount] = useState("");
  const [planSignupFee, setPlanSignupFee] = useState("");
  const [planTrialDays, setPlanTrialDays] = useState("");
  const [planDescription, setPlanDescription] = useState("");
  const [planInterval, setPlanInterval] = useState<BillingPlan["billing_interval"]>("monthly");
  const [planProgramIds, setPlanProgramIds] = useState<string[]>([]);
  const [coreCheckoutRequestKey, setCoreCheckoutRequestKey] = useState<string | null>(null);
  const [payerName, setPayerName] = useState("");
  const [payerEmail, setPayerEmail] = useState("");
  const [payerPhone, setPayerPhone] = useState("");
  const [enrollmentStudentId, setEnrollmentStudentId] = useState("");
  const [enrollmentPayerId, setEnrollmentPayerId] = useState("");
  const [enrollmentPlanId, setEnrollmentPlanId] = useState("");
  const [enrollmentCollectionMode, setEnrollmentCollectionMode] = useState<StudentBillingEnrollment["collection_mode"]>("autopay");
  const [enrollmentStartDate, setEnrollmentStartDate] = useState("");
  const [enrollmentEndDate, setEnrollmentEndDate] = useState("");
  const [enrollmentNextBillDate, setEnrollmentNextBillDate] = useState("");
  const [invoicePayerId, setInvoicePayerId] = useState("");
  const [invoiceEnrollmentId, setInvoiceEnrollmentId] = useState("");
  const [invoiceStudentId, setInvoiceStudentId] = useState("");
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [invoiceDueDate, setInvoiceDueDate] = useState("");
  const [invoiceDescription, setInvoiceDescription] = useState("");
  const [invoiceSendHosted, setInvoiceSendHosted] = useState(true);
  const [invoiceRequestKey, setInvoiceRequestKey] = useState<string | null>(null);
  const [externalPayerId, setExternalPayerId] = useState("");
  const [externalAmount, setExternalAmount] = useState("");
  const [externalMethod, setExternalMethod] = useState("Zelle");
  const [externalNote, setExternalNote] = useState("");

  const canManageKoaryuSubscription = currentRole === "admin";
  const canManageStudioBilling = currentRole === "admin" || currentRole === "front_desk";
  const isLiveRestricted = !isPreviewMode && currentRole !== null && !canManageStudioBilling;
  const isActionLoading = activeAction !== null;
  const isLoadingAction = (action: string) => activeAction === action;

  const liveDataReady = isPreviewMode || paymentAccount !== null || isLoading;
  const billingPlatform = isPreviewMode ? PREVIEW_PLATFORM : platformBilling;
  const billingConnect = isPreviewMode ? PREVIEW_CONNECT : paymentAccount;
  const billingPlans = isPreviewMode ? PREVIEW_PLANS : plans;
  const billingPayers = isPreviewMode ? PREVIEW_PAYERS : payers;
  const billingSubscriptions = isPreviewMode ? PREVIEW_SUBSCRIPTIONS : subscriptions;
  const billingEnrollments = isPreviewMode ? PREVIEW_ENROLLMENTS : enrollments;
  const billingInvoices = isPreviewMode ? PREVIEW_INVOICES : invoices;
  const billingPayments = isPreviewMode ? PREVIEW_PAYMENTS : payments;
  const billingPeriod = subscriptionPeriodCopy(billingPlatform);
  const canOpenCustomerPortal = canManageKoaryuSubscription && Boolean(billingPlatform?.stripe_customer_id);
  const hasStripeConnectedAccount = Boolean(billingConnect?.stripe_connected_account_id);
  const canOpenStripeDashboard = Boolean(hasStripeConnectedAccount && billingConnect?.status !== "deauthorized");
  const needsConnectOnboarding = Boolean(
    hasStripeConnectedAccount
      && (
        !billingConnect?.charges_enabled
        || !billingConnect.details_submitted
        || billingConnect.status !== "charges_enabled"
        || Boolean(billingConnect.requirements_due?.length)
      )
  );
  const connectActionLabel = needsConnectOnboarding
    ? "Continue onboarding"
    : "Connect Stripe";
  const connectRequirementItems = useMemo(
    () => requirementGroupItems(billingConnect?.requirements_due ?? []),
    [billingConnect?.requirements_due]
  );
  const activePrograms = useMemo(
    () => programs.filter((program) => !program.archived_at && !program.is_system),
    [programs]
  );
  const activeStudents = useMemo(
    () => students.filter((student) => student.status === "active").length,
    [students]
  );
  const billingStudentOptions = useMemo(() => {
    const options = students
      .filter((student) => student.status === "active")
      .map((student) => ({
        id: student.id,
        name: `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`,
      }));
    if (isPreviewMode && options.length === 0) {
      return [
        { id: "student-akira", name: "Akira Tanaka" },
        { id: "student-jun", name: "Jun Park" },
        { id: "student-omar", name: "Omar Haddad Jr." },
      ];
    }
    return options;
  }, [isPreviewMode, students]);
  const paidRevenue = useMemo(
    () => billingPayments
      .filter((payment) => payment.status === "succeeded" || payment.status === "externally_recorded")
      .reduce((sum, payment) => sum + payment.amount_cents, 0),
    [billingPayments]
  );
  const openInvoiceTotal = useMemo(
    () => billingInvoices
      .filter((invoice) => invoice.status === "open" || invoice.status === "draft")
      .reduce((sum, invoice) => sum + Math.max(invoice.amount_due_cents - invoice.amount_paid_cents, 0), 0),
    [billingInvoices]
  );
  const failedInvoiceCount = useMemo(
    () => billingPayers.filter((payer) => payer.billing_status === "past_due" || payer.billing_status === "failed").length,
    [billingPayers]
  );
  const externalPaymentTotal = useMemo(
    () => billingPayments
      .filter((payment) => payment.status === "externally_recorded")
      .reduce((sum, payment) => sum + payment.amount_cents, 0),
    [billingPayments]
  );
  const stripePaymentTotal = paidRevenue - externalPaymentTotal;
  const koaryuFeeBasis = Math.max(stripePaymentTotal, 0);
  const koaryuEstimatedFees = Math.round(koaryuFeeBasis * ((billingConnect?.platform_fee_bps ?? 50) / 10000));
  const autopayEnabledCount = useMemo(
    () => billingPayers.filter((payer) => payer.autopay_status === "enabled").length,
    [billingPayers]
  );
  const activeSubscriptionCount = useMemo(
    () => billingSubscriptions.filter((subscription) => subscription.status === "active" || subscription.status === "trialing").length,
    [billingSubscriptions]
  );
  const unsyncedPlanCount = useMemo(
    () => billingPlans.filter((plan) => !plan.stripe_price_id || plan.stripe_sync_status === "pending" || plan.stripe_sync_status === "missing" || plan.stripe_sync_status === "error").length,
    [billingPlans]
  );
  const studentNameById = useMemo(() => {
    const names = new Map<string, string>();
    students.forEach((student) => {
      names.set(student.id, `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`);
    });
    PREVIEW_ENROLLMENTS.forEach((enrollment) => {
      if (!names.has(enrollment.student_id)) {
        names.set(enrollment.student_id, enrollment.student_id.replace(/^student-/, ""));
      }
    });
    return names;
  }, [students]);
  const payerNameById = useMemo(
    () => new Map(billingPayers.map((payer) => [payer.id, payer.display_name])),
    [billingPayers]
  );
  const planNameById = useMemo(
    () => new Map(billingPlans.map((plan) => [plan.id, plan.name])),
    [billingPlans]
  );

  const refreshBilling = useCallback(async () => {
    if (isPreviewMode || !token || !canManageStudioBilling) {
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      const results = await Promise.allSettled([
        canManageKoaryuSubscription
          ? api.get<PlatformBillingStatus>("/platform-billing/status", token)
          : Promise.resolve(null),
        api.get<StudioPaymentAccount>("/billing/connect/status", token),
        api.get<BillingPlan[]>("/billing/plans", token),
        api.get<BillingPayer[]>("/billing/payers", token),
        api.get<BillingSubscription[]>("/billing/subscriptions", token),
        api.get<StudentBillingEnrollment[]>("/billing/enrollments", token),
        api.get<BillingInvoice[]>("/billing/invoices", token),
        api.get<BillingPayment[]>("/billing/payments", token),
      ] as const);

      const [
        platformResult,
        connectResult,
        plansResult,
        payersResult,
        subscriptionsResult,
        enrollmentsResult,
        invoicesResult,
        paymentsResult,
      ] = results;

      const failures: string[] = [];
      const subscriptionRequired = results.some((result) =>
        result.status === "rejected" && isSubscriptionRequiredError(result.reason)
      );
      if (subscriptionRequired) {
        markSubscriptionRequired();
        router.replace("/subscription-required");
        return;
      }

      const applyResult = <T,>(
        label: string,
        result: PromiseSettledResult<T>,
        apply: (value: T) => void,
        clear: () => void
      ) => {
        if (result.status === "fulfilled") {
          apply(result.value);
          return;
        }
        clear();
        const message = result.reason instanceof Error ? result.reason.message : "could not be loaded";
        failures.push(`${label}: ${message}`);
      };

      applyResult("Koaryu Core", platformResult, setPlatformBilling, () => setPlatformBilling(null));
      applyResult("Stripe Connect", connectResult, setPaymentAccount, () => setPaymentAccount(null));
      applyResult("Plans", plansResult, setPlans, () => setPlans([]));
      applyResult("Families", payersResult, setPayers, () => setPayers([]));
      applyResult("Subscriptions", subscriptionsResult, setSubscriptions, () => setSubscriptions([]));
      applyResult("Enrollments", enrollmentsResult, setEnrollments, () => setEnrollments([]));
      applyResult("Invoices", invoicesResult, setInvoices, () => setInvoices([]));
      applyResult("Payments", paymentsResult, setPayments, () => setPayments([]));

      if (failures.length > 0) {
        setError(`Some billing data is unavailable. ${failures.join(" ")}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Billing could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  }, [canManageKoaryuSubscription, canManageStudioBilling, isPreviewMode, markSubscriptionRequired, router, token]);

  const refreshConnectStatus = useCallback(async ({ sync = false }: { sync?: boolean } = {}) => {
    if (isPreviewMode || !token || !canManageStudioBilling) {
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      const account = sync
        ? await api.post<StudioPaymentAccount>("/billing/connect/sync", {}, token, { timeoutMs: 30000 })
        : await api.get<StudioPaymentAccount>("/billing/connect/status", token);
      setPaymentAccount(account);
      if (sync) {
        setMessage(account.charges_enabled ? "Stripe verification is complete." : "Stripe account status updated.");
      }
    } catch (err) {
      if (isSubscriptionRequiredError(err)) {
        markSubscriptionRequired();
        router.replace("/subscription-required");
        return;
      }
      setError(err instanceof Error ? err.message : "Stripe Connect status could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  }, [canManageStudioBilling, isPreviewMode, markSubscriptionRequired, router, token]);

  useEffect(() => {
    if (!programsLoaded) {
      void refreshPrograms({ includeArchived: false }).catch(() => undefined);
    }
  }, [programsLoaded, refreshPrograms]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.get("connect") === "return") {
        void refreshConnectStatus({ sync: true });
        return;
      }
      void refreshBilling();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshBilling, refreshConnectStatus]);

  function togglePlanProgram(programId: string) {
    setPlanProgramIds((current) =>
      current.includes(programId)
        ? current.filter((id) => id !== programId)
        : [...current, programId]
    );
  }

  async function openBillingLink(path: string, body: Record<string, string | undefined>, action = "stripe-link") {
    if (isPreviewMode) {
      setMessage("Demo mode uses Stripe-hosted surfaces in production.");
      return;
    }
    if (!token) return;
    setActiveAction(action);
    setError("");
    setMessage("");
    try {
      const requestKey = action === "checkout"
        ? coreCheckoutRequestKey ?? (
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `core-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`
        )
        : null;
      if (action === "checkout" && requestKey && !coreCheckoutRequestKey) {
        setCoreCheckoutRequestKey(requestKey);
      }
      const link = await api.post<BillingLinkResponse>(path, body, token, {
        timeoutMs: 30000,
        headers: requestKey ? { "Idempotency-Key": requestKey } : undefined,
      });
      if (action === "checkout") {
        setCoreCheckoutRequestKey(null);
      }
      window.location.assign(link.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stripe link could not be created.");
    } finally {
      setActiveAction(null);
    }
  }

  async function openConnectOnboarding(businessEntityType?: ConnectBusinessEntityType) {
    await openBillingLink(
      "/billing/connect/onboarding-link",
      {
        return_url: connectReturnUrl(),
        refresh_url: connectRefreshUrl(),
        business_entity_type: businessEntityType,
      },
      "connect"
    );
  }

  function handleConnectClick() {
    if (!hasStripeConnectedAccount) {
      setShowConnectEntityModal(true);
      return;
    }
    void openConnectOnboarding();
  }

  async function handleConfirmConnectEntity() {
    setShowConnectEntityModal(false);
    await openConnectOnboarding(connectEntityType);
  }

  async function postBillingAction<T>(path: string, body: Record<string, unknown> = {}, successMessage: string, action = "billing-action") {
    if (isPreviewMode) {
      setMessage(successMessage);
      return null;
    }
    if (!token) return null;
    setActiveAction(action);
    setError("");
    setMessage("");
    try {
      const result = await api.post<T>(path, body, token);
      setMessage(successMessage);
      await refreshBilling();
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Billing action could not be completed.");
      return null;
    } finally {
      setActiveAction(null);
    }
  }

  async function handlePlanSync(planId: string) {
    await postBillingAction<BillingPlan>(`/billing/plans/${planId}/sync`, {}, "Plan sync requested.", `plan-sync:${planId}`);
  }

  async function handleConnectReset() {
    await postBillingAction<StudioPaymentAccount>(
      "/billing/connect/reset",
      {},
      "Stripe connection cleared. Start onboarding again to connect the active Stripe platform.",
      "connect-reset"
    );
  }

  async function handlePayerSync(payerId: string) {
    await postBillingAction<BillingPayer>(`/billing/payers/${payerId}/sync`, {}, "Payer sync requested.", `payer-sync:${payerId}`);
  }

  async function handleAutopaySetup(payerId: string) {
    const link = await postBillingAction<BillingLinkResponse>(
      `/billing/payers/${payerId}/autopay/setup-link`,
      { return_url: window.location.href },
      "Opening Stripe autopay setup.",
      `autopay-setup:${payerId}`
    );
    if (link?.url) {
      window.location.assign(link.url);
    }
  }

  async function handleAutopayDisable(payerId: string) {
    await postBillingAction<BillingPayer>(`/billing/payers/${payerId}/autopay/disable`, {}, "Autopay disabled.", `autopay-disable:${payerId}`);
  }

  async function handleEnrollmentAction(enrollmentId: string, action: "pause" | "resume" | "cancel") {
    await postBillingAction<StudentBillingEnrollment>(
      `/billing/enrollments/${enrollmentId}/${action}`,
      {},
      `Enrollment ${action} requested.`,
      `enrollment:${enrollmentId}:${action}`
    );
  }

  async function handleEnrollmentModeUpdate(enrollmentId: string, collectionMode: StudentBillingEnrollment["collection_mode"]) {
    if (isPreviewMode) {
      setMessage("Demo enrollment collection mode updated.");
      return;
    }
    if (!token) return;
    setActiveAction(`enrollment-mode:${enrollmentId}`);
    setError("");
    setMessage("");
    try {
      await api.patch<StudentBillingEnrollment>(`/billing/enrollments/${enrollmentId}`, { collection_mode: collectionMode }, token);
      setMessage("Enrollment collection mode updated.");
      await refreshBilling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enrollment could not be updated.");
    } finally {
      setActiveAction(null);
    }
  }

  async function handleInvoiceAction(invoiceId: string, action: "finalize" | "void" | "retry" | "reconcile") {
    await postBillingAction<BillingInvoice>(
      `/billing/invoices/${invoiceId}/${action}`,
      {},
      `Invoice ${action} requested.`,
      `invoice:${invoiceId}:${action}`
    );
  }

  async function handleCreatePlan(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    const amount = Number(planAmount);
    const signupFee = planSignupFee ? Number(planSignupFee) : 0;
    const trialDays = planTrialDays ? Number(planTrialDays) : 0;
    if (!planName.trim()) {
      setError("Plan name is required.");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a valid plan amount.");
      return;
    }
    if (planProgramIds.length === 0) {
      setError("Choose at least one program for this billing plan.");
      return;
    }
    if (!Number.isFinite(signupFee) || signupFee < 0) {
      setError("Enter a valid signup fee.");
      return;
    }
    if (!Number.isInteger(trialDays) || trialDays < 0) {
      setError("Trial days must be a whole number.");
      return;
    }
    if (isPreviewMode) {
      setMessage("Demo plan drafted. Live studios save this to Supabase and Stripe when payments are enabled.");
      setPlanName("");
      setPlanAmount("");
      setPlanSignupFee("");
      setPlanTrialDays("");
      setPlanDescription("");
      setPlanProgramIds([]);
      return;
    }
    if (!token) return;
    setActiveAction("create-plan");
    try {
      const payload: BillingPlanCreate = {
        name: planName.trim(),
        description: planDescription.trim() || undefined,
        amount_cents: Math.round(amount * 100),
        currency: "usd",
        billing_interval: planInterval,
        program_ids: planProgramIds,
        signup_fee_cents: Math.round(signupFee * 100),
        trial_days: trialDays,
        proration_behavior: "next_cycle",
      };
      await api.post<BillingPlan>("/billing/plans", payload, token);
      setMessage(billingConnect?.charges_enabled ? "Billing plan created." : "Billing plan drafted. It will stay pending until Stripe charges are enabled.");
      setPlanName("");
      setPlanAmount("");
      setPlanSignupFee("");
      setPlanTrialDays("");
      setPlanDescription("");
      setPlanProgramIds([]);
      await refreshBilling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Billing plan could not be created.");
    } finally {
      setActiveAction(null);
    }
  }

  async function handleCreatePayer(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!payerName.trim()) {
      setError("Payer name is required.");
      return;
    }
    if (isPreviewMode) {
      setMessage("Demo payer created locally.");
      setPayerName("");
      setPayerEmail("");
      setPayerPhone("");
      return;
    }
    if (!token) return;
    setActiveAction("create-payer");
    try {
      const payload: BillingPayerCreate = {
        display_name: payerName.trim(),
        email: payerEmail.trim() || undefined,
        phone: payerPhone.trim() || undefined,
      };
      await api.post<BillingPayer>("/billing/payers", payload, token);
      setMessage("Family payer created.");
      setPayerName("");
      setPayerEmail("");
      setPayerPhone("");
      await refreshBilling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Family payer could not be created.");
    } finally {
      setActiveAction(null);
    }
  }

  async function handleCreateEnrollment(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!enrollmentStudentId || !enrollmentPayerId || !enrollmentPlanId) {
      setError("Choose a student, payer, and plan.");
      return;
    }
    if (!enrollmentStartDate) {
      setError("Start date is required.");
      return;
    }
    if (isPreviewMode) {
      setMessage("Demo enrollment attached.");
      return;
    }
    if (!token) return;
    setActiveAction("create-enrollment");
    try {
      const payload: StudentBillingEnrollmentCreate = {
        student_id: enrollmentStudentId,
        payer_id: enrollmentPayerId,
        plan_id: enrollmentPlanId,
        collection_mode: enrollmentCollectionMode,
        start_date: enrollmentStartDate,
        end_date: enrollmentEndDate || null,
        next_bill_date: enrollmentNextBillDate || null,
      };
      await api.post<StudentBillingEnrollment>("/billing/enrollments", payload, token);
      setMessage("Billing enrollment created.");
      setEnrollmentStudentId("");
      setEnrollmentPayerId("");
      setEnrollmentPlanId("");
      setEnrollmentCollectionMode("autopay");
      setEnrollmentStartDate("");
      setEnrollmentEndDate("");
      setEnrollmentNextBillDate("");
      await refreshBilling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enrollment could not be created.");
    } finally {
      setActiveAction(null);
    }
  }

  async function handleCreateInvoice(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    const amount = Number(invoiceAmount);
    if (!invoicePayerId) {
      setError("Choose a payer for this invoice.");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a valid invoice amount.");
      return;
    }
    if (isPreviewMode) {
      setMessage(invoiceSendHosted ? "Demo hosted invoice drafted." : "Demo invoice drafted.");
      setInvoiceAmount("");
      setInvoiceDescription("");
      return;
    }
    if (!token) return;
    setActiveAction("create-invoice");
    try {
      const requestKey = invoiceRequestKey ?? (
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `invoice-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      if (!invoiceRequestKey) {
        setInvoiceRequestKey(requestKey);
      }
      const payload: BillingInvoiceCreate = {
        payer_id: invoicePayerId,
        enrollment_id: invoiceEnrollmentId || undefined,
        student_id: invoiceStudentId || undefined,
        amount_cents: Math.round(amount * 100),
        currency: "usd",
        invoice_type: "tuition",
        due_date: invoiceDueDate || undefined,
        description: invoiceDescription.trim() || undefined,
        send_hosted_invoice: invoiceSendHosted,
      };
      await api.post<BillingInvoice>("/billing/invoices", payload, token, {
        headers: { "Idempotency-Key": requestKey },
      });
      setMessage(invoiceSendHosted ? "Hosted invoice created." : "Invoice drafted.");
      setInvoiceRequestKey(null);
      setInvoiceAmount("");
      setInvoiceDescription("");
      await refreshBilling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invoice could not be created.");
    } finally {
      setActiveAction(null);
    }
  }

  async function handleCreateExport(exportType: string) {
    if (isPreviewMode) {
      setMessage("Demo export queued. Live exports run asynchronously.");
      return;
    }
    if (!token) return;
    setActiveAction(`export:${exportType}`);
    setError("");
    setMessage("");
    try {
      const job = await api.post<ExportJob>("/billing/exports", { export_type: exportType, filters: {} }, token);
      setExportJobs((current) => [job, ...current]);
      setMessage("Export queued. Koaryu will attach a download when it is ready.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export could not be queued.");
    } finally {
      setActiveAction(null);
    }
  }

  async function handleRecordExternalPayment(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    const amount = Number(externalAmount);
    if (!externalPayerId) {
      setError("Choose a payer for this external payment.");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a valid external payment amount.");
      return;
    }
    if (!externalMethod.trim()) {
      setError("Enter the external payment method.");
      return;
    }
    if (isPreviewMode) {
      setMessage("Demo external payment recorded locally.");
      setExternalAmount("");
      setExternalNote("");
      return;
    }
    if (!token) return;
    setActiveAction("record-external");
    try {
      await api.post<BillingPayment>("/billing/payments/external", {
        payer_id: externalPayerId,
        amount_cents: Math.round(amount * 100),
        currency: "usd",
        external_method: externalMethod.trim(),
        note: externalNote.trim() || undefined,
      }, token);
      setMessage("External payment recorded.");
      setExternalAmount("");
      setExternalNote("");
      await refreshBilling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "External payment could not be recorded.");
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <>
      {showConnectEntityModal ? (
        <div className="koaryu-modal-root p-4">
          <div className="koaryu-modal-backdrop" onClick={() => setShowConnectEntityModal(false)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-entity-title"
            className="koaryu-modal-panel w-full max-w-md rounded-[6px] border border-border bg-bg p-5 shadow-2xl"
          >
            <h2 id="connect-entity-title" className="text-base font-semibold text-text-primary">Connect Stripe payments</h2>
            <p className="mt-2 text-sm text-muted">
              Choose the legal account type before Koaryu creates the Stripe account. You can change this choice here until the account is created; afterward, legal entity changes happen in Stripe or by reconnecting a new account.
            </p>
            <div className="mt-4 grid gap-2">
              {([
                ["company", "Registered business / company", "Use this for LLCs, corporations, partnerships, and incorporated studios."],
                ["individual", "Sole proprietor / individual", "Use this when the studio operates under an individual owner without a separate legal company."],
              ] as const).map(([value, label, description]) => (
                <label
                  key={value}
                  className={`cursor-pointer rounded-[6px] border px-3 py-3 transition-colors ${
                    connectEntityType === value
                      ? "border-accent bg-accent/10"
                      : "border-border bg-surface hover:bg-surface-hover"
                  }`}
                >
                  <span className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="connect-entity-type"
                      value={value}
                      checked={connectEntityType === value}
                      onChange={() => setConnectEntityType(value)}
                      className="mt-1 accent-[#E5C15C]"
                    />
                    <span>
                      <span className="block text-sm font-medium text-text-primary">{label}</span>
                      <span className="mt-1 block text-xs leading-5 text-muted">{description}</span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={isActionLoading} onClick={() => setShowConnectEntityModal(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" isLoading={isLoadingAction("connect")} disabled={isActionLoading} onClick={() => void handleConfirmConnectEntity()}>
                <Link2 className="h-3.5 w-3.5" />
                {isLoadingAction("connect") ? "Opening Stripe..." : "Create Stripe account"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Header title="Billing" description="Koaryu Core, family payments, invoices, and revenue reporting.">
        <Button variant="ghost" size="sm" onClick={() => void refreshBilling()} disabled={isPreviewMode || isLoading || !canManageStudioBilling} isLoading={isLoading}>
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
          {isLoading ? "Refreshing..." : "Refresh"}
        </Button>
      </Header>

      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-[1240px] space-y-5">
          {isLiveRestricted ? (
            <section className="border border-border bg-surface rounded-[6px] p-6">
              <SectionHeader icon={ShieldCheck} title="Billing access is limited" description="Admins and front desk staff can manage studio billing. Instructors can keep using training workflows without billing access." />
            </section>
          ) : null}

          {!isLiveRestricted ? (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-border">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`border-b-2 px-0 py-3 text-sm font-medium transition-colors ${
                      activeTab === tab.id
                        ? "border-accent text-text-primary"
                        : "border-transparent text-muted hover:text-text-secondary"
                    }`}
                  >
                    <span className="px-3">{tab.label}</span>
                  </button>
                ))}
              </div>

              {message ? (
                <DismissibleNotice
                  tone="success"
                  onDismiss={() => setMessage("")}
                  className="text-xs"
                >
                  {message}
                </DismissibleNotice>
              ) : null}
              {error ? (
                <DismissibleNotice
                  tone="danger"
                  onDismiss={() => setError("")}
                  className="text-xs"
                >
                  {error}
                </DismissibleNotice>
              ) : null}

              {!liveDataReady && !isPreviewMode ? (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading billing...
                </div>
              ) : null}

              {activeTab === "overview" ? (
                <div className="space-y-5">
                  <div className="grid gap-4 md:grid-cols-4">
                    <Metric label="Collected this month" value={formatMoney(paidRevenue)} hint={`${billingPayments.length} payment records`} />
                    <Metric label="Open invoice balance" value={formatMoney(openInvoiceTotal)} hint={`${billingInvoices.length} invoices tracked`} />
                    <Metric label="Failed payment queue" value={`${failedInvoiceCount}`} hint="Payers needing follow-up" />
                    <Metric label="Active students" value={studentsLoaded ? String(activeStudents) : "Loading"} hint="Soft alert at 1,500" />
                  </div>

                  <div className="grid gap-4 md:grid-cols-4">
                    <Metric label="Plan sync health" value={unsyncedPlanCount === 0 ? "Synced" : `${unsyncedPlanCount} pending`} hint={`${billingPlans.length} plans configured`} />
                    <Metric label="Autopay families" value={`${autopayEnabledCount}`} hint={`${billingPayers.length} payer accounts`} />
                    <Metric label="Active subscriptions" value={`${activeSubscriptionCount}`} hint={`${billingSubscriptions.length} billing subscriptions`} />
                    <Metric label="Fee basis" value={formatMoney(koaryuFeeBasis)} hint={`${formatMoney(koaryuEstimatedFees)} estimated Koaryu fee`} />
                  </div>

                  <div className="grid gap-5 lg:grid-cols-2">
                    <section className="border border-border bg-surface rounded-[6px] p-5">
                      <SectionHeader icon={CreditCard} title="Koaryu Core" description="One flat software subscription: no student caps, no staff caps, no feature gates." />
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
                        <div>
                          <p className="text-2xl font-semibold text-text-primary">
                            {billingPlatform ? formatMoney(billingPlatform.monthly_price_cents, billingPlatform.currency) : "$27"}
                            <span className="text-sm font-normal text-muted"> / month</span>
                          </p>
                          <p className="mt-1 text-xs text-muted">30-day trial for new studios. Single physical location per subscription.</p>
                        </div>
                        {billingPlatform ? <StatusPill status={billingPlatform.status} /> : <StatusPill status="admin_managed" />}
                      </div>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="text-xs text-muted">{billingPeriod.label}</p>
                          <p className="mt-1 text-sm text-text-primary">
                            {billingPeriod.value}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted">Plan policy</p>
                          <p className="mt-1 text-sm text-text-primary">All modules included</p>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={!canManageKoaryuSubscription || isActionLoading}
                          isLoading={isLoadingAction("checkout")}
                          onClick={() => void openBillingLink("/platform-billing/checkout", {
                            success_url: window.location.href,
                            cancel_url: window.location.href,
                          }, "checkout")}
                        >
                          <CreditCard className="h-3.5 w-3.5" />
                          {isLoadingAction("checkout") ? "Opening Stripe..." : "Start checkout"}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!canOpenCustomerPortal || isActionLoading}
                          isLoading={isLoadingAction("portal")}
                          title={canOpenCustomerPortal ? undefined : "Available after Koaryu Core checkout creates a Stripe customer."}
                          onClick={() => void openBillingLink("/platform-billing/portal", {
                            return_url: window.location.href,
                          }, "portal")}
                        >
                          <ArrowUpRight className="h-3.5 w-3.5" />
                          {isLoadingAction("portal") ? "Opening portal..." : "Customer portal"}
                        </Button>
                      </div>
                    </section>

                    <section className="border border-border bg-surface rounded-[6px] p-5">
                      <SectionHeader icon={Banknote} title="Koaryu Payments" description="Optional Stripe Connect add-on. Koaryu collects 0.5% only on successful processed transactions." />
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
                        <div>
                          <p className="text-sm font-medium text-text-primary">
                            {billingConnect?.charges_enabled ? "Stripe connected" : "Stripe not charging yet"}
                          </p>
                          <p className="mt-1 text-xs text-muted">Cash, checks, Zelle, Venmo, and outside processors cost nothing extra.</p>
                        </div>
                        {billingConnect ? <StatusPill status={billingConnect.status} /> : <StatusPill status="not_connected" />}
                      </div>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="text-xs text-muted">Application fee</p>
                          <p className="mt-1 text-sm text-text-primary">{billingConnect ? `${billingConnect.platform_fee_bps / 100}%` : "0.5%"} on successful charges</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted">Chargeback liability</p>
                          <p className="mt-1 text-sm text-text-primary">Studio account</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted">Stripe revenue</p>
                          <p className="mt-1 text-sm text-text-primary">{formatMoney(stripePaymentTotal)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted">External revenue</p>
                          <p className="mt-1 text-sm text-text-primary">{formatMoney(externalPaymentTotal)}</p>
                        </div>
                      </div>
                      {billingConnect?.stripe_connected_account_id ? (
                        <div className="mt-4 rounded-[6px] border border-border bg-surface-raised/60 p-3">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <p className="text-xs font-medium text-text-secondary">Stripe onboarding checklist</p>
                            <span className="text-[11px] text-muted">
                              {connectRequirementItems.filter((item) => item.complete).length} / {connectRequirementItems.length} complete
                            </span>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {connectRequirementItems.map((item) => (
                              <div key={item.id} className="flex items-start gap-2 rounded-[6px] border border-border bg-bg/40 px-2.5 py-2">
                                {item.complete ? (
                                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-success" />
                                ) : (
                                  <Clock3 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
                                )}
                                <div className="min-w-0">
                                  <p className="text-xs font-medium text-text-primary">{item.label}</p>
                                  <p className="mt-0.5 text-[11px] leading-4 text-muted">{item.complete ? "Received by Stripe" : item.description}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={!canManageKoaryuSubscription || isActionLoading}
                          isLoading={isLoadingAction("connect")}
                          onClick={handleConnectClick}
                        >
                          <Link2 className="h-3.5 w-3.5" />
                          {isLoadingAction("connect") ? "Opening Stripe..." : connectActionLabel}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!canOpenStripeDashboard || !canManageKoaryuSubscription || isActionLoading}
                          isLoading={isLoadingAction("dashboard")}
                          title={canOpenStripeDashboard ? "Open Stripe to review account status, requirements, payments, and payouts." : "Available after Stripe Connect creates an account."}
                          onClick={() => void openBillingLink("/billing/connect/dashboard-link", {
                            return_url: window.location.href,
                          }, "dashboard")}
                        >
                          <ArrowUpRight className="h-3.5 w-3.5" />
                          {isLoadingAction("dashboard") ? "Opening Stripe..." : "Stripe dashboard"}
                        </Button>
                        {hasStripeConnectedAccount && !billingConnect?.charges_enabled ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!canManageKoaryuSubscription || isActionLoading}
                            isLoading={isLoadingAction("connect-reset")}
                            title="Use only when the stored Stripe account no longer belongs to the active Koaryu Stripe platform."
                            onClick={() => void handleConnectReset()}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                            {isLoadingAction("connect-reset") ? "Clearing..." : "Reconnect Stripe"}
                          </Button>
                        ) : null}
                      </div>
                    </section>
                  </div>

                  <section className="border border-border bg-surface rounded-[6px] p-5">
                    <SectionHeader icon={Mail} title="Message usage" description="Automation is included for every studio. Only email volume above the included monthly allowance is metered." />
                    <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
                      <div>
                        <div className="h-2 rounded-full bg-surface-raised">
                          <div
                            className="h-2 rounded-full bg-accent"
                            style={{ width: `${Math.min(100, ((billingPlatform?.email_usage.sent || 0) / (billingPlatform?.email_usage.included || 500)) * 100)}%` }}
                          />
                        </div>
                        <p className="mt-2 text-xs text-muted">
                          {billingPlatform?.email_usage.sent || 0} of {billingPlatform?.email_usage.included || 500} emails used this month. Overage is $0.002 per email. SMS is not included in v1.
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-medium text-text-primary">{formatMoney(billingPlatform?.email_usage.estimated_overage_cents || 0)}</p>
                        <p className="text-xs text-muted">Estimated overage</p>
                      </div>
                    </div>
                  </section>
                </div>
              ) : null}

              {activeTab === "plans" ? (
                <div className="space-y-5">
                  <section className="border border-border bg-surface rounded-[6px] p-5">
                    <SectionHeader icon={Receipt} title="Create billing plan" description="Plans can be drafted before Stripe verification. Pending plans cannot generate invoices or accept payments until charges are enabled." />
                    <form onSubmit={handleCreatePlan} className="grid gap-3 lg:grid-cols-[1.2fr_0.6fr_0.5fr_0.5fr_0.8fr]">
                      <Input label="Plan name" value={planName} onChange={(event) => setPlanName(event.target.value)} placeholder="Kids Unlimited" disabled={!canManageStudioBilling} />
                      <Input label="Monthly amount" value={planAmount} onChange={(event) => setPlanAmount(event.target.value)} placeholder="129" inputMode="decimal" disabled={!canManageStudioBilling} />
                      <Input label="Signup fee" value={planSignupFee} onChange={(event) => setPlanSignupFee(event.target.value)} placeholder="49" inputMode="decimal" disabled={!canManageStudioBilling} />
                      <Input label="Trial days" value={planTrialDays} onChange={(event) => setPlanTrialDays(event.target.value)} placeholder="14" inputMode="numeric" disabled={!canManageStudioBilling} />
                      <div className="flex flex-col gap-1.5">
                        <label className="text-sm text-text-secondary font-medium" htmlFor="billing-interval">Interval</label>
                        <select
                          id="billing-interval"
                          value={planInterval}
                          onChange={(event) => setPlanInterval(event.target.value as BillingPlan["billing_interval"])}
                          disabled={!canManageStudioBilling}
                          className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
                        >
                          {(["monthly", "annual", "weekly", "biweekly", "paid_in_full", "fixed_term", "trial"] as BillingPlan["billing_interval"][]).map((interval) => (
                            <option key={interval} value={interval}>{intervalLabel(interval)}</option>
                          ))}
                        </select>
                      </div>
                      <div className="lg:col-span-5">
                        <Input label="Description" value={planDescription} onChange={(event) => setPlanDescription(event.target.value)} placeholder="Optional internal notes" disabled={!canManageStudioBilling} />
                      </div>
                      <div className="lg:col-span-5">
                        <p className="mb-2 text-sm font-medium text-text-secondary">Programs</p>
                        <div className="flex flex-wrap gap-2">
                          {activePrograms.length === 0 ? (
                            <p className="text-sm text-muted">Create a program in Settings before attaching billing plans.</p>
                          ) : activePrograms.map((program: Program) => (
                            <label key={program.id} className="inline-flex cursor-pointer items-center gap-2 rounded-[6px] border border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
                              <input
                                type="checkbox"
                                checked={planProgramIds.includes(program.id)}
                                onChange={() => togglePlanProgram(program.id)}
                                disabled={!canManageStudioBilling}
                                className="accent-[#E5C15C]"
                              />
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: program.color_hex }} />
                              {program.name}
                            </label>
                          ))}
                        </div>
                      </div>
                      <div className="lg:col-span-5">
                        <Button type="submit" size="sm" disabled={!canManageStudioBilling || isActionLoading || activePrograms.length === 0} isLoading={isLoadingAction("create-plan")}>
                          <Plus className="h-3.5 w-3.5" />
                          {isLoadingAction("create-plan") ? "Creating..." : "Create plan"}
                        </Button>
                      </div>
                    </form>
                  </section>

                  <section className="border border-border bg-surface rounded-[6px]">
                    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted">
                      <span>Plan</span>
                      <span>Amount</span>
                      <span>Stripe</span>
                      <span>Status</span>
                    </div>
                    {billingPlans.length === 0 ? (
                      <p className="p-4 text-sm text-muted">No billing plans yet.</p>
                    ) : billingPlans.map((plan) => (
                      <div key={plan.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-border px-4 py-4 last:border-b-0">
                        <div className="min-w-0">
                          <p className="font-medium text-text-primary">{plan.name}</p>
                          <p className="mt-1 text-xs text-muted">{plan.description || intervalLabel(plan.billing_interval)}</p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {plan.programs.length ? plan.programs.map((program) => <ProgramChip key={program.program_id} program={program} />) : <span className="text-xs text-muted">No programs attached</span>}
                          </div>
                          {plan.pending_reason ? <p className="mt-2 text-xs text-warning">{plan.pending_reason}</p> : null}
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-medium text-text-primary">{formatMoney(plan.amount_cents, plan.currency)}</p>
                          <p className="text-xs text-muted">{intervalLabel(plan.billing_interval)}</p>
                          {(plan.signup_fee_cents || plan.trial_days) ? (
                            <p className="text-xs text-muted">
                              {plan.signup_fee_cents ? `${formatMoney(plan.signup_fee_cents, plan.currency)} signup` : null}
                              {plan.signup_fee_cents && plan.trial_days ? " / " : null}
                              {plan.trial_days ? `${plan.trial_days} day trial` : null}
                            </p>
                          ) : null}
                        </div>
                        <div className="max-w-[220px] text-right text-xs text-muted">
                          <p className="truncate">{plan.stripe_product_id || "No product"}</p>
                          <p className="truncate">{plan.stripe_price_id || "No price"}</p>
                          {(!plan.stripe_price_id || plan.stripe_sync_status === "pending" || plan.stripe_sync_status === "missing" || plan.stripe_sync_status === "error") ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              className="mt-2"
                              disabled={!canManageStudioBilling || isActionLoading}
                              isLoading={isLoadingAction(`plan-sync:${plan.id}`)}
                              onClick={() => void handlePlanSync(plan.id)}
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                              {isLoadingAction(`plan-sync:${plan.id}`) ? "Syncing..." : "Sync"}
                            </Button>
                          ) : null}
                        </div>
                        <div>
                          <StatusPill status={plan.status} />
                        </div>
                      </div>
                    ))}
                  </section>
                </div>
              ) : null}

              {activeTab === "families" ? (
                <div className="space-y-5">
                  <section className="border border-border bg-surface rounded-[6px] p-5">
                    <SectionHeader icon={Users} title="Family payer accounts" description="Payers are separate from student enrollment. A student can train actively even when billing is past due." />
                    <form onSubmit={handleCreatePayer} className="grid gap-3 md:grid-cols-[1fr_1fr_0.8fr_auto] md:items-end">
                      <Input label="Name" value={payerName} onChange={(event) => setPayerName(event.target.value)} placeholder="Family or payer name" disabled={!canManageStudioBilling} />
                      <Input label="Email" value={payerEmail} onChange={(event) => setPayerEmail(event.target.value)} placeholder="payer@example.com" disabled={!canManageStudioBilling} />
                      <Input label="Phone" value={payerPhone} onChange={(event) => setPayerPhone(event.target.value)} placeholder="Optional" disabled={!canManageStudioBilling} />
                      <Button type="submit" size="sm" disabled={!canManageStudioBilling || isActionLoading} isLoading={isLoadingAction("create-payer")}>
                        <Plus className="h-3.5 w-3.5" />
                        {isLoadingAction("create-payer") ? "Creating..." : "Create"}
                      </Button>
                    </form>
                  </section>

                  <section className="border border-border bg-surface rounded-[6px]">
                    <div className="grid grid-cols-[1.1fr_1fr_1fr_auto_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted">
                      <span>Payer</span>
                      <span>Contact</span>
                      <span>Stripe</span>
                      <span>Autopay</span>
                      <span>Actions</span>
                    </div>
                    {billingPayers.length === 0 ? (
                      <p className="p-4 text-sm text-muted">No payer accounts yet.</p>
                    ) : billingPayers.map((payer) => (
                      <div key={payer.id} className="grid grid-cols-[1.1fr_1fr_1fr_auto_auto] gap-4 border-b border-border px-4 py-4 text-sm last:border-b-0">
                        <div>
                          <p className="font-medium text-text-primary">{payer.display_name}</p>
                          <div className="mt-1"><StatusPill status={payer.billing_status} /></div>
                          <p className="mt-1 text-xs text-muted">{formatMoney(payer.balance_cents)}</p>
                        </div>
                        <div className="text-text-secondary">
                          <p>{payer.email || "No email"}</p>
                          <p className="text-xs text-muted">{payer.phone || "No phone"}</p>
                        </div>
                        <div className="min-w-0 text-xs text-muted">
                          <p className="truncate">{payer.stripe_customer_id || "No Stripe customer"}</p>
                          <p className="truncate">
                            {payer.stripe_payment_method_last4
                              ? `${payer.stripe_payment_method_brand || payer.stripe_payment_method_type || "card"} ending ${payer.stripe_payment_method_last4}`
                              : payer.stripe_payment_method_id
                                ? payer.stripe_payment_method_brand || payer.stripe_payment_method_type || "Saved payment method"
                                : "No payment method"}
                          </p>
                        </div>
                        <StatusPill status={payer.autopay_status} />
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button variant="secondary" size="sm" disabled={!canManageStudioBilling || isActionLoading} isLoading={isLoadingAction(`payer-sync:${payer.id}`)} onClick={() => void handlePayerSync(payer.id)}>
                            <RefreshCw className="h-3.5 w-3.5" />
                            {isLoadingAction(`payer-sync:${payer.id}`) ? "Syncing..." : "Sync"}
                          </Button>
                          <Button variant="secondary" size="sm" disabled={!canManageStudioBilling || isActionLoading} isLoading={isLoadingAction(`autopay-setup:${payer.id}`)} onClick={() => void handleAutopaySetup(payer.id)}>
                            <CreditCard className="h-3.5 w-3.5" />
                            {isLoadingAction(`autopay-setup:${payer.id}`) ? "Opening..." : "Setup"}
                          </Button>
                          <Button variant="ghost" size="sm" disabled={!canManageStudioBilling || isActionLoading || payer.autopay_status !== "enabled"} isLoading={isLoadingAction(`autopay-disable:${payer.id}`)} onClick={() => void handleAutopayDisable(payer.id)}>
                            {isLoadingAction(`autopay-disable:${payer.id}`) ? "Disabling..." : "Disable"}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </section>
                </div>
              ) : null}

              {activeTab === "enrollments" ? (
                <div className="space-y-5">
                  <section className="border border-border bg-surface rounded-[6px] p-5">
                    <SectionHeader icon={Users} title="Attach student billing" description="Connect an active student to a payer, plan, and collection mode without changing training status." />
                    <form onSubmit={handleCreateEnrollment} className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_0.8fr_0.7fr_0.7fr_0.7fr_auto] lg:items-end">
                      <div className="flex flex-col gap-1.5">
                        <label className="text-sm text-text-secondary font-medium" htmlFor="enrollment-student">Student</label>
                        <select
                          id="enrollment-student"
                          value={enrollmentStudentId}
                          onChange={(event) => setEnrollmentStudentId(event.target.value)}
                          disabled={!canManageStudioBilling || billingStudentOptions.length === 0}
                          className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
                        >
                          <option value="">Choose student</option>
                          {billingStudentOptions.map((student) => (
                            <option key={student.id} value={student.id}>{student.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-sm text-text-secondary font-medium" htmlFor="enrollment-payer">Payer</label>
                        <select
                          id="enrollment-payer"
                          value={enrollmentPayerId}
                          onChange={(event) => setEnrollmentPayerId(event.target.value)}
                          disabled={!canManageStudioBilling || billingPayers.length === 0}
                          className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
                        >
                          <option value="">Choose payer</option>
                          {billingPayers.map((payer) => (
                            <option key={payer.id} value={payer.id}>{payer.display_name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-sm text-text-secondary font-medium" htmlFor="enrollment-plan">Plan</label>
                        <select
                          id="enrollment-plan"
                          value={enrollmentPlanId}
                          onChange={(event) => setEnrollmentPlanId(event.target.value)}
                          disabled={!canManageStudioBilling || billingPlans.length === 0}
                          className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
                        >
                          <option value="">Choose plan</option>
                          {billingPlans.map((plan) => (
                            <option key={plan.id} value={plan.id}>{plan.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-sm text-text-secondary font-medium" htmlFor="collection-mode">Collect</label>
                        <select
                          id="collection-mode"
                          value={enrollmentCollectionMode}
                          onChange={(event) => setEnrollmentCollectionMode(event.target.value as StudentBillingEnrollment["collection_mode"])}
                          disabled={!canManageStudioBilling}
                          className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
                        >
                          <option value="autopay">Autopay</option>
                          <option value="invoice_link">Invoice link</option>
                          <option value="external">External</option>
                        </select>
                      </div>
                      <Input label="Start" type="date" value={enrollmentStartDate} onChange={(event) => setEnrollmentStartDate(event.target.value)} disabled={!canManageStudioBilling} />
                      <Input label="End" type="date" value={enrollmentEndDate} onChange={(event) => setEnrollmentEndDate(event.target.value)} disabled={!canManageStudioBilling} />
                      <Input label="Next bill" type="date" value={enrollmentNextBillDate} onChange={(event) => setEnrollmentNextBillDate(event.target.value)} disabled={!canManageStudioBilling} />
                      <Button type="submit" size="sm" disabled={!canManageStudioBilling || isActionLoading || billingPayers.length === 0 || billingPlans.length === 0} isLoading={isLoadingAction("create-enrollment")}>
                        <Plus className="h-3.5 w-3.5" />
                        {isLoadingAction("create-enrollment") ? "Attaching..." : "Attach"}
                      </Button>
                    </form>
                  </section>

                  <section className="border border-border bg-surface rounded-[6px]">
                    <div className="grid grid-cols-[1fr_1fr_0.8fr_1fr_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted">
                      <span>Student</span>
                      <span>Plan</span>
                      <span>Dates</span>
                      <span>Stripe refs</span>
                      <span>Actions</span>
                    </div>
                    {billingEnrollments.length === 0 ? (
                      <p className="p-4 text-sm text-muted">No billing enrollments yet.</p>
                    ) : billingEnrollments.map((enrollment) => (
                      <div key={enrollment.id} className="grid grid-cols-[1fr_1fr_0.8fr_1fr_auto] gap-4 border-b border-border px-4 py-4 text-sm last:border-b-0">
                        <div>
                          <p className="font-medium text-text-primary">{studentNameById.get(enrollment.student_id) || "Student"}</p>
                          <p className="text-xs text-muted">{payerNameById.get(enrollment.payer_id) || "Payer"}</p>
                          <div className="mt-1"><StatusPill status={enrollment.status} /></div>
                        </div>
                        <div>
                          <p className="text-text-primary">{planNameById.get(enrollment.plan_id) || "Plan"}</p>
                          <select
                            value={enrollment.collection_mode}
                            onChange={(event) => void handleEnrollmentModeUpdate(enrollment.id, event.target.value as StudentBillingEnrollment["collection_mode"])}
                            disabled={!canManageStudioBilling || isActionLoading}
                            className="mt-2 w-full rounded-[6px] border border-border bg-surface-raised px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
                          >
                            <option value="autopay">Autopay</option>
                            <option value="invoice_link">Invoice link</option>
                            <option value="external">External</option>
                          </select>
                        </div>
                        <div className="text-xs text-muted">
                          <p>Start {formatDate(enrollment.start_date)}</p>
                          <p>End {formatDate(enrollment.end_date)}</p>
                          <p>Next {formatDate(enrollment.next_bill_date)}</p>
                        </div>
                        <div className="min-w-0 text-xs text-muted">
                          <p className="truncate">{enrollment.stripe_subscription_id || "No subscription"}</p>
                          <p className="truncate">{enrollment.stripe_subscription_item_id || "No item"}</p>
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button variant="secondary" size="sm" disabled={!canManageStudioBilling || isActionLoading || enrollment.status === "paused"} isLoading={isLoadingAction(`enrollment:${enrollment.id}:pause`)} onClick={() => void handleEnrollmentAction(enrollment.id, "pause")}>
                            {isLoadingAction(`enrollment:${enrollment.id}:pause`) ? "Pausing..." : "Pause"}
                          </Button>
                          <Button variant="secondary" size="sm" disabled={!canManageStudioBilling || isActionLoading || enrollment.status !== "paused"} isLoading={isLoadingAction(`enrollment:${enrollment.id}:resume`)} onClick={() => void handleEnrollmentAction(enrollment.id, "resume")}>
                            {isLoadingAction(`enrollment:${enrollment.id}:resume`) ? "Resuming..." : "Resume"}
                          </Button>
                          <Button variant="ghost" size="sm" disabled={!canManageStudioBilling || isActionLoading || enrollment.status === "canceled"} isLoading={isLoadingAction(`enrollment:${enrollment.id}:cancel`)} onClick={() => void handleEnrollmentAction(enrollment.id, "cancel")}>
                            {isLoadingAction(`enrollment:${enrollment.id}:cancel`) ? "Canceling..." : "Cancel"}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </section>
                </div>
              ) : null}

              {activeTab === "invoices" ? (
                <div className="space-y-5">
                  <section className="border border-border bg-surface rounded-[6px] p-5">
                    <SectionHeader icon={Receipt} title="Create hosted invoice" description="Draft a one-off invoice and optionally send the Stripe hosted invoice link." />
                    <form onSubmit={handleCreateInvoice} className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_0.6fr_0.7fr_1fr_auto] lg:items-end">
                      <div className="flex flex-col gap-1.5">
                        <label className="text-sm text-text-secondary font-medium" htmlFor="invoice-payer">Payer</label>
                        <select
                          id="invoice-payer"
                          value={invoicePayerId}
                          onChange={(event) => {
                            setInvoicePayerId(event.target.value);
                            setInvoiceRequestKey(null);
                          }}
                          disabled={!canManageStudioBilling || billingPayers.length === 0}
                          className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
                        >
                          <option value="">Choose payer</option>
                          {billingPayers.map((payer) => (
                            <option key={payer.id} value={payer.id}>{payer.display_name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-sm text-text-secondary font-medium" htmlFor="invoice-enrollment">Enrollment</label>
                        <select
                          id="invoice-enrollment"
                          value={invoiceEnrollmentId}
                          onChange={(event) => {
                            setInvoiceEnrollmentId(event.target.value);
                            setInvoiceRequestKey(null);
                          }}
                          disabled={!canManageStudioBilling}
                          className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
                        >
                          <option value="">Optional</option>
                          {billingEnrollments.map((enrollment) => (
                            <option key={enrollment.id} value={enrollment.id}>
                              {(studentNameById.get(enrollment.student_id) || "Student")} / {planNameById.get(enrollment.plan_id) || "Plan"}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-sm text-text-secondary font-medium" htmlFor="invoice-student">Student</label>
                        <select
                          id="invoice-student"
                          value={invoiceStudentId}
                          onChange={(event) => {
                            setInvoiceStudentId(event.target.value);
                            setInvoiceRequestKey(null);
                          }}
                          disabled={!canManageStudioBilling}
                          className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
                        >
                          <option value="">Optional</option>
                          {billingStudentOptions.map((student) => (
                            <option key={student.id} value={student.id}>{student.name}</option>
                          ))}
                        </select>
                      </div>
                      <Input
                        label="Amount"
                        value={invoiceAmount}
                        onChange={(event) => {
                          setInvoiceAmount(event.target.value);
                          setInvoiceRequestKey(null);
                        }}
                        placeholder="129"
                        inputMode="decimal"
                        disabled={!canManageStudioBilling}
                      />
                      <Input
                        label="Due date"
                        type="date"
                        value={invoiceDueDate}
                        onChange={(event) => {
                          setInvoiceDueDate(event.target.value);
                          setInvoiceRequestKey(null);
                        }}
                        disabled={!canManageStudioBilling}
                      />
                      <Input
                        label="Memo"
                        value={invoiceDescription}
                        onChange={(event) => {
                          setInvoiceDescription(event.target.value);
                          setInvoiceRequestKey(null);
                        }}
                        placeholder="Optional"
                        disabled={!canManageStudioBilling}
                      />
                      <div className="flex items-center gap-3">
                        <label className="inline-flex items-center gap-2 text-sm text-text-secondary">
                          <input
                            type="checkbox"
                            checked={invoiceSendHosted}
                            onChange={(event) => {
                              setInvoiceSendHosted(event.target.checked);
                              setInvoiceRequestKey(null);
                            }}
                            disabled={!canManageStudioBilling}
                            className="accent-[#E5C15C]"
                          />
                          Send
                        </label>
                        <Button type="submit" size="sm" disabled={!canManageStudioBilling || isActionLoading || billingPayers.length === 0} isLoading={isLoadingAction("create-invoice")}>
                          <Plus className="h-3.5 w-3.5" />
                          {isLoadingAction("create-invoice") ? "Creating..." : "Create"}
                        </Button>
                      </div>
                    </form>
                  </section>

                  <section className="border border-border bg-surface rounded-[6px] p-5">
                    <SectionHeader icon={AlertTriangle} title="Failed payment queue" description="Follow up with families without changing the student's training status." />
                    {billingPayers.filter((payer) => payer.billing_status === "past_due" || payer.billing_status === "failed").length === 0 ? (
                      <p className="text-sm text-muted">No failed payer accounts right now.</p>
                    ) : (
                      <div className="divide-y divide-border border border-border rounded-[6px]">
                        {billingPayers.filter((payer) => payer.billing_status === "past_due" || payer.billing_status === "failed").map((payer) => (
                          <div key={payer.id} className="flex items-center justify-between gap-4 px-4 py-3">
                            <div>
                              <p className="font-medium text-text-primary">{payer.display_name}</p>
                              <p className="text-xs text-muted">{payer.email || "No email on file"}</p>
                            </div>
                            <div className="text-right">
                              <p className="font-medium text-danger">{formatMoney(payer.balance_cents)}</p>
                              <StatusPill status={payer.billing_status} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="border border-border bg-surface rounded-[6px]">
                    <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted">
                      <span>Invoice</span>
                      <span>Due</span>
                      <span>Amount</span>
                      <span>Status</span>
                      <span>Actions</span>
                    </div>
                    {billingInvoices.length === 0 ? (
                      <p className="p-4 text-sm text-muted">No invoices yet.</p>
                    ) : billingInvoices.map((invoice) => (
                      <div key={invoice.id} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 border-b border-border px-4 py-4 text-sm last:border-b-0">
                        <div>
                          <p className="font-medium text-text-primary">{invoice.invoice_type.replace(/_/g, " ")}</p>
                          <p className="text-xs text-muted">{invoice.external ? "External payment record" : invoice.number || invoice.stripe_invoice_id || "Draft invoice"}</p>
                          {invoice.hosted_invoice_url && !isPreviewMode ? (
                            <a className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline" href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">
                              Hosted invoice <ArrowUpRight className="h-3 w-3" />
                            </a>
                          ) : null}
                        </div>
                        <p className="text-text-secondary">{formatDate(invoice.due_date)}</p>
                        <p className="font-medium text-text-primary">{formatMoney(invoice.amount_due_cents, invoice.currency)}</p>
                        <StatusPill status={invoice.status} />
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button variant="secondary" size="sm" disabled={!canManageStudioBilling || isActionLoading || invoice.status !== "draft"} isLoading={isLoadingAction(`invoice:${invoice.id}:finalize`)} onClick={() => void handleInvoiceAction(invoice.id, "finalize")}>
                            {isLoadingAction(`invoice:${invoice.id}:finalize`) ? "Finalizing..." : "Finalize"}
                          </Button>
                          {invoice.hosted_invoice_url && !isPreviewMode ? (
                            <Button asChild variant="secondary" size="sm">
                              <a href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">
                                <ArrowUpRight className="h-3.5 w-3.5" />
                                Open
                              </a>
                            </Button>
                          ) : null}
                          <Button variant="secondary" size="sm" disabled={!canManageStudioBilling || isActionLoading || invoice.status !== "open"} isLoading={isLoadingAction(`invoice:${invoice.id}:retry`)} onClick={() => void handleInvoiceAction(invoice.id, "retry")}>
                            {isLoadingAction(`invoice:${invoice.id}:retry`) ? "Retrying..." : "Retry"}
                          </Button>
                          <Button variant="ghost" size="sm" disabled={!canManageStudioBilling || isActionLoading || invoice.status === "void" || invoice.status === "paid"} isLoading={isLoadingAction(`invoice:${invoice.id}:void`)} onClick={() => void handleInvoiceAction(invoice.id, "void")}>
                            {isLoadingAction(`invoice:${invoice.id}:void`) ? "Voiding..." : "Void"}
                          </Button>
                          <Button variant="ghost" size="sm" disabled={!canManageStudioBilling || isActionLoading || invoice.status !== "paid"} isLoading={isLoadingAction(`invoice:${invoice.id}:reconcile`)} onClick={() => void handleInvoiceAction(invoice.id, "reconcile")}>
                            {isLoadingAction(`invoice:${invoice.id}:reconcile`) ? "Reconciling..." : "Reconcile"}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </section>
                </div>
              ) : null}

              {activeTab === "reports" ? (
                <div className="space-y-5">
                  <div className="grid gap-4 md:grid-cols-3">
                    <Metric label="Stripe payments" value={formatMoney(stripePaymentTotal)} hint="Successful card or bank payments" />
                    <Metric label="External payments" value={formatMoney(externalPaymentTotal)} hint="Cash, check, Zelle, Venmo, or outside processors" />
                    <Metric label="Koaryu fee basis" value={formatMoney(koaryuFeeBasis)} hint="0.5% applies only to Stripe Connect charges" />
                  </div>

                  <section className="border border-border bg-surface rounded-[6px] p-5">
                    <SectionHeader icon={Download} title="Async exports" description="Large billing exports are queued instead of held in an in-memory browser request." />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" disabled={isActionLoading} isLoading={isLoadingAction("export:revenue")} onClick={() => void handleCreateExport("revenue")}>
                        <FileText className="h-3.5 w-3.5" />
                        {isLoadingAction("export:revenue") ? "Queueing..." : "Revenue CSV"}
                      </Button>
                      <Button size="sm" variant="secondary" disabled={isActionLoading} isLoading={isLoadingAction("export:invoices")} onClick={() => void handleCreateExport("invoices")}>
                        <FileText className="h-3.5 w-3.5" />
                        {isLoadingAction("export:invoices") ? "Queueing..." : "Invoice CSV"}
                      </Button>
                      <Button size="sm" variant="secondary" disabled={isActionLoading} isLoading={isLoadingAction("export:failed_payments")} onClick={() => void handleCreateExport("failed_payments")}>
                        <FileText className="h-3.5 w-3.5" />
                        {isLoadingAction("export:failed_payments") ? "Queueing..." : "Failed payments CSV"}
                      </Button>
                    </div>
                    {exportJobs.length ? (
                      <div className="mt-4 divide-y divide-border border border-border rounded-[6px]">
                        {exportJobs.map((job) => (
                          <div key={job.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                            <div>
                              <p className="font-medium text-text-primary">{job.export_type.replace(/_/g, " ")}</p>
                              <p className="text-xs text-muted">Queued {formatDate(job.created_at)}</p>
                            </div>
                            <StatusPill status={job.status} />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-3 text-xs text-muted">No exports queued in this session.</p>
                    )}
                  </section>

                  <section className="border border-border bg-surface rounded-[6px] p-5">
                    <SectionHeader icon={Banknote} title="Record external payment" description="Track cash, check, Zelle, Venmo, or outside-processor payments without charging a Koaryu platform fee." />
                    <form onSubmit={handleRecordExternalPayment} className="grid gap-3 md:grid-cols-[1fr_0.6fr_0.7fr_1fr_auto] md:items-end">
                      <div className="flex flex-col gap-1.5">
                        <label className="text-sm text-text-secondary font-medium" htmlFor="external-payer">Payer</label>
                        <select
                          id="external-payer"
                          value={externalPayerId}
                          onChange={(event) => setExternalPayerId(event.target.value)}
                          disabled={!canManageStudioBilling || billingPayers.length === 0}
                          className="w-full rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
                        >
                          <option value="">Choose payer</option>
                          {billingPayers.map((payer) => (
                            <option key={payer.id} value={payer.id}>{payer.display_name}</option>
                          ))}
                        </select>
                      </div>
                      <Input label="Amount" value={externalAmount} onChange={(event) => setExternalAmount(event.target.value)} placeholder="129" inputMode="decimal" disabled={!canManageStudioBilling} />
                      <Input label="Method" value={externalMethod} onChange={(event) => setExternalMethod(event.target.value)} placeholder="Zelle" disabled={!canManageStudioBilling} />
                      <Input label="Note" value={externalNote} onChange={(event) => setExternalNote(event.target.value)} placeholder="Optional" disabled={!canManageStudioBilling} />
                      <Button type="submit" size="sm" disabled={!canManageStudioBilling || isActionLoading || billingPayers.length === 0} isLoading={isLoadingAction("record-external")}>
                        <Plus className="h-3.5 w-3.5" />
                        {isLoadingAction("record-external") ? "Recording..." : "Record"}
                      </Button>
                    </form>
                  </section>

                  <section className="border border-border bg-surface rounded-[6px]">
                    <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted">
                      <span>Payment</span>
                      <span>Amount</span>
                      <span>Status</span>
                    </div>
                    {billingPayments.length === 0 ? (
                      <p className="p-4 text-sm text-muted">No payments recorded yet.</p>
                    ) : billingPayments.map((payment) => (
                      <div key={payment.id} className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-border px-4 py-4 text-sm last:border-b-0">
                        <div>
                          <p className="font-medium text-text-primary">{payment.external_method || payment.payment_method_type || "Payment"}</p>
                          <p className="text-xs text-muted">{payment.note || formatDate(payment.processed_at)}</p>
                        </div>
                        <p className="font-medium text-text-primary">{formatMoney(payment.amount_cents, payment.currency)}</p>
                        <StatusPill status={payment.status} />
                      </div>
                    ))}
                  </section>
                </div>
              ) : null}

              <section className="border border-border bg-surface rounded-[6px] p-4">
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                  <CheckCircle2 className="h-4 w-4 text-success" />
                  <span>No student-count pricing. No staff-count pricing. No feature gates.</span>
                  <Clock3 className="h-4 w-4 text-warning" />
                  <span>Soft student alert at 1,500 active students, with no database lockout.</span>
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
