"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ModalFrame } from "@/components/ui/modal-frame";
import {
  useBeltStore,
  useConfigStore,
  useProgramStore,
  useStudentStore,
  useStudioStore,
} from "@/lib/store";
import { ApiError } from "@/lib/api";
import { useRetainedState, useRetainedStore } from "@/lib/retained-state";
import { beltTestTargetKey, type BeltTestTarget } from "@/lib/belt-test-contract";
import type { BeltTestEventPage, BeltTestView } from "@/lib/belt-test-operation";
import type { ApiBeltTestEventResponse as Event } from "@/types/generated/api-contracts";
import type { BeltLadder, Program } from "@/types";
import { BeltTestEventEditor } from "./belt-test-event-editor";
import { BeltTestRecipients } from "./belt-test-recipients";
import styles from "./belt-tests.module.css";
import timeStyles from "@/components/leads/leads-ledger.module.css";

export type BeltTestReferences = Readonly<{
  status: "loading" | "ready" | "unavailable";
  ladders: readonly BeltLadder[];
  programs: readonly Program[];
  retry(): void;
}>;
type Session = {
  target: BeltTestTarget | null;
  event: Readonly<Event> | null;
  serial: number;
  loading: boolean;
  error: string | null;
};
const keyOf = (target: BeltTestTarget | null) => (target ? beltTestTargetKey(target) : "list");
const urlOf = (target: BeltTestTarget | null) =>
  target ? `/belt-tests?${target.kind}=${target.id.toLowerCase()}` : "/belt-tests";
const working = (view: BeltTestView) => view.status === "submitting" || view.status === "checking";

export function BeltTestWorkspace({ requestedTarget }: { requestedTarget: BeltTestTarget | null }) {
  const { beltTests } = useBeltStore();
  const { identityReady, currentRole } = useStudioStore();
  const { isPreviewMode } = useConfigStore();
  const [scope, setScope] = useState(() => ({ current: beltTests.storage.isCurrent, serial: 0 }));
  const allowed =
    (isPreviewMode || (identityReady && currentRole === "admin")) && beltTests.storage.isCurrent();
  if (allowed && !scope.current()) {
    setScope({ current: beltTests.storage.isCurrent, serial: scope.serial + 1 });
    return null;
  }
  if (!allowed)
    return (
      <p className={styles.workspace} role="status">
        {identityReady
          ? "Belt tests require current administrator access."
          : "Verifying administrator access."}
      </p>
    );
  return (
    <CurrentWorkspace
      key={scope.serial}
      requestedTarget={requestedTarget}
      scopeCurrent={scope.current}
    />
  );
}

