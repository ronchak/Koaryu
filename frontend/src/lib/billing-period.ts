type BillingPeriodSource = {
  status?: string | null;
  comped?: boolean;
  trial_end?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
};

const BILLING_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatBillingDate(value?: string | null) {
  if (!value) return "Not set";

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = dateOnlyMatch
    ? new Date(Date.UTC(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3])))
    : new Date(value);

  if (Number.isNaN(date.getTime())) return "Not set";

  return BILLING_DATE_FORMATTER.format(date);
}

export function subscriptionPeriodCopy(platform?: BillingPeriodSource | null) {
  if (!platform) {
    return {
      label: "Current period",
      value: "Admins manage subscription",
    };
  }

  if (platform.comped || platform.status === "comped") {
    return {
      label: "Current period",
      value: "Comped account",
    };
  }

  if (platform.cancel_at_period_end && platform.current_period_end) {
    return {
      label: "Current period",
      value: `Access ends ${formatBillingDate(platform.current_period_end)}`,
    };
  }

  if (platform.status === "trialing" && platform.trial_end) {
    return {
      label: "Trial period",
      value: `Trial ends ${formatBillingDate(platform.trial_end)}`,
    };
  }

  if ((platform.status === "active" || platform.status === "trialing") && platform.current_period_end) {
    return {
      label: "Current period",
      value: `Renews ${formatBillingDate(platform.current_period_end)}`,
    };
  }

  return {
    label: platform.status === "trialing" ? "Trial period" : "Current period",
    value: "Dates pending from Stripe",
  };
}
