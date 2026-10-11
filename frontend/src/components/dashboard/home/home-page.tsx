"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ClipboardCheck, SlidersHorizontal, TriangleAlert, UserPlus } from "lucide-react";
import { Header } from "@/components/header";
import { IntentPrefetchLink as Link } from "@/components/intent-prefetch-link";
import { Button } from "@/components/ui/button";
import {
  CalmState,
  HorizonPage,
  HorizonStats,
  usePositionSettle,
  type HorizonStat,
} from "@/components/ui/horizon";
import {
  HOME_COPY,
  homeEyebrow,
  homeGreeting,
  homeRefreshErrorDetail,
  homeSentenceText,
  homeStatCopy,
} from "@/lib/dashboard/home-copy";
import {
  buildHomeModel,
  homeRoleClass,
  homeScheduleHref,
  studioMinutesSinceMidnight,
  type HomeModel,
} from "@/lib/dashboard/home-model";
import {
  HOME_PANEL_KEYS,
  homeStatCells,
  homeStatIdsForRole,
  homeVisiblePanels,
  type HomePanelId,
  type HomeStatCell,
} from "@/lib/dashboard/home-panels";
import { useHome } from "@/lib/dashboard/use-home";
import { useHomePreferences } from "@/lib/dashboard/use-home-preferences";
import { markDashboardReadiness } from "@/lib/performance";
import { hasStaffPermission } from "@/lib/staff-permissions";
import { useConfigStore, useStudioStore } from "@/lib/store-contexts";
import { EditHomeSheet } from "./edit-home-sheet";
import { FollowUpsPanel } from "./follow-ups";
import { HomePlaceholder } from "./home-placeholder";
import { NeedsAttention } from "./needs-attention";
import { ReadyToPromotePanel } from "./ready-to-promote";
import { NewStudentsPanel } from "./recent-students";
import { TodaysClasses } from "./todays-classes";
import styles from "./home.module.css";

/*
 * Home: what needs me, what is happening today, how the studio is doing.
 * One payload from `useHome`, mapped by `buildHomeModel`, worded by
 * `home-copy`, drawn with the Horizon kit. Three states only: loading
 * (the bands' frames), error (one calm notice, last data kept) and ready.
 * The shell renders this only after identity is known, so it never renders
 * on the server and the greeting never swaps during hydration.
 */

function statItems(stats: readonly HomeStatCell[]): HorizonStat[] {
  return stats.map((stat) => {
    const copy = homeStatCopy(stat);
    return {
      id: stat.id,
      label: copy.label,
      value: copy.value,
      unit: copy.unit,
      note: copy.note,
      tone: stat.tone,
      href: stat.href,
    };
  });
}

/** A panel the role has; a null section is one the server couldn't compute. */
function HomePanel({ id, panels }: { id: HomePanelId; panels: HomeModel["panels"] }) {
  switch (id) {
    case "follow_ups":
      return <FollowUpsPanel rows={panels.followUps?.rows ?? null} />;
    case "ready_to_promote":
      return <ReadyToPromotePanel rows={panels.promotions?.rows ?? null} />;
    case "recent_students":
      return <NewStudentsPanel rows={panels.newStudents?.rows ?? null} />;
  }
}

function HomeNotice({
  detail,
  isRetrying,
  onRetry,
  title,
  tone,
}: {
  detail?: string;
  isRetrying: boolean;
  onRetry: () => void;
  title: string;
  /** warn while the last data is still showing; alert when there is nothing to show. */
  tone: "warn" | "alert";
}) {
  return (
    <div role="status" data-home-error="true">
      <CalmState
        tone={tone}
        icon={<TriangleAlert aria-hidden="true" />}
        title={title}
        detail={detail}
        action={
          <Button variant="secondary" onClick={onRetry} isLoading={isRetrying}>
            {HOME_COPY.error.retry}
          </Button>
        }
      />
    </div>
  );
}

