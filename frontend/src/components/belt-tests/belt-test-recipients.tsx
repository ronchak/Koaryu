"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { ModalFrame } from "@/components/ui/modal-frame";
import { ApiError } from "@/lib/api";
import { displayName } from "@/lib/students-page-model";
import {
  beltTestTargetKey,
  type BeltTestCandidate as Candidate,
  type BeltTestPair,
} from "@/lib/belt-test-contract";
import type {
  BeltTestFacade,
  BeltTestRead,
  BeltTestRecipientPage,
  BeltTestView,
} from "@/lib/belt-test-operation";
import type {
  ApiBeltTestEventResponse as Event,
  ApiBeltTestRecipientResponse as Recipient,
} from "@/types/generated/api-contracts";
import type { Student } from "@/types";
import type { BeltTestReferences } from "./belt-test-workspace";
import { referenceId, supportedBeltPlan } from "./belt-test-event-editor";
import styles from "./belt-tests.module.css";

const pairKey = (pair: BeltTestPair) =>
  `${referenceId(pair.student_id)}:${referenceId(pair.student_program_membership_id) ?? "null"}`;
const pair = (row: Candidate): BeltTestPair => ({
  student_id: row.student_id,
  student_program_membership_id: row.student_program_membership_id,
});
type Selection = readonly Candidate[];
type Confirmation =
  | { kind: "refresh" }
  | { kind: "approve"; rows: Selection; selection: Selection; revision: number }
  | { kind: "revoke"; event: Readonly<Event>; recipient: Readonly<Recipient>; current(): boolean };
type Props = {
  event: Readonly<Event>;
  facade: BeltTestFacade;
  references: BeltTestReferences;
  students: readonly Student[];
  timezone: string;
  preview: boolean;
  detailsDirty: boolean;
  isCurrent(): boolean;
  onDirtyChange(dirty: boolean): void;
  onEventObserved(event: Readonly<Event> | null): void;
};

