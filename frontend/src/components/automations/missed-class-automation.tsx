"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, CommandOutcomeUnknown } from "@/lib/api";
import { useConfigStore, useStudioStore } from "@/lib/store";
import { useRetainedState } from "@/lib/retained-state";
import {
  ACTIVITY_LABELS,
  DEMO_ACTIVITY,
  DEMO_SETTINGS,
  TEMPLATE_PLACEHOLDERS,
  demoPreview,
  draftError,
  missedClassApi,
  ruleDraft,
  safeReason,
  type MissedClassActivityResponse,
  type MissedClassPreviewRequest,
  type MissedClassPreviewResponse,
  type MissedClassSettingsResponse,
} from "@/lib/missed-class-automation";

const fieldClass =
  "mt-1 min-h-11 w-full min-w-0 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary disabled:opacity-60";
const readinessReasons: Record<string, string> = {
  setup_required: "Email setup is still needed. You can save a paused rule now.",
  sending_disabled: "Email sending is switched off. You can save a paused rule now.",
  authentication_required: "The sending mailbox needs to be connected again.",
  unavailable: "Email readiness is unavailable. Refresh settings before enabling.",
};

export function MissedClassAutomation() {
  const { token, isPreviewMode } = useConfigStore();
  const { currentRole, currentStudioId, currentUserId, identityGeneration, identityReady } =
    useStudioStore();

  if (!identityReady)
    return (
      <p className="p-5 text-sm text-muted" role="status">
        Checking studio access...
      </p>
    );
  if (currentRole !== "admin")
    return (
      <p className="p-5 text-sm text-text-secondary">
        An Admin can set up missed-class emails and view recipients.
      </p>
    );
  if (!isPreviewMode && (!currentStudioId || !currentUserId))
    return (
      <p className="p-5 text-sm text-muted" role="status">
        Waiting for your studio...
      </p>
    );

  return (
    <ScopedEditor
      key={JSON.stringify([isPreviewMode, currentStudioId, currentUserId, identityGeneration])}
      token={token}
      isDemo={isPreviewMode}
    />
  );
}

