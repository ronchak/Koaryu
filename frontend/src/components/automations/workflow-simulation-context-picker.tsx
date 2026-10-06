"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useBeltStore, useConfigStore, useLeadStore, useStudentStore } from "@/lib/store";
import { withCurrentLiveAuthRead } from "@/lib/store-action-types";
import { normalizeStudentListSearch } from "@/lib/student-list-page";
import { displayName } from "@/lib/students-page-model";
import { billingInvoiceReference, billingPaymentReference } from "@/lib/billing-page-model";
import { formatMoney, formatBillingCalendarDate } from "@/lib/billing-page-utils";
import { appointmentSummary } from "@/components/appointments/appointment-time-fields";
import type { BillingInvoicePage, BillingPaymentPage } from "@/lib/billing-landing";
import type {
  WorkflowSimulationContext,
  WorkflowSimulationEntityType,
} from "@/lib/automation-workflow-types";
import styles from "./workflow-workspace.module.css";

export type WorkflowSimulationSelection = Readonly<{
  context: WorkflowSimulationContext;
  label: string;
  isCurrent(): boolean;
}>;
export type WorkflowSimulationContextPickerProps = {
  entityType: WorkflowSimulationEntityType | null;
  value: WorkflowSimulationSelection | null;
  onChange(value: WorkflowSimulationSelection | null): void;
  isCurrent(): boolean;
  disabled: boolean;
};
type Choice = { id: string; label: string; isCurrent(): boolean };
type Page = { rows: Choice[]; next?: string | null; previous?: string | null };
type Listing = Page & {
  ready: boolean;
  loading: boolean;
  error: boolean;
  cursor?: string;
  back: (string | undefined)[];
};
const empty = (): Listing => ({ rows: [], ready: false, loading: false, error: false, back: [] });
const reference = (id: string) => `Ref ${id.slice(0, 8)}`;

export function WorkflowSimulationContextPicker(props: WorkflowSimulationContextPickerProps) {
  const { value, onChange, disabled, entityType, isCurrent } = props;
  const [browsing, setBrowsing] = useState(false);
  const change = (next: WorkflowSimulationSelection | null) => {
    if (!disabled && isCurrent()) onChange(next);
  };
  return (
    <div className={styles.toolStack}>
      <p>Context: {value?.label ?? "Choose a current record below."}</p>
      {value && !value.isCurrent() ? (
        <p role="status">This selection is no longer current. Choose it again.</p>
      ) : null}
      <div className={styles.actions}>
        <button
          disabled={disabled}
          onClick={() => {
            setBrowsing(false);
            change({ context: { kind: "synthetic" }, label: "Synthetic sample", isCurrent });
          }}
        >
          Use synthetic sample
        </button>
        <button
          disabled={disabled || !entityType}
          onClick={() => {
            setBrowsing(true);
            change(null);
          }}
        >
          Choose real record
        </button>
      </div>
      {!entityType ? (
        <p className={styles.muted}>Choose a supported trigger to select real records.</p>
      ) : null}
      {browsing && entityType ? (
        <RecordChoices key={entityType} {...props} entityType={entityType} />
      ) : null}
      <p className={styles.muted}>
        Simulation uses current data and your current graph. A listed record may no longer be
        available when checked.
      </p>
    </div>
  );
}