export function BeltTestRecipients({
  event,
  facade,
  references,
  students,
  timezone,
  preview,
  detailsDirty,
  isCurrent,
  onDirtyChange,
  onEventObserved,
}: Props) {
  const [candidates, setCandidates] = useState<{
    revision: number;
    context: string;
    read: Extract<BeltTestRead<readonly Candidate[]>, { status: "ready" }>;
  } | null>(null);
  const [selection, setSelection] = useState<Selection>([]),
    [candidatePage, setCandidatePage] = useState(0);
  const [history, setHistory] = useState<BeltTestRecipientPage | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(),
    [failedCursor, setFailedCursor] = useState<string | undefined>();
  const [candidateLoading, setCandidateLoading] = useState(false),
    [historyLoading, setHistoryLoading] = useState(false);
  const [candidateError, setCandidateError] = useState(false),
    [historyError, setHistoryError] = useState(false);
  const [message, setMessage] = useState<string | null>(null),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [revokeLoading, setRevokeLoading] = useState(false);
  const selected = useRef(selection),
    alive = useRef(true),
    latestEvent = useRef(event);
  const candidateRequest = useRef(0),
    historyRequest = useRef(0),
    revokeRequest = useRef(0),
    seen = useRef(new Set<BeltTestView>());
  const submitted = useRef<{ selection: Selection; rows: Selection } | null>(null);
  const referenceKey = JSON.stringify([references.ladders, references.programs]);
  const referenceStatus = references.status;
  useLayoutEffect(() => {
    latestEvent.current = event;
  }, [event]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = useCallback(() => alive.current && isCurrent(), [isCurrent]);
  const select = useCallback(
    (rows: Selection) => {
      selected.current = rows;
      setSelection(rows);
      onDirtyChange(rows.length > 0);
    },
    [onDirtyChange],
  );
  const { getCandidates, listRecipients } = facade;
  const loadCandidates = useCallback(async () => {
    if (
      !current() ||
      referenceStatus !== "ready" ||
      latestEvent.current.status !== "scheduled" ||
      Date.parse(latestEvent.current.starts_at) <= Date.now()
    )
      return;
    const request = ++candidateRequest.current,
      revision = latestEvent.current.revision;
    setCandidateLoading(true);
    setCandidateError(false);
    setConfirmation(null);
    try {
      const result = await getCandidates(event.id);
      if (
        !current() ||
        request !== candidateRequest.current ||
        latestEvent.current.revision !== revision ||
        result.status !== "ready" ||
        !result.isCurrent()
      )
        return;
      setCandidates({ revision, context: referenceKey, read: result });
      setCandidatePage(0);
    } catch {
      if (current() && request === candidateRequest.current) setCandidateError(true);
    } finally {
      if (current() && request === candidateRequest.current) setCandidateLoading(false);
    }
  }, [current, event.id, getCandidates, referenceKey, referenceStatus]);
  const loadHistory = useCallback(
    async (next?: string) => {
      if (!current()) return;
      const request = ++historyRequest.current;
      setHistoryLoading(true);
      setHistoryError(false);
      try {
        const result = await listRecipients(event.id, {
          limit: 50,
          ...(next === undefined ? {} : { cursor: next }),
        });
        if (
          !current() ||
          request !== historyRequest.current ||
          result.status !== "ready" ||
          !result.isCurrent()
        )
          return;
        setHistory(result.value);
        setCursor(next);
      } catch {
        if (current() && request === historyRequest.current) {
          setHistoryError(true);
          setFailedCursor(next);
        }
      } finally {
        if (current() && request === historyRequest.current) setHistoryLoading(false);
      }
    },
    [current, event.id, listRecipients],
  );
  useEffect(() => {
    if (!candidates) void loadCandidates();
  }, [loadCandidates, event.status, candidates]);
  useEffect(() => {
    queueMicrotask(() => {
      void loadHistory();
    });
  }, [loadHistory]);
  const view = facade.operations.get(beltTestTargetKey({ kind: "event", id: event.id }));
  useEffect(() => {
    if (
      !view?.isCurrent() ||
      !current() ||
      seen.current.has(view) ||
      !["confirmed", "unavailable"].includes(view.status)
    )
      return;
    seen.current.add(view);
    if (view.command === "belt_test.approve") {
      const sent = submitted.current;
      if (sent && sent.selection === selected.current)
        select(
          selected.current.filter(
            (row) => !sent.rows.some((item) => pairKey(item) === pairKey(row)),
          ),
        );
      submitted.current = null;
      void loadHistory(cursor);
    }
    if (view.command === "belt_test.revoke" && view.currentEvent) {
      setHistory(
        (previous) =>
          previous && {
            ...previous,
            items: view.currentRecipient
              ? previous.items.map((row) =>
                  row.id === view.recipientId ? view.currentRecipient! : row,
                )
              : previous.items.filter((row) => row.id !== view.recipientId),
          },
      );
      setMessage(view.message);
    }
  }, [view, current, cursor, loadHistory, select]);
  const plan = supportedBeltPlan(references, event.ladder_id, event);
  const fresh = Boolean(
    candidates?.read.isCurrent() &&
    candidates.context === referenceKey &&
    candidates.revision === event.revision &&
    plan &&
    !candidateError &&
    !candidateLoading,
  );
  const pending = facade.pendingOperation({ kind: "event", id: event.id });
  const locked =
    Boolean(pending?.isCurrent() && pending.locked) || facade.storage.status === "blocked";
  const mutable = event.status === "scheduled";
  const supported = (row: Candidate) =>
    Boolean(
      row.classes_met &&
      row.time_met &&
      row.next_rank_id &&
      plan?.ranks.some((rank) => referenceId(rank.id) === referenceId(row.next_rank_id)),
    );
  const context = (row: Candidate) =>
    `${row.program_id === null ? "No program" : (references.programs.find((item) => referenceId(item.id) === referenceId(row.program_id))?.name ?? "Program unavailable")} · ${row.student_program_membership_id === null ? "No membership" : "Program membership"}`;
  const requestApproval = (rows: Selection) => {
    if (
      !fresh ||
      locked ||
      detailsDirty ||
      !mutable ||
      !rows.length ||
      rows.length > 100 ||
      rows.some((row) => !supported(row))
    )
      return;
    setConfirmation({
      kind: "approve",
      rows,
      selection: selected.current,
      revision: event.revision,
    });
  };
  async function approve(dialog: Extract<Confirmation, { kind: "approve" }>) {
    if (
      !current() ||
      !fresh ||
      locked ||
      detailsDirty ||
      dialog.revision !== latestEvent.current.revision ||
      dialog.selection !== selected.current ||
      dialog.rows.some((row) => !candidates?.read.value.includes(row) || !supported(row))
    ) {
      setConfirmation(null);
      return;
    }
    submitted.current = { selection: dialog.selection, rows: dialog.rows };
    setConfirmation(null);
    try {
      await facade.approveRecipients(event, dialog.rows.map(pair));
    } catch {
      if (current())
        setMessage(
          "Approval was not confirmed. Keep this selection for review and check the result above.",
        );
    }
  }
  async function prepareRevoke(row: Readonly<Recipient>) {
    if (!current() || locked || detailsDirty || selection.length) return;
    const request = ++revokeRequest.current;
    const owns = () => current() && request === revokeRequest.current;
    setRevokeLoading(true);
    setMessage(null);
    let parentVerified = false;
    try {
      const parent = await facade.getEvent(event.id);
      if (!owns() || parent.status !== "ready" || !parent.isCurrent()) return;
      parentVerified = true;
      onEventObserved(parent.value);
      const child = await facade.getRecipient(event.id, row.id);
      if (!owns() || !parent.isCurrent() || child.status !== "ready" || !child.isCurrent()) return;
      if (child.value.state !== "approved") {
        setMessage("This recipient is already revoked. Refresh recipient history.");
        return;
      }
      setConfirmation({
        kind: "revoke",
        event: parent.value,
        recipient: child.value,
        current: () => owns() && parent.isCurrent() && child.isCurrent(),
      });
    } catch (error) {
      if (!owns()) return;
      if (error instanceof ApiError && error.status === 404 && !parentVerified)
        onEventObserved(null);
      else
        setMessage(
          "The current recipient could not be loaded. Refresh recipient history before trying again.",
        );
    } finally {
      if (owns()) setRevokeLoading(false);
    }
  }
  async function revoke(dialog: Extract<Confirmation, { kind: "revoke" }>) {
    if (!current() || !dialog.current() || locked || detailsDirty || selected.current.length) {
      setConfirmation(null);
      return;
    }
    setConfirmation(null);
    try {
      await facade.revokeRecipient(dialog.event, dialog.recipient);
    } catch {
      if (current())
        setMessage("Revocation was not confirmed. Check the result above before trying again.");
    }
  }
  const dateLabel = (wire: string) => {
    try {
      return new Intl.DateTimeFormat("en", {
        timeZone: timezone || event.timezone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(wire));
    } catch {
      return wire;
    }
  };
  const rankName = (id: string | null) =>
    id === null
      ? "Unranked"
      : (references.ladders
          .flatMap((ladder) => ladder.ranks)
          .find((rank) => referenceId(rank.id) === referenceId(id))?.name ??
        "Saved rank unavailable");
  return (
    <section className={styles.panel} aria-label="Belt-test recipients">
      <h2>Candidates and recorded approvals</h2>
      {preview && <p>Sample approval records only.</p>}
      {mutable && (
        <>
          <button
            type="button"
            disabled={candidateLoading}
            onClick={() =>
              selection.length ? setConfirmation({ kind: "refresh" }) : void loadCandidates()
            }
          >
            Refresh candidates
          </button>
          {candidateLoading && <p role="status">Loading event candidates.</p>}
          {candidateError && (
            <p role="alert">Candidates are unavailable. Previous rows remain for review.</p>
          )}
          {!fresh && candidates && (
            <p>
              Candidate context has changed or is unavailable. Clear selections and refresh before
              approval.
            </p>
          )}
          {candidates?.read.value.length === 0 && <p>No candidates were returned.</p>}
          {candidates?.read.value.slice(candidatePage * 50, (candidatePage + 1) * 50).map((row) => {
            const checked = selection.some((item) => pairKey(item) === pairKey(row));
            return (
              <article key={pairKey(row)} className={styles.row}>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    aria-describedby={`candidate-${pairKey(row)}`}
                    checked={checked}
                    disabled={!checked && (!fresh || !supported(row) || selection.length >= 100)}
                    onChange={() =>
                      select(
                        checked
                          ? selection.filter((item) => pairKey(item) !== pairKey(row))
                          : [...selection, row],
                      )
                    }
                  />
                  {row.student_name}
                </label>
                <p id={`candidate-${pairKey(row)}`}>{context(row)}</p>
                <p>
                  {row.current_rank_name ?? "Unranked"} to {row.next_rank_name ?? "No next rank"}
                </p>
                <p>
                  Classes: {row.classes_since_promo}/{row.classes_required} · Days at rank:{" "}
                  {row.days_at_rank}/{row.days_required}
                </p>
                <p>
                  {row.classes_met ? "Class requirement met" : "Class requirement unmet"} ·{" "}
                  {row.time_met ? "Time requirement met" : "Time requirement unmet"}
                  {row.needs_approval ? " · Approval required" : ""}
                </p>
              </article>
            );
          })}
          <div className={styles.actions}>
            <button
              type="button"
              disabled={candidatePage === 0}
              onClick={() => setCandidatePage(candidatePage - 1)}
            >
              Previous candidates
            </button>
            <button
              type="button"
              disabled={!candidates || (candidatePage + 1) * 50 >= candidates.read.value.length}
              onClick={() => setCandidatePage(candidatePage + 1)}
            >
              More candidates
            </button>
            <button type="button" disabled={!selection.length} onClick={() => select([])}>
              Clear selection
            </button>
            <button
              type="button"
              disabled={!selection.length || !fresh || locked || detailsDirty}
              onClick={() => requestApproval(selection)}
            >
              Approve selected ({selection.length}/100)
            </button>
          </div>
          {selection.length > 0 && <p>Leaving this page or reloading discards unsaved changes.</p>}
        </>
      )}
      <h3>Recipient history</h3>
      {historyLoading && <p role="status">Loading recorded approvals.</p>}
      {historyError && (
        <p role="alert">
          Recipient history could not be refreshed. Previously loaded records remain below.
        </p>
      )}
      <button
        type="button"
        disabled={historyLoading}
        onClick={() => void loadHistory(historyError ? failedCursor : cursor)}
      >
        {historyError ? "Retry recipient history" : "Refresh recipient history"}
      </button>
      {history?.items.length === 0 && <p>No recorded approvals on this page.</p>}
      {history?.items.map((row) => {
        const candidate = candidates?.read.value.find((item) => pairKey(item) === pairKey(row));
        const student = students.find(
          (item) => referenceId(item.id) === referenceId(row.student_id),
        );
        return (
          <article className={styles.row} key={row.id}>
            <h4>
              {candidate?.student_name ??
                (student ? displayName(student) : "Student name unavailable")}
            </h4>
            <p>
              {row.state === "approved" ? "Recorded approval" : "Revoked"} ·{" "}
              {dateLabel(row.approved_at)}
            </p>
            <p>
              {rankName(row.approved_current_rank_id)} to {rankName(row.approved_target_rank_id)}
            </p>
            <p>
              {row.student_program_membership_id === null ? "No membership" : "Program membership"}
            </p>
            {row.approved_schedule_revision !== event.schedule_revision && (
              <p>Recorded for a different schedule.</p>
            )}
            <Link href={`/students/${row.student_id}`}>Open student record</Link>
            {mutable && candidate && (
              <button
                type="button"
                disabled={!fresh || !supported(candidate) || locked || detailsDirty}
                onClick={() => requestApproval([candidate])}
              >
                Reapprove
              </button>
            )}
            {mutable && row.state === "approved" && (
              <button
                type="button"
                disabled={locked || revokeLoading || detailsDirty || selection.length > 0}
                onClick={() => void prepareRevoke(row)}
              >
                Revoke approval
              </button>
            )}
          </article>
        );
      })}
      <div className={styles.actions}>
        <button
          type="button"
          disabled={historyLoading || cursor === undefined}
          onClick={() => void loadHistory()}
        >
          Back to first recipient page
        </button>
        <button
          type="button"
          disabled={historyLoading || !history?.next_cursor}
          onClick={() => void loadHistory(history!.next_cursor!)}
        >
          Next recipient page
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {confirmation && (
        <ModalFrame
          ariaLabel={
            confirmation.kind === "approve"
              ? "Confirm recipient approval"
              : confirmation.kind === "revoke"
                ? "Confirm recipient revocation"
                : "Clear candidate selection?"
          }
          panelClassName={styles.confirmation}
          onBackdropClick={() => setConfirmation(null)}
        >
          <h2>
            {confirmation.kind === "approve"
              ? "Approve these recipients?"
              : confirmation.kind === "revoke"
                ? "Revoke this recorded approval?"
                : "Clear selection and refresh?"}
          </h2>
          {confirmation.kind === "approve" && (
            <>
              <ul>
                {confirmation.rows.map((row) => (
                  <li key={pairKey(row)}>
                    {row.student_name} · {context(row)}
                  </li>
                ))}
              </ul>
              <p>Approval does not promote students or guarantee delivery.</p>
            </>
          )}
          {confirmation.kind === "revoke" && (
            <p>
              Current state: {confirmation.recipient.state}.{" "}
              {rankName(confirmation.recipient.approved_current_rank_id)} to{" "}
              {rankName(confirmation.recipient.approved_target_rank_id)}.
            </p>
          )}
          {confirmation.kind === "refresh" && (
            <p>Review the new candidates before selecting recipients again.</p>
          )}
          <button type="button" onClick={() => setConfirmation(null)}>
            Keep reviewing
          </button>
          <button
            type="button"
            disabled={locked && confirmation.kind !== "refresh"}
            onClick={() => {
              if (confirmation.kind === "approve") void approve(confirmation);
              else if (confirmation.kind === "revoke") void revoke(confirmation);
              else {
                select([]);
                void loadCandidates();
              }
            }}
          >
            {confirmation.kind === "approve"
              ? "Confirm approval"
              : confirmation.kind === "revoke"
                ? "Confirm revoke"
                : "Clear and refresh"}
          </button>
        </ModalFrame>
      )}
    </section>
  );
}
