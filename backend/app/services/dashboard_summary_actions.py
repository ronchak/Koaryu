from app.schemas.dashboard_summary import (
    DashboardSummaryAction,
    DashboardSummaryBeltCounts,
    DashboardSummaryBillingCounts,
    DashboardSummaryInactivityCounts,
    DashboardSummaryLeadCounts,
    DashboardSummaryScheduleCounts,
    DashboardSummaryTestReadinessCounts,
)


def format_dashboard_count(count: int, singular: str, plural: str | None = None) -> str:
    return f"{count} {singular if count == 1 else plural or singular + 's'}"


def build_dashboard_summary_actions(
    *,
    lead_counts: DashboardSummaryLeadCounts,
    schedule_counts: DashboardSummaryScheduleCounts,
    belt_counts: DashboardSummaryBeltCounts,
    inactivity_counts: DashboardSummaryInactivityCounts,
    test_readiness: DashboardSummaryTestReadinessCounts,
    billing_counts: DashboardSummaryBillingCounts,
    today_label: str,
) -> list[DashboardSummaryAction]:
    actions: list[DashboardSummaryAction] = []

    if lead_counts.due_today_leads > 0:
        actions.append(DashboardSummaryAction(
            id="lead-followups",
            title=f"Follow up with {format_dashboard_count(lead_counts.due_today_leads, 'lead')}",
            description="These prospects are due today. Handle them before the next class block gets busy.",
            href="/leads",
            tone="accent",
            meta="Today",
        ))
    elif lead_counts.active_leads == 0:
        actions.append(DashboardSummaryAction(
            id="first-lead",
            title="Add your first lead",
            description="Track a trial student or parent inquiry so follow-ups do not live in someone's memory.",
            href="/leads",
            tone="accent",
        ))

    if schedule_counts.today_sessions > 0:
        actions.append(DashboardSummaryAction(
            id="today-classes",
            title=f"Check in {format_dashboard_count(schedule_counts.today_sessions, 'class', 'classes')}",
            description="Open today's schedule, mark attendance, and keep promotion progress accurate.",
            href="/schedule",
            tone="warning",
            meta=today_label,
        ))

    if test_readiness.ready_to_test and test_readiness.ready_to_test > 0:
        actions.append(DashboardSummaryAction(
            id="ready-to-promote",
            title=f"Review {format_dashboard_count(test_readiness.ready_to_test, 'student')} ready to promote",
            description="These students meet the configured class, time, and approval rules for their next rank.",
            href="/belt-tracker",
            tone="success",
            meta=f"{test_readiness.needs_approval or 0} approvals",
        ))
    elif belt_counts.belt_count == 0:
        actions.append(DashboardSummaryAction(
            id="belt-system",
            title="Set up your belt system",
            description="Add ranks and promotion rules before your first test cycle arrives.",
            href="/belt-tracker",
            tone="success",
        ))

    if inactivity_counts.watch_14 > 0:
        actions.append(DashboardSummaryAction(
            id="students-going-quiet",
            title=f"Reach out to {format_dashboard_count(inactivity_counts.watch_14, 'student')} going quiet",
            description="They have crossed 14 days without attendance and are not currently on hold.",
            href="/students?inactiveDays=14",
            tone="warning",
        ))

    if billing_counts.can_view_billing and billing_counts.payment_attention_count:
        actions.append(DashboardSummaryAction(
            id="payment-issues",
            title=f"Fix {format_dashboard_count(billing_counts.payment_attention_count, 'tuition issue')}",
            description="Review failed payments, past-due families, and invoices that need manual attention.",
            href="/billing",
            tone="danger",
        ))
    elif billing_counts.can_view_billing and billing_counts.payments_ready is False:
        actions.append(DashboardSummaryAction(
            id="payments-setup",
            title="Finish payment setup",
            description="Create tuition plans or finish Stripe Connect when you are ready to collect through Koaryu.",
            href="/billing",
            tone="neutral",
        ))

    return actions[:5]
