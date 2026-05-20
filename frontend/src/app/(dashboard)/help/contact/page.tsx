"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Bug, CheckCircle2, LifeBuoy, Mail, Send } from "lucide-react";
import { AccountNotice, AccountPageShell, AccountSection } from "@/components/account-page-shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useConfigStore } from "@/lib/store";
import { useStudioStore } from "@/lib/store";
import type { SupportTicket, SupportTicketSeverity, SupportTicketTopic } from "@/types";

function encodeMailto(subject: string, body: string) {
  return `mailto:support@koaryu.app?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

const topicOptions: { value: SupportTicketTopic; label: string }[] = [
  { value: "billing", label: "Billing or payments" },
  { value: "account_access", label: "Login or account access" },
  { value: "student_records", label: "Student records" },
  { value: "bug_report", label: "Bug report" },
  { value: "product_question", label: "Product question" },
  { value: "other", label: "Other" },
];

const severityOptions: { value: SupportTicketSeverity; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
  { value: "low", label: "Low" },
];

function initialTopic() {
  if (typeof window === "undefined") return "billing";
  const topic = new URLSearchParams(window.location.search).get("topic");
  return topic === "bug" ? "bug_report" : "billing";
}

export default function ContactSupportPage() {
  const searchParams = useSearchParams();
  const { token } = useConfigStore();
  const { studioName, userEmail, userName } = useStudioStore();
  const [topic, setTopic] = useState<SupportTicketTopic>(() => initialTopic() as SupportTicketTopic);
  const [severity, setSeverity] = useState<SupportTicketSeverity>("normal");
  const [subject, setSubject] = useState("");
  const [details, setDetails] = useState("");
  const [createdTicket, setCreatedTicket] = useState<SupportTicket | null>(null);
  const [recentTickets, setRecentTickets] = useState<SupportTicket[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const pageContext = useMemo(() => {
    if (typeof window === "undefined") {
      return {
        pageUrl: "",
        path: "",
        search: "",
        viewport: "",
        userAgent: "",
      };
    }

    return {
      pageUrl: window.location.href,
      path: window.location.pathname,
      search: window.location.search,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (searchParams.get("topic") === "bug") {
        setTopic("bug_report");
      }
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchParams]);

  useEffect(() => {
    if (!token) return;

    const controller = new AbortController();
    api
      .get<SupportTicket[]>("/support/tickets", token, { signal: controller.signal })
      .then(setRecentTickets)
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
      });

    return () => {
      controller.abort();
    };
  }, [token]);

  const mailto = useMemo(() => {
    const selectedTopic = topicOptions.find((option) => option.value === topic)?.label || "Support";
    const emailSubject = `Koaryu support: ${subject || selectedTopic}`;
    const body = [
      `Name: ${userName || ""}`,
      `Email: ${userEmail || ""}`,
      `Studio: ${studioName || ""}`,
      `Topic: ${selectedTopic}`,
      `Severity: ${severity}`,
      "",
      "What happened?",
      details,
      "",
      "Page or workflow:",
      pageContext.pageUrl,
      "Expected result:",
      "",
      "Actual result:",
      "",
      "Browser context:",
      `Path: ${pageContext.path}${pageContext.search}`,
      `Viewport: ${pageContext.viewport}`,
      `User agent: ${pageContext.userAgent}`,
    ].join("\n");
    return encodeMailto(emailSubject, body);
  }, [details, pageContext, severity, studioName, subject, topic, userEmail, userName]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) {
      setFormError("You need to be signed in to send support requests.");
      return;
    }

    setIsSubmitting(true);
    setFormError("");
    setCreatedTicket(null);

    try {
      const ticket = await api.post<SupportTicket>(
        "/support/tickets",
        {
          topic,
          severity,
          subject,
          details,
          page_url: typeof window === "undefined" ? null : window.location.href,
          user_agent: typeof navigator === "undefined" ? null : navigator.userAgent,
          browser_context: typeof window === "undefined"
            ? {}
            : {
                path: window.location.pathname,
                search: window.location.search,
                viewport: `${window.innerWidth}x${window.innerHeight}`,
              },
        },
        token,
        {
          timeoutMessage: "Support request timed out. Your details are still here, so you can retry.",
          networkErrorMessage: "Could not reach support. You can open an email draft instead.",
        }
      );
      setCreatedTicket(ticket);
      setRecentTickets((current) => [ticket, ...current.filter((item) => item.id !== ticket.id)].slice(0, 5));
      setDetails("");
      setSubject("");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not send support request.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AccountPageShell
      title="Contact support"
      description="Send a focused support note with the context needed to resolve it quickly."
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <AccountSection title="Support request">
          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-text-primary">Topic</span>
              <select
                value={topic}
                onChange={(event) => setTopic(event.target.value as SupportTicketTopic)}
                className="px-3 py-2 text-sm"
              >
                {topicOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-text-primary">Subject</span>
                <input
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  placeholder="Short summary"
                  className="px-3 py-2 text-sm"
                  minLength={3}
                  maxLength={160}
                  required
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-text-primary">Priority</span>
                <select
                  value={severity}
                  onChange={(event) => setSeverity(event.target.value as SupportTicketSeverity)}
                  className="px-3 py-2 text-sm"
                >
                  {severityOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <label id="bug" className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-text-primary">Details</span>
              <textarea
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                placeholder="What were you trying to do? What happened instead?"
                className="min-h-32 px-3 py-2 text-sm"
                minLength={10}
                maxLength={5000}
                required
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" isLoading={isSubmitting} disabled={isSubmitting}>
                <Send className="h-3.5 w-3.5" />
                {isSubmitting ? "Sending..." : "Send request"}
              </Button>
              <Button asChild variant="secondary" size="sm">
                <a href={mailto}>
                  <Mail className="h-3.5 w-3.5" />
                  Open email draft
                </a>
              </Button>
            </div>
            {createdTicket && (
              <div className="flex items-start gap-3 rounded-[6px] border border-success/25 bg-success/10 p-3 text-sm text-text-secondary">
                <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-success" />
                <p>
                  Support request sent. Reference{" "}
                  <span className="font-mono text-text-primary">{createdTicket.id.slice(0, 8)}</span>.
                </p>
              </div>
            )}
            {formError && <p className="text-sm text-danger">{formError}</p>}
          </form>
        </AccountSection>

        <AccountSection title="What to include">
          <div className="space-y-4 text-sm text-text-secondary">
            <div className="flex gap-3">
              <LifeBuoy className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent" />
              <p>For account issues, include the login email and studio name.</p>
            </div>
            <div className="flex gap-3">
              <Mail className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent" />
              <p>For billing, include payer name, invoice number, and visible Stripe status if available.</p>
            </div>
            <div className="flex gap-3">
              <Bug className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent" />
              <p>For bugs, include steps to reproduce and a screenshot when possible.</p>
            </div>
          </div>
        </AccountSection>
      </div>

      <AccountNotice>
        Koaryu saves support requests with your studio, login email, page context, and browser details so follow-up can
        happen without making you re-explain the workflow.
      </AccountNotice>

      <AccountSection title="Recent support requests" description="Use this as a lightweight ticket inbox while support tooling is still early.">
        {recentTickets.length > 0 ? (
          <div className="divide-y divide-border border-t border-b border-border">
            {recentTickets.slice(0, 5).map((ticket) => (
              <div key={ticket.id} className="grid gap-2 py-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0">
                  <p className="truncate font-medium text-text-primary">{ticket.subject}</p>
                  <p className="text-xs text-muted">
                    {topicOptions.find((option) => option.value === ticket.topic)?.label || ticket.topic}{" | "}
                    {new Date(ticket.created_at).toLocaleDateString()}
                  </p>
                </div>
                <span className="rounded-[4px] border border-border px-2 py-1 text-xs text-text-secondary">
                  {formatTicketStatus(ticket.status)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-secondary">No support requests have been created from this account yet.</p>
        )}
      </AccountSection>
    </AccountPageShell>
  );
}

function formatTicketStatus(status: SupportTicket["status"]) {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