export function HomePage() {
  const { businessDate, isPreviewMode, studioTimezone } = useConfigStore();
  const { currentRole, identityGeneration, identityReady, legalFirstName, userName } =
    useStudioStore();
  const home = useHome();
  const role = homeRoleClass(currentRole);
  const { payload } = home;
  const preferences = useHomePreferences(payload?.preferences);
  const [editing, setEditing] = useState(false);
  const editTriggerRef = useRef<HTMLButtonElement | null>(null);
  const wasEditingRef = useRef(false);
  const panelSettle = usePositionSettle<HomePanelId>();
  // The sheet edits the panels on screen, so it closes if they go (a refused read).
  const canEdit = preferences.canEdit && payload !== null;
  if (editing && !canEdit) setEditing(false);

  // D6: fixed at the first client render on the studio clock; it never changes after it appears.
  const [greeting] = useState(() =>
    homeGreeting({
      timezone: studioTimezone,
      now: new Date(),
      displayName: userName,
      legalFirstName,
    }),
  );

  const timezone = payload?.studio?.timezone ?? studioTimezone;
  // Class phases are re-read on the studio clock whenever a payload lands (the
  // hook reads at least every minute while visible); there is no separate ticker.
  const nowMinutes = useMemo(
    () => (payload ? studioMinutesSinceMidnight(timezone, new Date()) : null),
    [payload, timezone],
  );
  const model = useMemo(
    () => buildHomeModel({ state: home, role, nowMinutes }),
    [home, nowMinutes, role],
  );

  const today = model.today ?? businessDate;
  const shellReady = identityReady;
  // Ready, or an error that still shows the last payload: the bands hold real data.
  const dataReady = shellReady && payload !== null;

  useEffect(
    () =>
      markDashboardReadiness("dashboard", identityGeneration, {
        identity: identityReady,
        useful: dataReady,
        complete: dataReady,
        legacyComplete: dataReady,
      }),
    [dataReady, identityGeneration, identityReady],
  );

  // Focus goes back to "Edit Home" when the sheet closes (D5).
  useEffect(() => {
    if (wasEditingRef.current && !editing) editTriggerRef.current?.focus();
    wasEditingRef.current = editing;
  }, [editing]);

  // Edits apply at once; the panels behind the sheet settle into their new places.
  const edits = {
    onMove: (id: HomePanelId, offset: number) => {
      panelSettle.capture();
      preferences.move(id, offset);
    },
    onMoveTo: (id: HomePanelId, index: number) => {
      panelSettle.capture();
      preferences.moveTo(id, index);
    },
    onShow: (id: HomePanelId, shown: boolean) => {
      panelSettle.capture();
      preferences.setShown(id, shown);
    },
    onReset: () => {
      panelSettle.capture();
      preferences.reset();
    },
    onDone: () => {
      preferences.flush();
      setEditing(false);
    },
  };

  const takeAttendanceHref =
    model.agenda?.rows.find((row) => row.emphasized)?.href ?? homeScheduleHref(today);
  const actions = (
    <>
      {hasStaffPermission(currentRole, "create_students") ? (
        <Button asChild variant="secondary">
          <Link href="/students">
            <UserPlus aria-hidden="true" className="h-4 w-4" />
            {HOME_COPY.header.actions.addStudent}
          </Link>
        </Button>
      ) : null}
      {hasStaffPermission(currentRole, "take_attendance") ? (
        <Button asChild variant="primary">
          <Link href={takeAttendanceHref}>
            <ClipboardCheck aria-hidden="true" className="h-4 w-4" />
            {HOME_COPY.header.actions.takeAttendance}
          </Link>
        </Button>
      ) : null}
    </>
  );

  let body: ReactNode;
  if (payload === null && model.status === "error") {
    body = (
      <HorizonPage>
        <HomeNotice
          tone="alert"
          title={HOME_COPY.error.load.title}
          detail={HOME_COPY.error.load.detail}
          onRetry={home.retry}
          isRetrying={home.isRevalidating}
        />
      </HorizonPage>
    );
  } else if (payload === null) {
    body = <HomePlaceholder statIds={homeStatIdsForRole(role)} />;
  } else {
    const panels = homeVisiblePanels(preferences.preferences, role);
    body = (
      <HorizonPage>
        {/* First in the page, so the strip sits on the header's ridge. */}
        <HorizonStats
          data-home-band="stats"
          label={HOME_COPY.stats.label}
          items={statItems(homeStatCells(role, model.stats))}
        />
        {model.status === "error" ? (
          <HomeNotice
            tone="warn"
            title={HOME_COPY.error.refresh.title}
            detail={homeRefreshErrorDetail(model.asOf, timezone) ?? undefined}
            onRetry={home.retry}
            isRetrying={home.isRevalidating}
          />
        ) : null}
        {/* Fixed bands: a section the server couldn't compute keeps its band and says so. */}
        <div className={styles.bands}>
          <div data-home-band="attention">
            <NeedsAttention items={model.attention?.items ?? null} />
          </div>
          <div data-home-band="classes">
            <TodaysClasses agenda={model.agenda} />
          </div>
        </div>
        {/* D5: always here, even with every panel off; never in the Header. */}
        <div className={styles.editRow}>
          <Button
            ref={editTriggerRef}
            variant="ghost"
            data-home-edit="trigger"
            aria-haspopup="dialog"
            aria-expanded={editing}
            disabled={!canEdit}
            onClick={() => setEditing(true)}
          >
            <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
            {HOME_COPY.edit.trigger}
          </Button>
        </div>
        {panels.length > 0 ? (
          <div className={styles.panels}>
            {panels.map((id) => (
              <div key={id} ref={panelSettle.register(id)} data-home-panel={HOME_PANEL_KEYS[id]}>
                <HomePanel id={id} panels={model.panels} />
              </div>
            ))}
          </div>
        ) : null}
      </HorizonPage>
    );
  }

  return (
    <div
      className={styles.home}
      data-koaryu-dashboard-home="true"
      data-koaryu-dashboard-shell-ready={shellReady ? "true" : "false"}
      data-koaryu-dashboard-data-ready={dataReady ? "true" : "false"}
      data-koaryu-dashboard-ready={shellReady ? "true" : "false"}
      data-dashboard-provenance={isPreviewMode ? "preview" : "live"}
      data-home-status={model.status}
      aria-busy={payload === null && model.status === "loading"}
    >
      <Header
        hills="hero"
        titleId="dashboard-home-heading"
        eyebrow={homeEyebrow(today, isPreviewMode) || undefined}
        title={greeting}
        description={(model.sentence && homeSentenceText(model.sentence)) || undefined}
        reserveDescription
      >
        {actions}
      </Header>
      {body}
      {editing && canEdit ? (
        <EditHomeSheet
          preferences={preferences.preferences}
          isDefault={preferences.isDefault}
          {...edits}
        />
      ) : null}
    </div>
  );
}
