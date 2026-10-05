import { api } from "@/lib/api";
import type {
  ApiMissedClassActivityResponse,
  ApiMissedClassPreviewRequest,
  ApiMissedClassPreviewResponse,
  ApiMissedClassRuleResponse,
  ApiMissedClassRuleUpdate,
  ApiMissedClassSettingsResponse,
} from "@/types/generated/api-contracts";

export type MissedClassPreviewRequest = ApiMissedClassPreviewRequest;
export type MissedClassRuleResponse = ApiMissedClassRuleResponse;
export type MissedClassRuleUpdate = ApiMissedClassRuleUpdate;
export type MissedClassSettingsResponse = ApiMissedClassSettingsResponse;
export type MissedClassPreviewResponse = ApiMissedClassPreviewResponse;
export type MissedClassActivityResponse = ApiMissedClassActivityResponse;

export const ACTIVITY_LABELS = {
  queued: "Queued",
  claimed: "Preparing to send",
  sending: "Sending",
  accepted: "Accepted by email provider",
  retry_wait: "Waiting to retry",
  failed: "Failed",
  unknown: "Outcome unknown",
  skipped: "Skipped",
} as const satisfies Record<MissedClassActivityResponse["items"][number]["state"], string>;

const ROOT = "/automations/missed-class";
export const missedClassApi = {
  settings: (token: string, signal?: AbortSignal) =>
    api.get<MissedClassSettingsResponse>(ROOT, token, { signal }),
  preview: (draft: MissedClassPreviewRequest, token: string, signal?: AbortSignal) =>
    api.post<MissedClassPreviewResponse>(`${ROOT}/preview`, draft, token, { signal }),
  save: (rule: MissedClassRuleUpdate, token: string, signal?: AbortSignal) =>
    api.put<MissedClassSettingsResponse>(ROOT, rule, token, { signal }),
  activity: (token: string, signal?: AbortSignal) =>
    api.get<MissedClassActivityResponse>(`${ROOT}/activity?limit=50`, token, { signal }),
};

export function ruleDraft(rule: MissedClassPreviewRequest): MissedClassPreviewRequest {
  return {
    inactivity_days: rule.inactivity_days,
    subject_template: rule.subject_template,
    body_template: rule.body_template,
    reply_to_email: rule.reply_to_email,
  };
}

export const TEMPLATE_PLACEHOLDERS = [
  "{{student_first_name}}",
  "{{studio_name}}",
  "{{days_absent}}",
] as const;

export function draftError(draft: MissedClassPreviewRequest): string | null {
  if (
    !Number.isInteger(draft.inactivity_days) ||
    draft.inactivity_days < 1 ||
    draft.inactivity_days > 90
  )
    return "Choose an attendance gap from 1 to 90 days.";
  if (!draft.subject_template.trim() || draft.subject_template.length > 200)
    return "Enter a subject of 1 to 200 characters.";
  if (!draft.body_template.trim() || draft.body_template.length > 5000)
    return "Enter a message of 1 to 5,000 characters.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.reply_to_email))
    return "Enter a valid reply-to email address.";
  return null;
}

export function safeReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

export const DEMO_SETTINGS: MissedClassSettingsResponse = {
  rule: {
    enabled: false,
    inactivity_days: 14,
    subject_template: "We miss seeing {{student_first_name}} at {{studio_name}}",
    body_template:
      "Hello,\n\nWe have missed seeing {{student_first_name}} at {{studio_name}}. Reply if we can help with getting back to class or updating our records.\n\n{{studio_name}}",
    reply_to_email: "studio@example.test",
    revision: 0,
    updated_at: null,
  },
  delivery_status: {
    mode: "disabled",
    configured: false,
    can_enable: false,
    sender: "sample@example.test",
    test_recipient: null,
    reason: "sending_disabled",
  },
};

export function demoPreview(draft: MissedClassPreviewRequest): MissedClassPreviewResponse {
  const lastAttendance = new Date("2026-10-04T12:00:00Z");
  lastAttendance.setUTCDate(lastAttendance.getUTCDate() - draft.inactivity_days - 2);
  const render = (text: string) =>
    text
      .replaceAll("{{student_first_name}}", "Alex")
      .replaceAll("{{studio_name}}", "Sample studio")
      .replaceAll("{{days_absent}}", String(draft.inactivity_days + 2));
  return {
    reference_date: "2026-10-04",
    eligible_count: 1,
    skipped_count: 1,
    truncated: false,
    recipients: [
      {
        student_id: "sample-alex",
        student_name: "Alex Rivera",
        last_attendance_date: lastAttendance.toISOString().slice(0, 10),
        days_absent: draft.inactivity_days + 2,
        recipient_name: "Jamie Rivera",
        recipient_email: "jamie@example.test",
        recipient_kind: "guardian",
        skip_reason: null,
        rendered_subject: render(draft.subject_template),
        rendered_body: render(draft.body_template),
      },
      {
        student_id: "sample-sam",
        student_name: "Sam Chen",
        last_attendance_date: null,
        days_absent: null,
        recipient_name: null,
        recipient_email: null,
        recipient_kind: null,
        skip_reason: "never_attended",
        rendered_subject: null,
        rendered_body: null,
      },
    ],
  };
}

export const DEMO_ACTIVITY: MissedClassActivityResponse = {
  items: [
    {
      id: "sample-activity",
      student_id: "sample-alex",
      student_name: "Alex Rivera",
      recipient_email: "jamie@example.test",
      state: "accepted",
      created_at: "2026-10-03T10:00:00Z",
      attempted_at: "2026-10-03T10:00:01Z",
      settled_at: "2026-10-03T10:00:02Z",
      attempts: 1,
      reason: null,
    },
  ],
  has_more: false,
};
