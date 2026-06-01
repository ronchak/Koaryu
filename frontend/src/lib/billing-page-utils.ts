import type { BillingPlan } from "@/types";

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

export function formatMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function formatDate(value?: string | null) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

export function intervalLabel(interval: BillingPlan["billing_interval"]) {
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

export function requirementGroupItems(requirementsDue: string[]) {
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

export function connectReturnUrl() {
  return `${window.location.origin}/billing?connect=return`;
}

export function connectRefreshUrl() {
  return `${window.location.origin}/billing/connect/refresh`;
}

export function statusTone(status: string) {
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