function RecordChoices({
  entityType,
  value,
  onChange,
  isCurrent,
  disabled,
}: WorkflowSimulationContextPickerProps & { entityType: WorkflowSimulationEntityType }) {
  const students = useStudentStore(),
    leads = useLeadStore(),
    belts = useBeltStore();
  const { token } = useConfigStore();
  const latest = useRef({ token, leads, belts, isCurrent, disabled });
  useLayoutEffect(() => {
    latest.current = { token, leads, belts, isCurrent, disabled };
  });
  const [parent, setParent] = useState<Choice | null>(null);
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<[Listing, Listing]>([empty(), empty()]);
  const requests = useRef([0, 0]);
  const aborts = useRef<(AbortController | undefined)[]>([]);
  const mounted = useRef(true);
  const choiceGeneration = useRef(0);
  const [leadRead, setLeadRead] = useState<{
    current(): boolean;
    before: typeof leads.leads;
    cursor?: string;
    back: (string | undefined)[];
  } | null>(null);
  const nested = ["promotion", "trial_appointment", "belt_test_recipient"].includes(entityType);
  const level = nested && parent ? 1 : 0;
  const kind =
    level === 1
      ? entityType
      : entityType === "promotion"
        ? "student"
        : entityType === "trial_appointment"
          ? "lead"
          : entityType === "belt_test_recipient"
            ? "event"
            : entityType;
  const page = pages[level];
  const update = (index: number, change: Partial<Listing>) =>
    setPages(
      (old) =>
        old.map((item, at) => (at === index ? { ...item, ...change } : item)) as [Listing, Listing],
    );
  useEffect(() => {
    mounted.current = true;
    const controllers = aborts.current;
    return () => {
      mounted.current = false;
      requests.current = requests.current.map((n) => n + 1);
      controllers.forEach((abort) => abort?.abort());
    };
  }, []);
  useEffect(() => {
    if (!leadRead) return;
    const ready =
      leadRead.current() &&
      leads.leadsLoaded &&
      !leads.leadsLoadError &&
      leads.leads !== leadRead.before;
    const rows = leads.leads.map((row) => ({
      id: row.id,
      label: `${row.first_name} ${row.last_name} · ${row.stage} · ${reference(row.id)}`,
      isCurrent: () =>
        leadRead.current() &&
        latest.current.leads.leads === leads.leads &&
        !latest.current.leads.leadsLoadError,
    }));
    setPages((old) => [
      {
        ...old[0],
        ...(ready ? { rows } : {}),
        loading: false,
        ready,
        error: !ready,
        cursor: leadRead.cursor,
        back: leadRead.back,
      },
      old[1],
    ]);
  }, [leadRead, leads.leads, leads.leadsLoaded, leads.leadsLoadError]);
  const invalidate = (index: number) => {
    requests.current[index]++;
    aborts.current[index]?.abort();
    update(index, { ready: false, loading: false });
  };
  const clearChoice = () => {
    choiceGeneration.current++;
    if (latest.current.isCurrent()) onChange(null);
  };
  const load = async (cursor?: string, back: (string | undefined)[] = []) => {
    if (disabled || page.loading || !isCurrent() || (parent && !parent.isCurrent())) return;
    invalidate(level);
    if (level === 0) invalidate(1);
    clearChoice();
    const serial = requests.current[level],
      controller = new AbortController(),
      capturedToken = token;
    aborts.current[level] = controller;
    const viewCurrent = () =>
      mounted.current &&
      requests.current[level] === serial &&
      latest.current.isCurrent() &&
      !latest.current.disabled;
    const current = () => viewCurrent() && (!parent || parent.isCurrent());
    const tokenCurrent = () => current() && latest.current.token === capturedToken;
    const choices = <T extends { id: string }>(
      rows: readonly T[],
      label: (row: T) => string,
      guard = tokenCurrent,
    ): Choice[] => rows.map((row) => ({ id: row.id, label: label(row), isCurrent: guard }));
    update(level, { loading: true, error: false, ready: false });
    try {
      let result: Page;
      let resultCurrent = current;
      if (kind === "student") {
        resultCurrent = tokenCurrent;
        const data = await students.listStudentsPage(
          { search: normalizeStudentListSearch(query), pageSize: 50, cursor },
          { signal: controller.signal },
        );
        result = {
          rows: choices(
            data.items,
            (row) => `${displayName(row)} · ${row.status} · ${reference(row.id)}`,
          ),
          next: data.has_next ? data.next_cursor : null,
          previous: data.has_previous ? data.previous_cursor : null,
        };
      } else if (kind === "lead") {
        setLeadRead(null);
        const before = leads.leads;
        const resourceCurrent = leads.trialAppointments.trialStorage.isCurrent;
        await leads.refreshLeads();
        if (current())
          setLeadRead({ current: () => current() && resourceCurrent(), before, cursor, back });
        return;
      } else if (kind === "promotion") {
        resultCurrent = tokenCurrent;
        const data = await belts.loadPromotionHistory(parent!.id, { force: true });
        result = {
          rows: choices(
            data,
            (row) =>
              `${row.student_name || parent!.label} · ${row.from_rank_name || "Previous rank unavailable"} to ${row.to_rank_name || "Rank unavailable"} · ${formatBillingCalendarDate(row.promoted_at)} · ${reference(row.id)}`,
          ),
        };
      } else if (kind === "trial_appointment") {
        const ownerCurrent = leads.trialAppointments.trialStorage.isCurrent;
        const data = await leads.trialAppointments.listTrialAppointments(parent!.id, {
          limit: 50,
          cursor,
        });
        if (data.status !== "ready" || !data.isCurrent() || !ownerCurrent())
          throw Error("Unavailable");
        result = {
          rows: choices(
            data.value.items,
            (row) =>
              `${parent!.label} · ${appointmentSummary(row)} · ${row.location || "Location unavailable"} · ${row.status} · ${reference(row.id)}`,
            () => current() && ownerCurrent() && data.isCurrent(),
          ),
          next: data.value.has_more ? data.value.next_cursor : null,
        };
      } else if (kind === "event" || kind === "belt_test_recipient") {
        const ownerCurrent = belts.beltTests.storage.isCurrent;
        if (kind === "event") {
          const data = await belts.beltTests.listEvents({ limit: 50, cursor });
          if (data.status !== "ready" || !data.isCurrent() || !ownerCurrent())
            throw Error("Unavailable");
          result = {
            rows: choices(
              data.value.items,
              (row) =>
                `${row.name} · ${row.starts_at} · ${row.timezone} · ${row.status} · ${reference(row.id)}`,
              () => current() && ownerCurrent() && data.isCurrent(),
            ),
            next: data.value.has_more ? data.value.next_cursor : null,
          };
        } else {
          const data = await belts.beltTests.listRecipients(parent!.id, { limit: 50, cursor });
          if (data.status !== "ready" || !data.isCurrent() || !ownerCurrent())
            throw Error("Unavailable");
          result = {
            rows: choices(
              data.value.items,
              (row) => {
                const student = students.students.find((item) => item.id === row.student_id);
                const rank = belts.beltRanks.find(
                  (item) => item.id === row.approved_target_rank_id,
                );
                return `${student ? displayName(student) : "Student name unavailable"} · ${rank?.name || "Rank label unavailable"} · Recorded ${row.approved_at} · ${row.state} · ${reference(row.id)} · ${parent!.label}`;
              },
              () => current() && ownerCurrent() && data.isCurrent(),
            ),
            next: data.value.has_more ? data.value.next_cursor : null,
          };
        }
      } else {
        let readToken = token;
        const path = `/billing/${kind === "invoice" ? "invoices" : "payments"}/page?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const begin = () => {
          if (!current() || !latest.current.token) throw Error("Unavailable");
          readToken = latest.current.token;
          const attemptToken = readToken;
          return {
            token: attemptToken,
            isCurrent: current,
            canRetryAfterTokenChange: () => current() && latest.current.token !== attemptToken,
          };
        };
        const guard = () => current() && latest.current.token === readToken;
        if (kind === "invoice") {
          const data = await withCurrentLiveAuthRead(
            begin,
            (request) =>
              api.get<BillingInvoicePage>(path, request.token, { signal: controller.signal }),
            () => {},
          );
          result = {
            rows: choices(
              data.items,
              (row) =>
                `${billingInvoiceReference(row)} · ${formatMoney(row.amount_remaining_cents, row.currency)} · ${formatBillingCalendarDate(row.due_date)} · ${row.status}`,
              guard,
            ),
            next: data.complete ? null : data.next_cursor,
          };
        } else {
          const data = await withCurrentLiveAuthRead(
            begin,
            (request) =>
              api.get<BillingPaymentPage>(path, request.token, { signal: controller.signal }),
            () => {},
          );
          result = {
            rows: choices(
              data.items,
              (row) =>
                `${billingPaymentReference(row)} · ${formatMoney(row.amount_cents, row.currency)} · ${formatBillingCalendarDate(row.processed_at || row.created_at)} · ${row.status}`,
              guard,
            ),
            next: data.complete ? null : data.next_cursor,
          };
        }
      }
      if (current())
        update(level, {
          ...result,
          cursor,
          back,
          loading: false,
          ready: resultCurrent() && result.rows.every((row) => row.isCurrent()),
          error: !resultCurrent() || result.rows.some((row) => !row.isCurrent()),
        });
      else if (viewCurrent()) update(level, { loading: false, ready: false, error: true });
    } catch {
      if (viewCurrent()) update(level, { loading: false, ready: false, error: true });
    }
  };
  const localSearch = kind !== "student";
  const rows = localSearch
    ? page.rows.filter((row) => row.label.toLowerCase().includes(query.trim().toLowerCase()))
    : page.rows;
  return (
    <div className={styles.recordPicker} aria-label="Current record picker">
      {parent ? (
        <div className={styles.toolStack}>
          <p>From {parent.label}</p>
          {!parent.isCurrent() ? (
            <p role="status">
              The parent selection is no longer current. Change parent record and choose it again.
            </p>
          ) : null}
          <button
            disabled={disabled}
            onClick={() => {
              invalidate(0);
              invalidate(1);
              setParent(null);
              setQuery("");
              clearChoice();
            }}
          >
            Change parent record
          </button>
        </div>
      ) : null}
      <label className={styles.toolField}>
        {kind === "student" ? "Find student" : "Search loaded records"}
        <input
          value={query}
          maxLength={kind === "student" ? 80 : undefined}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!localSearch || page.loading) {
              clearChoice();
              invalidate(level);
            }
          }}
        />
      </label>
      <div className={styles.actions}>
        <button
          disabled={disabled || page.loading || Boolean(parent && !parent.isCurrent())}
          onClick={() => void load()}
        >
          {kind === "student"
            ? "Search students"
            : `Load ${kind === "event" ? "events" : kind.replaceAll("_", " ") + " records"}`}
        </button>
        {page.error ? (
          <button
            disabled={disabled || page.loading || Boolean(parent && !parent.isCurrent())}
            onClick={() => void load(page.cursor, page.back)}
          >
            Retry records
          </button>
        ) : null}
      </div>
      {page.loading ? <p role="status">Loading records...</p> : null}
      {page.error ? (
        <p role="alert">
          Records could not be refreshed. Previous rows are unavailable until a current read
          succeeds.
        </p>
      ) : null}
      {page.ready && rows.length === 0 ? <p>No matching records in this loaded page.</p> : null}
      {rows.length > 50 ? (
        <p>Showing 50 of {rows.length} loaded matches. Refine your search.</p>
      ) : null}
      <ul className={styles.toolRows}>
        {rows.slice(0, 50).map((row) => (
          <li key={row.id}>
            <button
              disabled={disabled || !page.ready || !row.isCurrent()}
              aria-pressed={value?.context.kind === "entity" && value.context.entity_id === row.id}
              onClick={() => {
                if (!page.ready || !row.isCurrent() || !isCurrent()) return;
                if (nested && level === 0) {
                  invalidate(1);
                  setParent(row);
                  setQuery("");
                  setPages((old) => [old[0], empty()]);
                  clearChoice();
                } else {
                  const selectedGeneration = ++choiceGeneration.current;
                  onChange({
                    context: { kind: "entity", entity_type: entityType, entity_id: row.id },
                    label: row.label,
                    isCurrent: () =>
                      selectedGeneration === choiceGeneration.current && row.isCurrent(),
                  });
                }
              }}
            >
              {row.label}
            </button>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <button
          disabled={disabled || page.loading || (!page.previous && page.back.length === 0)}
          onClick={() => void load(page.previous ?? page.back.at(-1), page.back.slice(0, -1))}
        >
          Back records
        </button>
        <button
          disabled={disabled || page.loading || !page.next || !page.ready}
          onClick={() => void load(page.next!, [...page.back, page.cursor])}
        >
          Next records
        </button>
      </div>
      {kind === "belt_test_recipient" ? (
        <p className={styles.muted}>Recorded approval does not establish current eligibility.</p>
      ) : null}
    </div>
  );
}