function CurrentWorkspace({
  requestedTarget,
  scopeCurrent,
}: {
  requestedTarget: BeltTestTarget | null;
  scopeCurrent(): boolean;
}) {
  const router = useRouter();
  const { beltTests: facade, beltLadders, refreshBeltLadders } = useBeltStore();
  const programs = useProgramStore(),
    { students } = useStudentStore();
  const { refreshPrograms } = programs;
  const { studioTimezone: timezone, isPreviewMode: preview } = useConfigStore();
  const retained = useRetainedStore();
  const eventKey = useCallback(
    (id: string) => `belt-tests:event:${preview ? "preview" : "live"}:${id.toLowerCase()}`,
    [preview],
  );
  const [session, setSession] = useState<Session>(() => ({
    target: requestedTarget,
    event:
      requestedTarget?.kind === "event"
        ? (retained?.get<Readonly<Event>>(eventKey(requestedTarget.id)) ?? null)
        : null,
    serial: 0,
    loading: requestedTarget?.kind === "event",
    error: null,
  }));
  const sessionRef = useRef(session),
    alive = useRef(true),
    detailRequest = useRef(0),
    listRequest = useRef(0),
    referenceRequest = useRef(0);
  const [cursor, setCursor] = useRetainedState<string | undefined>(
    `belt-tests:events:cursor:${preview ? "preview" : "live"}`,
    undefined,
  );
  const listKey = useCallback(
    (next?: string) =>
      `belt-tests:events:${preview ? "preview" : "live"}:${JSON.stringify({ limit: 50, cursor: next ?? null })}`,
    [preview],
  );
  const [page, setPage] = useRetainedState<BeltTestEventPage | null>(
    retained ? listKey(cursor) : null,
    null,
  );
  const cursorRef = useRef(cursor);
  useLayoutEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);
  const [failedCursor, setFailedCursor] = useState<string | undefined>();
  const [listLoading, setListLoading] = useState(false),
    [listError, setListError] = useState(false);
  const [referenceState, setReferenceState] = useState<{
    status: BeltTestReferences["status"];
    ladders: readonly BeltLadder[];
  }>({ status: "loading", ladders: [] });
  const [formDirty, setFormDirty] = useState(false),
    [selectionDirty, setSelectionDirty] = useState(false);
  const editVersion = useRef(0);
  const noteFormDirty = useCallback((dirty: boolean) => {
    editVersion.current++;
    setFormDirty(dirty);
  }, []);
  const noteSelectionDirty = useCallback((dirty: boolean) => {
    editVersion.current++;
    setSelectionDirty(dirty);
  }, []);
  const [navigation, setNavigation] = useState<{
    target: BeltTestTarget | null;
    reload: boolean;
  } | null>(null);
  const requestedKey = keyOf(requestedTarget),
    lastRequested = useRef(requestedKey);
  const seenOperations = useRef(new Set<BeltTestView>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const isCurrent = useCallback(() => alive.current && scopeCurrent(), [scopeCurrent]);
  const install = useCallback(
    (next: Session) => {
      if (next.target?.kind === "event") {
        if (next.event) retained?.set(eventKey(next.target.id), next.event);
        else retained?.delete(eventKey(next.target.id));
      }
      sessionRef.current = next;
      setSession(next);
    },
    [eventKey, retained],
  );
  const { listEvents, getEvent } = facade;
  const loadList = useCallback(
    async (next?: string) => {
      if (!isCurrent()) return;
      const request = ++listRequest.current;
      setListLoading(true);
      setListError(false);
      try {
        const result = await listEvents({
          limit: 50,
          ...(next === undefined ? {} : { cursor: next }),
        });
        if (
          !isCurrent() ||
          request !== listRequest.current ||
          result.status !== "ready" ||
          !result.isCurrent()
        )
          return;
        retained?.set(listKey(next), result.value);
        if (!retained || cursorRef.current === next) setPage(result.value);
        setCursor(next);
      } catch {
        if (isCurrent() && request === listRequest.current) {
          setFailedCursor(next);
          setListError(true);
        }
      } finally {
        if (isCurrent() && request === listRequest.current) setListLoading(false);
      }
    },
    [isCurrent, listEvents, listKey, retained, setCursor, setPage],
  );
  const loadDetail = useCallback(
    async (target: BeltTestTarget, serial: number, replacing = false) => {
      if (target.kind !== "event" || !isCurrent()) return;
      const request = ++detailRequest.current,
        version = editVersion.current;
      const owns = () =>
        isCurrent() &&
        detailRequest.current === request &&
        sessionRef.current.serial === serial &&
        keyOf(sessionRef.current.target) === keyOf(target);
      install({ ...sessionRef.current, loading: true, error: null });
      try {
        const result = await getEvent(target.id);
        if (!owns() || result.status !== "ready" || !result.isCurrent()) return;
        if (replacing && editVersion.current !== version) {
          install({
            ...sessionRef.current,
            loading: false,
            error: "New local changes were kept. Reload again to discard them.",
          });
          return;
        }
        install({
          target,
          event: result.value,
          serial: serial + (replacing ? 1 : 0),
          loading: false,
          error: null,
        });
        if (replacing) {
          setFormDirty(false);
          setSelectionDirty(false);
        }
      } catch (error) {
        if (owns())
          install({
            ...sessionRef.current,
            loading: false,
            ...(error instanceof ApiError && error.status === 404 ? { event: null } : {}),
            error:
              error instanceof ApiError && error.status === 404
                ? "This event is unavailable."
                : "The current event could not be loaded. Retry keeps your local fields until a current event is available.",
          });
      } finally {
        if (owns() && sessionRef.current.loading)
          install({ ...sessionRef.current, loading: false });
      }
    },
    [getEvent, install, isCurrent],
  );
  const refreshReferences = useCallback(() => {
    if (!isCurrent() || preview) return;
    const request = ++referenceRequest.current;
    setReferenceState((previous) => ({ ...previous, status: "loading" }));
    void Promise.allSettled([
      refreshBeltLadders(),
      refreshPrograms({ includeArchived: true, force: true }),
    ]).then(([ladders, programResult]) => {
      if (!isCurrent() || request !== referenceRequest.current) return;
      setReferenceState((previous) => ({
        status:
          ladders.status === "fulfilled" && programResult.status === "fulfilled"
            ? "ready"
            : "unavailable",
        ladders: ladders.status === "fulfilled" ? ladders.value.ladders : previous.ladders,
      }));
    });
  }, [isCurrent, preview, refreshBeltLadders, refreshPrograms]);
  useEffect(() => {
    queueMicrotask(() => {
      void loadList(cursorRef.current);
      refreshReferences();
    });
  }, [loadList, refreshReferences]);
  useEffect(() => {
    if (requestedTarget?.kind === "event") void loadDetail(requestedTarget, 0);
    // The initial target belongs to this resource lifetime. Later query changes use navigation below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const applyNavigation = useCallback(
    (target: BeltTestTarget | null, reload = false) => {
      if (!isCurrent()) return;
      setNavigation(null);
      if (reload && target?.kind === "event") {
        void loadDetail(target, sessionRef.current.serial, true);
        return;
      }
      detailRequest.current++;
      const serial = sessionRef.current.serial + 1;
      const event =
        target?.kind === "event"
          ? (retained?.get<Readonly<Event>>(eventKey(target.id)) ?? null)
          : null;
      install({ target, event, serial, loading: target?.kind === "event", error: null });
      setFormDirty(false);
      setSelectionDirty(false);
      router.push(urlOf(target));
      if (target?.kind === "event") void loadDetail(target, serial);
    },
    [eventKey, install, isCurrent, loadDetail, retained, router],
  );
  const navigate = useCallback(
    (target: BeltTestTarget | null, reload = false) => {
      if (formDirty || selectionDirty) setNavigation({ target, reload });
      else applyNavigation(target, reload);
    },
    [formDirty, selectionDirty, applyNavigation],
  );
  useEffect(() => {
    if (requestedKey === lastRequested.current) return;
    lastRequested.current = requestedKey;
    if (requestedKey !== keyOf(sessionRef.current.target)) navigate(requestedTarget);
  }, [requestedKey, requestedTarget, navigate]);
  useEffect(() => {
    if (!formDirty && !selectionDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [formDirty, selectionDirty]);
  useEffect(() => {
    for (const view of facade.operations.values()) {
      if (
        !isCurrent() ||
        !view.isCurrent() ||
        seenOperations.current.has(view) ||
        !["confirmed", "unavailable"].includes(view.status)
      )
        continue;
      seenOperations.current.add(view);
      const cached = view.eventId ? retained?.get<Readonly<Event>>(eventKey(view.eventId)) : null;
      if (view.currentEvent && cached && cached.revision > view.currentEvent.revision) continue;
      if (view.eventId) {
        if (view.currentEvent) retained?.set(eventKey(view.eventId), view.currentEvent);
        else retained?.delete(eventKey(view.eventId));
        setPage((previous) =>
          previous
            ? {
                ...previous,
                items: previous.items.flatMap((row) =>
                  row.id !== view.eventId
                    ? [row]
                    : view.currentEvent
                      ? [row.revision > view.currentEvent.revision ? row : view.currentEvent]
                      : [],
                ),
              }
            : previous,
        );
      }
      const active = sessionRef.current;
      if (active.target?.kind !== "event" || active.target.id !== view.eventId) continue;
      detailRequest.current++;
      install({
        ...active,
        event: view.currentEvent,
        loading: false,
        error: view.currentEvent ? null : "This event is unavailable.",
      });
    }
  }, [eventKey, facade.operations, install, isCurrent, retained, setPage]);
  const references: BeltTestReferences = {
    status: preview
      ? "ready"
      : referenceState.status === "loading"
        ? "loading"
        : referenceState.status === "unavailable" ||
            !programs.programsLoaded ||
            programs.programsLoadError ||
            programs.programsUsageLoadError
          ? "unavailable"
          : "ready",
    ladders: preview ? beltLadders : referenceState.ladders,
    programs: programs.programs,
    retry: refreshReferences,
  };
  const capturedSerial = session.serial,
    capturedTarget = keyOf(session.target);
  const editorCurrent = useCallback(
    () =>
      isCurrent() &&
      sessionRef.current.serial === capturedSerial &&
      keyOf(sessionRef.current.target) === capturedTarget,
    [isCurrent, capturedSerial, capturedTarget],
  );
  const onCreated = useCallback(
    (event: Readonly<Event>) => {
      if (
        !isCurrent() ||
        sessionRef.current.serial !== capturedSerial ||
        sessionRef.current.target?.kind !== "draft" ||
        keyOf(sessionRef.current.target) !== capturedTarget
      )
        return;
      const target = { kind: "event" as const, id: event.id };
      install({ ...sessionRef.current, target, event, loading: false, error: null });
      router.replace(urlOf(target));
    },
    [capturedSerial, capturedTarget, install, isCurrent, router],
  );
  const onEventObserved = useCallback(
    (event: Readonly<Event> | null) => {
      if (!editorCurrent()) return;
      detailRequest.current++;
      install({
        ...sessionRef.current,
        event,
        loading: false,
        error: event ? null : "This event is unavailable.",
      });
    },
    [editorCurrent, install],
  );
  const views = [...facade.operations.values()].filter((view) => view.isCurrent() && view.message);
  return (
    <div className={styles.workspace}>
      {preview && (
        <p className={styles.notice}>Sample belt tests only. No live requests or deliveries.</p>
      )}
      <section className={styles.recovery} aria-label="Belt-test change results">
        {facade.storage.status === "blocked" && (
          <div role="alert">
            <p>{facade.storage.message}</p>
            <button
              type="button"
              onClick={() =>
                void Promise.resolve()
                  .then(() => facade.checkStorage())
                  .catch(() => undefined)
              }
            >
              Check storage
            </button>
          </div>
        )}
        {views.map((view) => (
          <div key={keyOf(view.target)} role="status">
            <p>{view.message}</p>
            {view.locked && (
              <button
                type="button"
                disabled={working(view)}
                onClick={() => {
                  if (view.isCurrent())
                    void Promise.resolve()
                      .then(() => {
                        if (view.isCurrent()) return facade.checkResult(view.target);
                      })
                      .catch(() => undefined);
                }}
              >
                Check result
              </button>
            )}
            {view.currentEvent && (
              <button
                type="button"
                onClick={() => navigate({ kind: "event", id: view.currentEvent!.id })}
              >
                Open recorded event
              </button>
            )}
          </div>
        ))}
      </section>
      <div className={styles.actions}>
        <button type="button" onClick={() => navigate({ kind: "draft", id: crypto.randomUUID() })}>
          New belt test
        </button>
        {session.target && (
          <button type="button" onClick={() => navigate(null)}>
            Event list
          </button>
        )}
      </div>
      {!session.target ? (
        <section
          className={styles.panel}
          aria-label="Belt-test events"
          aria-busy={listLoading || (!page && !listError)}
        >
          <h2>Belt-test events</h2>
          <button type="button" disabled={listLoading} onClick={() => void loadList(cursor)}>
            Refresh events
          </button>
          {!page && !listError && (
            <div className="koaryu-skeleton-reveal" role="status" aria-label="Loading events">
              {[0, 1, 2].map((row) => (
                <article key={row} className={styles.row} aria-hidden="true">
                  <div className="h-6 w-48 rounded bg-surface-raised" />
                  <div className="h-6 w-64 max-w-full rounded bg-surface-raised" />
                  <div className="h-11 w-48 rounded bg-surface-raised" />
                </article>
              ))}
            </div>
          )}
          {listError && (
            <p role="alert">
              Events could not be refreshed. Previously loaded events remain below.
            </p>
          )}
          {listError && (
            <button
              type="button"
              disabled={listLoading}
              onClick={() => void loadList(failedCursor)}
            >
              Retry events
            </button>
          )}
          {page?.items.length === 0 && <p>No events on this page.</p>}
          {page?.items.map((row) => (
            <article key={row.id} className={styles.row}>
              <h3>{row.name}</h3>
              <p>
                {row.status} · {row.location || "No location"}
              </p>
              <button type="button" onClick={() => navigate({ kind: "event", id: row.id })}>
                Open {row.name}
              </button>
            </article>
          ))}
          <div className={styles.actions}>
            <button
              type="button"
              disabled={listLoading || cursor === undefined}
              onClick={() => void loadList()}
            >
              Back to first event page
            </button>
            <button
              type="button"
              disabled={listLoading || !page?.next_cursor}
              onClick={() => void loadList(page!.next_cursor!)}
            >
              Next event page
            </button>
          </div>
        </section>
      ) : (
        <>
          {session.loading && !session.event && !formDirty && <EventPlaceholder />}
          {session.error && <p role="alert">{session.error}</p>}
          {session.error && (
            <button type="button" onClick={() => navigate(session.target, true)}>
              Retry current event
            </button>
          )}
          {(session.target.kind === "draft" || session.event || formDirty) && (
            <BeltTestEventEditor
              key={`editor-${session.serial}`}
              target={session.target}
              event={session.event}
              facade={facade}
              references={references}
              timezone={timezone}
              preview={preview}
              selectionDirty={selectionDirty}
              isCurrent={editorCurrent}
              onDirtyChange={noteFormDirty}
              onCreated={onCreated}
              reload={async () => navigate(session.target, true)}
            />
          )}
          {session.event && (
            <BeltTestRecipients
              key={`recipients-${session.serial}`}
              event={session.event}
              facade={facade}
              references={references}
              students={students}
              timezone={timezone}
              preview={preview}
              detailsDirty={formDirty}
              isCurrent={editorCurrent}
              onDirtyChange={noteSelectionDirty}
              onEventObserved={onEventObserved}
            />
          )}
        </>
      )}
      {navigation && (
        <ModalFrame
          ariaLabel="Discard unsaved belt-test changes?"
          panelClassName={styles.confirmation}
          onBackdropClick={() => {
            setNavigation(null);
            router.replace(urlOf(session.target));
          }}
        >
          <h2>Discard unsaved changes?</h2>
          <p>Your local event fields and candidate selection will be discarded.</p>
          <button
            type="button"
            onClick={() => {
              setNavigation(null);
              router.replace(urlOf(session.target));
            }}
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={() => applyNavigation(navigation.target, navigation.reload)}
          >
            Discard changes
          </button>
        </ModalFrame>
      )}
    </div>
  );
}

function EventPlaceholder() {
  const field = (name: string) => (
    <div key={name} className="space-y-1.5">
      <div className="h-6 w-28 rounded bg-surface-raised" />
      <div className="h-11 rounded bg-surface-raised" />
    </div>
  );
  return (
    <div
      className="koaryu-skeleton-reveal grid min-w-0 gap-5"
      role="status"
      aria-label="Loading current event"
      aria-busy="true"
    >
      <section className={styles.panel} aria-hidden="true">
        <div className="h-7 w-48 rounded bg-surface-raised" />
        <div className="h-6 w-64 max-w-full rounded bg-surface-raised" />
        {["Name", "Belt plan"].map(field)}
        <div className="h-6 w-48 rounded bg-surface-raised" />
        <div className={styles.timeFields}>
          <fieldset className={timeStyles.trialFields}>
            <legend>Appointment time</legend>
            {["Start date", "Start time", "End date", "End time", "Timezone"].map(field)}
            <div className={`${timeStyles.trialWide} h-12 rounded bg-surface-raised`} />
          </fieldset>
        </div>
        {field("Location")}
        <div className="h-6 w-3/4 rounded bg-surface-raised" />
        <div className={styles.actions}>
          <div className="h-11 w-36 rounded bg-surface-raised" />
          <div className="h-11 w-36 rounded bg-surface-raised" />
        </div>
      </section>
      <section className={styles.panel} aria-hidden="true">
        <h2>Candidates and recorded approvals</h2>
        <div className="h-11 w-48 rounded bg-surface-raised" />
        {[0, 1, 2].map((row) => (
          <article key={row} className={styles.row}>
            <div className="h-6 w-48 rounded bg-surface-raised" />
            <div className="h-6 w-2/3 rounded bg-surface-raised" />
          </article>
        ))}
        <h3>Recipient history</h3>
        <div className="h-16 rounded bg-surface-raised" />
      </section>
    </div>
  );
}