function ScopedEditor({ token, isDemo }: { token: string | null; isDemo: boolean }) {
  const [settings, setSettings] = useRetainedState<MissedClassSettingsResponse | null>(
    `automations:missed-class:settings:${isDemo ? "preview" : "live"}`,
    isDemo ? DEMO_SETTINGS : null,
  );
  const [draft, setDraft] = useState<MissedClassPreviewRequest | null>(() =>
    settings ? ruleDraft(settings.rule) : null,
  );
  const [settingsLoading, setSettingsLoading] = useState(!isDemo);
  const [reloading, setReloading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [activity, setActivity] = useRetainedState<MissedClassActivityResponse | null>(
    `automations:missed-class:activity:${isDemo ? "preview" : "live"}`,
    isDemo ? DEMO_ACTIVITY : null,
  );
  const [activityLoading, setActivityLoading] = useState(!isDemo);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MissedClassPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [needsReadback, setNeedsReadback] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const latestToken = useRef(token);
  const lifetime = useRef<AbortController | null>(null);
  const draftRef = useRef(draft);
  const draftGeneration = useRef(0);
  const previewGeneration = useRef<number | null>(null);
  const previewRequest = useRef(0);
  const settingsRequest = useRef(0);
  const activityRequest = useRef(0);
  const mutationLock = useRef(false);
  const settingsLock = useRef(false);
  const readbackLock = useRef(false);

  useLayoutEffect(() => {
    latestToken.current = token;
  }, [token]);

  const invalidatePreview = useCallback(() => {
    draftGeneration.current += 1;
    previewRequest.current += 1;
    previewGeneration.current = null;
    setPreview(null);
    setPreviewLoading(false);
    setPreviewError(null);
  }, []);

  const loadSettings = useCallback(
    async (replaceDraft = false) => {
      if (isDemo || mutationLock.current || settingsLock.current) return;
      const controller = lifetime.current;
      if (!controller || controller.signal.aborted) return;
      const request = ++settingsRequest.current;
      settingsLock.current = true;
      setSettingsLoading(true);
      setReloading(replaceDraft);
      setSettingsError(null);
      invalidatePreview();
      try {
        if (!latestToken.current)
          throw new Error("Your session is not ready. Refresh settings after signing in.");
        const result = await missedClassApi.settings(latestToken.current, controller.signal);
        if (controller.signal.aborted || request !== settingsRequest.current) return;
        setSettings(result);
        if (replaceDraft || draftRef.current === null) {
          draftRef.current = ruleDraft(result.rule);
          setDraft(draftRef.current);
        }
        if (readbackLock.current) {
          setMessage(
            `Saved rule checked. It is ${result.rule.enabled ? "enabled" : "paused"}. Your draft is still here; review it before saving again.`,
          );
          setActionError(null);
        }
        readbackLock.current = false;
        setNeedsReadback(false);
      } catch (error) {
        if (!controller.signal.aborted && request === settingsRequest.current)
          setSettingsError(
            error instanceof Error ? error.message : "Settings could not be loaded.",
          );
      } finally {
        if (!controller.signal.aborted && request === settingsRequest.current) {
          settingsLock.current = false;
          setSettingsLoading(false);
          setReloading(false);
        }
      }
    },
    [invalidatePreview, isDemo, setSettings],
  );

  const loadActivity = useCallback(async () => {
    if (isDemo) return;
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) return;
    const request = ++activityRequest.current;
    setActivityLoading(true);
    setActivityError(null);
    try {
      if (!latestToken.current)
        throw new Error("Your session is not ready. Refresh activity after signing in.");
      const result = await missedClassApi.activity(latestToken.current, controller.signal);
      if (!controller.signal.aborted && request === activityRequest.current) setActivity(result);
    } catch (error) {
      if (!controller.signal.aborted && request === activityRequest.current)
        setActivityError(error instanceof Error ? error.message : "Activity could not be loaded.");
    } finally {
      if (!controller.signal.aborted && request === activityRequest.current)
        setActivityLoading(false);
    }
  }, [isDemo, setActivity]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    settingsLock.current = false;
    void loadSettings();
    void loadActivity();
    return () => {
      controller.abort();
    };
  }, [loadSettings, loadActivity]);

  function edit(patch: Partial<MissedClassPreviewRequest>) {
    if (!draftRef.current || mutationLock.current || reloading) return;
    draftRef.current = { ...draftRef.current, ...patch };
    setDraft(draftRef.current);
    invalidatePreview();
    setMessage(null);
    if (!readbackLock.current) setActionError(null);
  }

  async function requestPreview() {
    const submitted = draftRef.current;
    const controller = lifetime.current;
    if (!submitted || mutationLock.current || !controller || controller.signal.aborted) return;
    const validation = draftError(submitted);
    if (validation) {
      setPreviewError(validation);
      return;
    }
    const generation = draftGeneration.current;
    const request = ++previewRequest.current;
    previewGeneration.current = null;
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      if (!isDemo && !latestToken.current) throw new Error("Your session is not ready.");
      const result = isDemo
        ? demoPreview(submitted)
        : await missedClassApi.preview(submitted, latestToken.current!, controller.signal);
      if (
        controller.signal.aborted ||
        generation !== draftGeneration.current ||
        request !== previewRequest.current
      )
        return;
      previewGeneration.current = generation;
      setPreview(result);
    } catch (error) {
      if (!controller.signal.aborted && request === previewRequest.current)
        setPreviewError(
          error instanceof ApiError && error.status < 500
            ? `${error.message} No email was sent.`
            : "Recipient preview could not be loaded. No email was sent. Try previewing again.",
        );
    } finally {
      if (!controller.signal.aborted && request === previewRequest.current)
        setPreviewLoading(false);
    }
  }

  async function save(action: "save" | "enable" | "pause") {
    const currentDraft = draftRef.current;
    const controller = lifetime.current;
    if (
      isDemo ||
      !settings ||
      !currentDraft ||
      !controller ||
      controller.signal.aborted ||
      mutationLock.current ||
      settingsLock.current ||
      readbackLock.current
    )
      return;
    // Pausing keeps the saved message and leaves any unsaved edits in the editor.
    const submitted = action === "pause" ? ruleDraft(settings.rule) : { ...currentDraft };
    const enabled = action === "enable" || (action === "save" && settings.rule.enabled);
    const validation = action === "pause" ? null : draftError(submitted);
    if (validation) {
      setActionError(validation);
      return;
    }
    if (
      enabled &&
      (!settings.delivery_status.can_enable ||
        previewGeneration.current !== draftGeneration.current)
    )
      return;
    if (!latestToken.current) {
      setActionError("Your session is not ready. Refresh settings after signing in.");
      return;
    }
    mutationLock.current = true;
    setSaving(true);
    setActionError(null);
    setMessage(null);
    try {
      const result = await missedClassApi.save(
        { ...submitted, enabled, expected_revision: settings.rule.revision },
        latestToken.current,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setSettings(result);
      if (action !== "pause") {
        draftRef.current = ruleDraft(result.rule);
        setDraft(draftRef.current);
      }
      invalidatePreview();
      setMessage(
        action === "pause"
          ? "Automation paused. Unsaved message edits are still in the editor."
          : enabled
            ? "Rule saved and enabled. Eligible recipients will be checked on the next scheduled run."
            : "Paused rule saved. No email will be sent while it is paused.",
      );
      void loadActivity();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (
        error instanceof CommandOutcomeUnknown ||
        (error instanceof ApiError && error.status === 409)
      ) {
        readbackLock.current = true;
        setNeedsReadback(true);
        invalidatePreview();
        setActionError(
          error instanceof CommandOutcomeUnknown
            ? "We could not confirm whether the rule was saved. Check the saved rule before making another change. Your draft is preserved."
            : "This rule changed elsewhere. Check the saved rule before making another change. Your draft is preserved.",
        );
      } else
        setActionError(
          error instanceof Error
            ? error.message
            : "The rule could not be saved. Your draft is preserved.",
        );
    } finally {
      if (!controller.signal.aborted) {
        mutationLock.current = false;
        setSaving(false);
      }
    }
  }

  const ready = settings?.delivery_status;
  const invalidDraft = draft ? draftError(draft) : null;
  const writeBlocked = isDemo || saving || settingsLoading || needsReadback || !token;
  const enableBlocked = writeBlocked || !ready?.can_enable || !preview || !!invalidDraft;
  const sample = preview?.recipients.find(
    (recipient) => !recipient.skip_reason && recipient.rendered_subject !== null,
  );

  return (
    <section
      aria-labelledby="missed-class-title"
      className="min-w-0 space-y-5 p-5 sm:p-6"
      data-automation-sheet="true"
      data-missed-class-editor="true"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-accent">Attendance follow-up</p>
          <h2 id="missed-class-title" className="mt-1 text-xl font-semibold text-text-primary">
            Missed-class nudges
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
            Send a friendly check-in after time away from class. Each student receives one message
            per absence period. A return to class starts a new period.
          </p>
        </div>
        <span className="rounded-full bg-surface-raised px-3 py-1 text-xs font-semibold text-text-primary">
          {isDemo
            ? "Sample data"
            : settings
              ? settings.rule.enabled
                ? "Enabled"
                : "Paused"
              : "Rule status"}
        </span>
      </div>

      <div
        className={`space-y-5 ${!settings && settingsLoading ? "koaryu-skeleton-reveal" : ""}`}
        aria-busy={settingsLoading}
      >
        {isDemo ? (
          <p
            className="rounded-md border border-border p-3 text-sm text-text-secondary"
            role="status"
          >
            Demo only. Try editing and previewing with sample students. Nothing is saved or sent,
            and this rule cannot be enabled.
          </p>
        ) : (
          <div
            className="space-y-2 rounded-md border border-border p-3 text-sm text-text-secondary"
            aria-label="Email delivery status"
          >
            {ready && (
              <>
                <p className="break-words">
                  <strong className="font-medium text-text-primary">Sender</strong>{" "}
                  {ready.sender || "Not configured"}
                </p>
                <p>
                  {ready.mode === "live"
                    ? "Live sending. Eligible recipients can receive email when the rule is enabled."
                    : ready.mode === "test"
                      ? "Test sending. Only the approved test recipient can receive messages. Other student messages are never redirected to that inbox."
                      : "Sending is disabled. Paused rules can still be saved."}
                </p>
                {ready.mode === "test" && (
                  <p className="break-words">
                    Approved test recipient: {ready.test_recipient || "Not configured"}
                  </p>
                )}
                <p>
                  {ready.can_enable
                    ? "Email is ready. Preview recipients before enabling or saving an enabled rule."
                    : (readinessReasons[ready.reason ?? ""] ??
                      "Email is not ready to enable. You can save a paused rule.")}
                </p>
              </>
            )}
            {!settings && settingsLoading && (
              <div role="status" aria-label="Loading settings" className="space-y-2">
                <span className="sr-only">Loading settings...</span>
                <div aria-hidden="true" className="h-5 w-48 rounded bg-surface-raised" />
                <div aria-hidden="true" className="h-5 w-3/4 rounded bg-surface-raised" />
                <div aria-hidden="true" className="h-5 w-2/3 rounded bg-surface-raised" />
              </div>
            )}
            {settingsError && (
              <p role="alert" className="text-danger">
                {settingsError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={settingsLoading || saving}
                onClick={() => void loadSettings()}
              >
                {needsReadback ? "Check saved rule" : "Refresh settings"}
              </Button>
              {draft && (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  disabled={settingsLoading || saving}
                  onClick={() => void loadSettings(true)}
                >
                  Reload saved rule and discard edits
                </Button>
              )}
            </div>
          </div>
        )}

        {!draft && settingsLoading && <RuleFormPlaceholder />}
        {draft && (
          <div className="grid min-w-0 gap-6 lg:grid-cols-2">
            <div className="min-w-0 space-y-4">
              <fieldset disabled={saving || reloading} className="min-w-0 space-y-4">
                <legend className="sr-only">Missed-class rule</legend>
                <label className="block text-sm font-medium text-text-primary">
                  Days without attendance
                  <input
                    className={fieldClass}
                    type="number"
                    min={1}
                    max={90}
                    step={1}
                    value={draft.inactivity_days || ""}
                    onChange={(event) => edit({ inactivity_days: Number(event.target.value) })}
                  />
                </label>
                <p className="text-xs leading-5 text-muted">
                  Active students with prior attendance qualify. Current holds, opt-outs and
                  contacts that cannot be safely selected are skipped. Minors receive email through
                  their guardian.
                </p>
                <label className="block text-sm font-medium text-text-primary">
                  Subject
                  <input
                    className={fieldClass}
                    maxLength={200}
                    value={draft.subject_template}
                    onChange={(event) => edit({ subject_template: event.target.value })}
                  />
                </label>
                <div>
                  <label
                    htmlFor="missed-class-message"
                    className="block text-sm font-medium text-text-primary"
                  >
                    Message
                  </label>
                  <textarea
                    id="missed-class-message"
                    className={`${fieldClass} min-h-48 resize-y`}
                    rows={8}
                    maxLength={5000}
                    value={draft.body_template}
                    aria-describedby="template-help"
                    onChange={(event) => edit({ body_template: event.target.value })}
                  />
                </div>
                <p id="template-help" className="break-words text-xs leading-5 text-muted">
                  Plain text only. Available placeholders: {TEMPLATE_PLACEHOLDERS.join(", ")}. An
                  unsubscribe link is added when sending.
                </p>
                <label className="block text-sm font-medium text-text-primary">
                  Reply-to email
                  <input
                    className={fieldClass}
                    type="email"
                    autoComplete="off"
                    value={draft.reply_to_email}
                    onChange={(event) => edit({ reply_to_email: event.target.value })}
                  />
                </label>
              </fieldset>
              {invalidDraft && <p className="text-sm text-danger">{invalidDraft}</p>}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-11"
                  disabled={saving || reloading || previewLoading || !!invalidDraft}
                  onClick={() => void requestPreview()}
                >
                  {previewLoading ? "Loading preview..." : "Preview recipients"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={
                    writeBlocked || !!invalidDraft || (!!settings?.rule.enabled && enableBlocked)
                  }
                  onClick={() => void save("save")}
                >
                  {saving
                    ? "Saving..."
                    : settings?.rule.enabled
                      ? "Save enabled rule"
                      : "Save paused rule"}
                </Button>
                {settings?.rule.enabled ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={writeBlocked}
                    onClick={() => void save("pause")}
                  >
                    Pause automation
                  </Button>
                ) : (
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={enableBlocked}
                    onClick={() => void save("enable")}
                  >
                    Enable automation
                  </Button>
                )}
              </div>
              <p className="text-xs leading-5 text-muted">
                Previewing does not send email. Changes to any field require a new preview before
                enabling or saving an enabled rule. Pausing keeps the saved message.
              </p>
              {actionError && (
                <p role="alert" className="text-sm text-danger">
                  {actionError}
                </p>
              )}
              {message && (
                <p role="status" className="text-sm text-text-secondary">
                  {message}
                </p>
              )}
            </div>

            <div className="min-w-0 space-y-4" aria-labelledby="recipient-preview-title">
              <h3
                id="recipient-preview-title"
                className="text-base font-semibold text-text-primary"
              >
                Recipient preview
              </h3>
              {previewLoading && (
                <p role="status" className="text-sm text-muted">
                  Checking recipients for this draft...
                </p>
              )}
              {previewError && (
                <p role="alert" className="text-sm text-danger">
                  {previewError}
                </p>
              )}
              {!preview && !previewLoading && (
                <p className="text-sm leading-6 text-text-secondary">
                  Preview this draft to see who qualifies, who is skipped and how the message reads.
                </p>
              )}
              {preview && (
                <>
                  <p role="status" className="text-sm text-text-secondary">
                    {preview.eligible_count} eligible · {preview.skipped_count} skipped ·{" "}
                    {isDemo ? "Sample date" : "Studio reference date"} {preview.reference_date}
                  </p>
                  {preview.truncated && (
                    <p className="text-sm text-text-secondary">
                      Showing up to 100 students. Totals include students beyond this preview.
                    </p>
                  )}
                  {sample && (
                    <article
                      className="min-w-0 rounded-lg p-4"
                      data-automation-inset="true"
                      aria-label="Email preview"
                    >
                      <p className="break-words text-xs text-muted">
                        To {sample.recipient_name || sample.student_name} · {sample.recipient_email}
                      </p>
                      <h4 className="mt-3 break-words text-sm font-semibold text-text-primary">
                        {sample.rendered_subject}
                      </h4>
                      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-text-secondary">
                        {sample.rendered_body}
                      </p>
                    </article>
                  )}
                  {!preview.recipients.length && (
                    <p className="text-sm text-muted">No students to show for this rule.</p>
                  )}
                  <ul className="min-w-0 divide-y divide-border">
                    {preview.recipients.map((recipient) => (
                      <li key={recipient.student_id} className="min-w-0 py-3 text-sm">
                        <p className="break-words font-medium text-text-primary">
                          {recipient.student_name}
                        </p>
                        {recipient.skip_reason ? (
                          <p className="break-words text-muted">
                            Skipped: {safeReason(recipient.skip_reason)}
                          </p>
                        ) : (
                          <>
                            <p className="break-words text-text-secondary">
                              {recipient.recipient_kind === "guardian" ? "Guardian" : "Student"}:{" "}
                              {recipient.recipient_email}
                            </p>
                            <p className="text-xs text-muted">
                              {recipient.days_absent} days absent · Last attendance{" "}
                              {recipient.last_attendance_date}
                            </p>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <section
        aria-labelledby="automation-activity-title"
        className="min-w-0 border-t border-border pt-5"
        aria-busy={activityLoading}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="automation-activity-title" className="text-base font-semibold text-text-primary">
            Recent activity{isDemo ? " · Sample data" : ""}
          </h3>
          {!isDemo && (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={activityLoading}
              onClick={() => void loadActivity()}
            >
              Refresh activity
            </Button>
          )}
        </div>
        {!activity && activityLoading && (
          <ul
            className="koaryu-skeleton-reveal mt-2 min-w-0 divide-y divide-border"
            role="status"
            aria-label="Loading activity"
          >
            {[0, 1, 2].map((row) => (
              <li key={row} className="min-w-0 space-y-2 py-3 text-sm" aria-hidden="true">
                <div className="flex flex-wrap justify-between gap-2">
                  <div className="h-5 w-36 rounded bg-surface-raised" />
                  <div className="h-5 w-20 rounded bg-surface-raised" />
                </div>
                <div className="h-5 w-48 rounded bg-surface-raised" />
                <div className="h-4 w-64 max-w-full rounded bg-surface-raised" />
              </li>
            ))}
          </ul>
        )}
        {activityError && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {activityError}
          </p>
        )}
        {activity && !activity.items.length && (
          <p className="mt-2 text-sm text-muted">No messages have been queued yet.</p>
        )}
        {activity?.has_more && (
          <p className="mt-2 text-xs text-muted">
            Showing the latest 50 entries. Older activity is not shown here.
          </p>
        )}
        <ul className="mt-2 min-w-0 divide-y divide-border">
          {activity?.items.map((item) => (
            <li key={item.id} className="min-w-0 py-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <p className="break-words font-medium text-text-primary">{item.student_name}</p>
                <p className="text-text-secondary">{ACTIVITY_LABELS[item.state]}</p>
              </div>
              <p className="break-words text-text-secondary">{item.recipient_email}</p>
              <p className="mt-1 break-words text-xs text-muted">
                {item.created_at.replace("T", " ").replace("Z", " UTC")} · {item.attempts}{" "}
                {item.attempts === 1 ? "attempt" : "attempts"}
                {item.reason ? ` · ${safeReason(item.reason)}` : ""}
              </p>
              {item.state === "accepted" && (
                <p className="mt-1 text-xs text-muted">
                  Provider acceptance does not confirm inbox delivery.
                </p>
              )}
              {item.state === "unknown" && (
                <p className="mt-1 text-xs text-muted">
                  The send outcome could not be confirmed. This message will not be automatically
                  resent.
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

function RuleFormPlaceholder() {
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-2" aria-hidden="true">
      <div className="min-w-0 space-y-4">
        {["Days without attendance", "Subject", "Message", "Reply-to email"].map((label) => (
          <div key={label} className="text-sm font-medium text-text-primary">
            {label}
            <div
              className={`${fieldClass} bg-surface-raised ${label === "Message" ? "min-h-48" : ""}`}
            />
            {label === "Days without attendance" || label === "Message" ? (
              <div className="mt-3 h-10 rounded bg-surface-raised" />
            ) : null}
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2].map((button) => (
            <div key={button} className="h-11 w-36 rounded bg-surface-raised" />
          ))}
        </div>
        <div className="h-10 rounded bg-surface-raised" />
      </div>
      <div className="min-w-0 space-y-4">
        <h3 className="text-base font-semibold text-text-primary">Recipient preview</h3>
        <p className="text-sm leading-6 text-text-secondary">
          Preview this draft to see who qualifies, who is skipped and how the message reads.
        </p>
      </div>
    </div>
  );
}
