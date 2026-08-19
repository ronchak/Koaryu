"use client";

import Link from "next/link";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  CalendarCheck,
  GripVertical,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  Settings2,
  Upload,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { DatasetReadinessErrorPanel } from "@/components/dataset-readiness-panel";
import {
  buildDefaultDashboardLayout,
  DASHBOARD_LAYOUT_COLUMNS,
  DASHBOARD_LAYOUT_MAX_ROWS,
  getAddableDashboardWidgets,
  getBrowserDashboardLayoutStorage,
  getDashboardWidgetFootprint,
  moveDashboardLayoutItem,
  packDashboardLayoutItems,
  projectDashboardFrameTargetToStoredCell,
  readDashboardLayout,
  resizeDashboardLayoutItem,
  writeDashboardLayout,
  type DashboardLayout,
  type DashboardLayoutIdentity,
  type DashboardLayoutItem,
} from "@/lib/dashboard-layout-store";
import {
  chooseDashboardResizeSize,
  clampDashboardResizePreview,
  resolveDashboardPointerTarget,
  type DashboardGridMetrics,
} from "@/lib/dashboard-widget-geometry";
import {
  getDashboardWidgetComposition,
  type DashboardWidgetDensity,
} from "@/lib/dashboard-widget-composition";
import {
  DASHBOARD_WIDGET_BY_ID,
  normalizeDashboardWidgetRole,
  type DashboardWidgetId,
  type DashboardWidgetSize,
} from "@/lib/dashboard-widget-catalog";
import type { DashboardWidgetViewModel } from "@/lib/dashboard-widget-view-models";
import styles from "./dashboard-home.module.css";

type DashboardHomeProps = {
  currentRole: string | null;
  currentStudioId: string | null;
  currentUserId: string;
  datasetLoadError: string | null;
  identityReady: boolean;
  isPreviewMode: boolean;
  retryDashboardDatasets: () => void;
  studioDescription: string;
  viewModels: Record<DashboardWidgetId, DashboardWidgetViewModel>;
};

type DragSession = {
  active: boolean;
  autoScrollFrame: number | null;
  autoScrollVelocity: number;
  beforeLayout: DashboardLayout;
  grabOffsetX: number;
  grabOffsetY: number;
  gridMetrics: DashboardGridMetrics | null;
  lastClientX: number;
  lastClientY: number;
  lastColumn: number;
  lastRow: number;
  pointerId: number;
  pointerType: string;
  pendingColumn: number;
  pendingRow: number;
  previewRect: { height: number; left: number; top: number; width: number };
  reflowTimer: ReturnType<typeof setTimeout> | null;
  startX: number;
  startY: number;
  timer: ReturnType<typeof setTimeout> | null;
  widgetId: DashboardWidgetId;
};

type ResizeSession = {
  active: boolean;
  beforeLayout: DashboardLayout;
  currentSize: DashboardWidgetSize;
  gridMetrics: DashboardGridMetrics;
  pointerId: number;
  previewRect: { height: number; left: number; top: number; width: number };
  startSize: DashboardWidgetSize;
  startX: number;
  startY: number;
  widgetId: DashboardWidgetId;
};

type LiftedPreview = {
  grabX: number;
  grabY: number;
  height: number;
  left: number;
  mode: "move" | "resize";
  top: number;
  widgetId: DashboardWidgetId;
  width: number;
};

type KeyboardMoveSession = {
  beforeLayout: DashboardLayout;
  widgetId: DashboardWidgetId;
};

const DASHBOARD_WIDGET_SIZE_LABELS: Record<DashboardWidgetSize, string> = {
  "1x1": "1 by 1",
  "2x1": "2 by 1",
  "1x2": "1 by 2",
  "2x2": "2 by 2",
};

function cloneLayout(layout: DashboardLayout): DashboardLayout {
  return {
    ...layout,
    items: layout.items.map((item) => ({ ...item })),
    removed_widget_ids: [...layout.removed_widget_ids],
  };
}

function layoutIdentity(
  userId: string,
  studioId: string | null,
  role: string | null
): DashboardLayoutIdentity | null {
  const normalizedRole = normalizeDashboardWidgetRole(role);
  return userId && studioId && normalizedRole
    ? { userId, studioId, role: normalizedRole }
    : null;
}

function stateLabel(state: DashboardWidgetViewModel["state"]): string {
  if (state === "ready") return "Ready";
  if (state === "empty") return "Empty";
  if (state === "loading") return "Loading";
  if (state === "error") return "Error";
  if (state === "partial") return "Partial";
  return "Unavailable";
}

function isMaterialState(state: DashboardWidgetViewModel["state"]): boolean {
  return state === "loading" || state === "error" || state === "partial" || state === "unavailable";
}

const LIFT_STYLE_PROPERTIES = [
  "--dashboard-lift-translate-x",
  "--dashboard-lift-translate-y",
  "--dashboard-lift-width",
  "--dashboard-lift-height",
] as const;

function releaseLiftStyles(node: HTMLElement | null | undefined) {
  if (!node) return;
  for (const property of LIFT_STYLE_PROPERTIES) {
    node.style.removeProperty(property);
  }
}

function readSettleDuration(node: HTMLElement): number {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return 0;
  }
  const value = window.getComputedStyle(node).getPropertyValue("--product-motion-settle-duration").trim();
  if (value.endsWith("ms")) {
    const duration = Number.parseFloat(value);
    return Number.isFinite(duration) ? duration : 200;
  }
  if (value.endsWith("s")) {
    const duration = Number.parseFloat(value) * 1000;
    return Number.isFinite(duration) ? duration : 200;
  }
  return 200;
}

function readGridMetrics(
  sequence: HTMLElement,
  itemRect: DOMRect,
  size: DashboardWidgetSize
): DashboardGridMetrics | null {
  const style = window.getComputedStyle(sequence);
  if (style.display !== "grid") {
    return null;
  }
  const columnTracks = style.gridTemplateColumns
    .split(/\s+/)
    .map((value) => Number.parseFloat(value))
    .filter(Number.isFinite);
  if (columnTracks.length === 0) {
    return null;
  }
  const footprint = getDashboardWidgetFootprint(size);
  const sequenceRect = sequence.getBoundingClientRect();
  const columnGap = Number.parseFloat(style.columnGap) || 0;
  const rowGap = Number.parseFloat(style.rowGap) || 0;
  const rowHeight = (itemRect.height - rowGap * (footprint.rows - 1)) / footprint.rows;
  return {
    columnGap,
    columnWidth: columnTracks[0] ?? itemRect.width,
    columns: columnTracks.length,
    maxRows: DASHBOARD_LAYOUT_MAX_ROWS,
    rowGap,
    rowHeight: Math.max(1, rowHeight),
    sequenceLeft: sequenceRect.left,
    sequenceTop: sequenceRect.top,
  };
}

function sourceActionLabel(widgetId: DashboardWidgetId): string {
  const labels: Record<DashboardWidgetId, string> = {
    needs_attention: "Review priorities",
    classes_today: "Open schedule",
    student_pulse: "View students",
    attendance: "View attendance",
    lead_follow_ups: "Review leads",
    promotions_due: "Open belt tracker",
    billing_exceptions: "Review billing",
    revenue_due: "Open billing",
    setup_progress: "Continue setup",
    recent_students: "View students",
    saved_report: "Open reports",
    quick_actions: "Open dashboard",
    emergency_contacts: "Review students",
  };
  return labels[widgetId];
}

function MaterialState({ model }: { model: DashboardWidgetViewModel }) {
  if (!isMaterialState(model.state)) {
    return null;
  }
  return <span className={styles.stateStamp}>{stateLabel(model.state)}</span>;
}

function RatioRing({ model }: { model: DashboardWidgetViewModel }) {
  const ratio = model.visual && model.visual.max > 0
    ? Math.min(1, Math.max(0, model.visual.value / model.visual.max))
    : 0;
  const offset = 100 - Math.round(ratio * 100);
  return (
    <div className={styles.ratioLayout}>
      <div className={styles.ring} aria-label={model.visual?.label}>
        <svg viewBox="0 0 42 42" aria-hidden="true">
          <circle className={styles.ringTrack} cx="21" cy="21" r="16" />
          <circle className={styles.ringValue} cx="21" cy="21" r="16" pathLength="100" strokeDasharray="100" strokeDashoffset={offset} />
        </svg>
        <strong>{model.metric}</strong>
      </div>
      <p className={styles.detail}>{model.detail}</p>
    </div>
  );
}

function AgendaContent({
  maxRows,
  model,
}: {
  maxRows: number;
  model: DashboardWidgetViewModel;
}) {
  return (
    <div className={styles.agendaContent}>
      <div className={styles.agendaSummary}>
        <strong>{model.metric}</strong>
        <span>sessions today</span>
      </div>
      {model.rows.length > 0 ? (
        <ol className={styles.agenda}>
          {model.rows.slice(0, maxRows).map((row, rowIndex) => {
            const [time = row.meta, count] = row.meta?.split(" · ") ?? [];
            return (
              <li key={`${row.label}-${rowIndex}`}>
                <time>{time}</time>
                <span><strong>{row.label}</strong>{count ? <small>{count}</small> : null}</span>
              </li>
            );
          })}
        </ol>
      ) : <p className={styles.detail}>{model.detail}</p>}
    </div>
  );
}

function QueueContent({
  maxRows,
  model,
}: {
  maxRows: number;
  model: DashboardWidgetViewModel;
}) {
  return (
    <div className={styles.queueLayout}>
      {model.metric ? <strong className={styles.queueCount}>{model.metric}</strong> : null}
      {model.rows.length > 0 ? (
        <ul className={styles.queue}>
          {model.rows.slice(0, maxRows).map((row, rowIndex) => (
            <li key={`${row.label}-${rowIndex}`}>
              {row.href ? (
                <Link href={row.href}><span className={styles.rowLabel}>{row.label}</span></Link>
              ) : <strong className={styles.rowLabel}>{row.label}</strong>}
              {row.meta ? <small>{row.meta}</small> : null}
            </li>
          ))}
        </ul>
      ) : <p className={styles.detail}>{model.detail}</p>}
    </div>
  );
}

function AttendanceContent({ model }: { model: DashboardWidgetViewModel }) {
  const ratio = model.visual && model.visual.max > 0 ? model.visual.value / model.visual.max : 0;
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * 10);
  return (
    <>
      <strong className={styles.metric}>{model.metric}</strong>
      <div className={styles.microBars} aria-label={model.visual?.label}>
        {Array.from({ length: 10 }, (_, index) => <span key={index} data-filled={index < filled} />)}
      </div>
      <p className={styles.detail}>{model.detail}</p>
    </>
  );
}

function SetupContent({
  density,
  model,
}: {
  density: DashboardWidgetDensity;
  model: DashboardWidgetViewModel;
}) {
  return (
    <>
      <RatioRing model={model} />
      {model.rows.length > 0 && (density === "tall" || density === "full") ? (
        <ul className={styles.setupSteps}>
          {model.rows.slice(0, 2).map((row) => (
            <li key={row.label}>{row.href ? <Link href={row.href}>{row.label}</Link> : row.label}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

const QUICK_ACTION_ICONS = [UserPlus, Upload, Users, CalendarCheck] as const;

function QuickActionsContent({
  actionCapacity,
  model,
}: {
  actionCapacity: number;
  model: DashboardWidgetViewModel;
}) {
  return (
    <div className={styles.quickActions}>
      {model.actions.slice(0, actionCapacity).map((action, index) => {
        const Icon = QUICK_ACTION_ICONS[index] ?? Plus;
        return <Link href={action.href} key={action.href}><Icon aria-hidden="true" size={18} /><span>{action.label}</span></Link>;
      })}
    </div>
  );
}

function WidgetContent({
  actionCapacity,
  density,
  maxRows,
  model,
  stateRuleCapacity,
}: {
  actionCapacity: number;
  density: DashboardWidgetDensity;
  maxRows: number;
  model: DashboardWidgetViewModel;
  stateRuleCapacity: number;
}) {
  if (model.state === "loading" || model.state === "error" || model.state === "unavailable") {
    return (
      <div className={styles.stateBody}>
        <p className={styles.detail}>{model.detail}</p>
        {Array.from({ length: stateRuleCapacity }, (_, index) => (
          <span className={styles.stateRule} aria-hidden="true" key={index} />
        ))}
      </div>
    );
  }
  if (model.state === "partial" && model.rows.length === 0) {
    return <p className={styles.detail}>{model.detail}</p>;
  }
  if (model.id === "classes_today") return <AgendaContent maxRows={maxRows} model={model} />;
  if (model.id === "student_pulse") return <RatioRing model={model} />;
  if (model.id === "attendance") return <AttendanceContent model={model} />;
  if (model.id === "setup_progress") return <SetupContent density={density} model={model} />;
  if (model.id === "quick_actions") {
    return <QuickActionsContent actionCapacity={actionCapacity} model={model} />;
  }
  if (["needs_attention", "lead_follow_ups", "promotions_due", "recent_students"].includes(model.id)) {
    return <QueueContent maxRows={maxRows} model={model} />;
  }
  return (
    <>
      {model.metric ? <strong className={styles.metric}>{model.metric}</strong> : null}
      <p className={styles.detail}>{model.detail}</p>
    </>
  );
}

function HomeWidget({
  index,
  item,
  isCustomizing,
  isPickedUp,
  isSelected,
  liftedPreview,
  model,
  moveHandleRef,
  onMoveKeyDown,
  onPointerDown,
  onPointerCancel,
  onLostPointerCapture,
  onPointerMove,
  onPointerUp,
  onRemove,
  onResize,
  onResizePointerCancel,
  onResizePointerDown,
  onResizePointerMove,
  onResizePointerUp,
  panelRef,
  tabletItem,
  total,
}: {
  index: number;
  item: DashboardLayoutItem;
  isCustomizing: boolean;
  isPickedUp: boolean;
  isSelected: boolean;
  liftedPreview: LiftedPreview | null;
  model: DashboardWidgetViewModel;
  moveHandleRef: (node: HTMLButtonElement | null) => void;
  onMoveKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, widgetId: DashboardWidgetId) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, widgetId: DashboardWidgetId) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onRemove: (widgetId: DashboardWidgetId) => void;
  onResize: (widgetId: DashboardWidgetId) => void;
  onResizePointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>, widgetId: DashboardWidgetId) => void;
  onResizePointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResizePointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  panelRef: (node: HTMLElement | null) => void;
  tabletItem: DashboardLayoutItem;
  total: number;
}) {
  const catalog = DASHBOARD_WIDGET_BY_ID.get(item.widget_id);
  if (!catalog) {
    return null;
  }
  const composition = getDashboardWidgetComposition(item.size);
  const maxRows = composition.rowCapacity;
  const hiddenRows = Math.max(
    0,
    (model.id === "quick_actions" ? model.actions.length - composition.actionCapacity : model.rows.length - maxRows)
      + (model.overflowCount ?? 0)
  );
  const footprint = getDashboardWidgetFootprint(item.size);
  const widgetStyle = {
    "--dashboard-column": item.column + 1,
    "--dashboard-row": item.row + 1,
    "--dashboard-column-span": footprint.columns,
    "--dashboard-row-span": footprint.rows,
    "--dashboard-tablet-column": tabletItem.column + 1,
    "--dashboard-tablet-row": tabletItem.row + 1,
    ...(liftedPreview ? {
      "--dashboard-lift-height": `${liftedPreview.height}px`,
      "--dashboard-lift-left": `${liftedPreview.left}px`,
      "--dashboard-lift-top": `${liftedPreview.top}px`,
      "--dashboard-lift-width": `${liftedPreview.width}px`,
      "--dashboard-lift-grab-x": `${liftedPreview.grabX}px`,
      "--dashboard-lift-grab-y": `${liftedPreview.grabY}px`,
    } : {}),
  } as CSSProperties;

  return (
    <article
      ref={panelRef}
      className={`${styles.widget} ${catalog.fixed ? styles.attentionWidget : ""} ${isPickedUp ? styles.pickedUp : ""} ${liftedPreview ? styles.lifted : ""}`}
      data-interaction={liftedPreview?.mode}
      data-selected={isSelected ? "true" : "false"}
      data-density={composition.density}
      data-widget-id={item.widget_id}
      data-size={item.size}
      data-state={model.state}
      style={widgetStyle}
      tabIndex={-1}
      aria-label={`${catalog.title}, row ${item.row + 1}, column ${item.column + 1}, ${DASHBOARD_WIDGET_SIZE_LABELS[item.size]}, position ${index + 1} of ${total}`}
      onPointerDown={(event) => onPointerDown(event, item.widget_id)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
    >
      <header className={styles.widgetBand}>
        <div className={styles.bandTitle}>
          <span>{catalog.title}</span>
          <MaterialState model={model} />
        </div>
        {isCustomizing && !catalog.fixed ? (
          <div className={styles.editControls} aria-label={`${catalog.title} layout controls`}>
            {catalog.removable ? (
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onRemove(item.widget_id)}
                aria-label={`Remove ${catalog.title}`}
                title="Remove"
              >
                <Minus aria-hidden="true" size={17} /><span className={styles.controlLabel}>Remove</span>
              </button>
            ) : null}
            <button
              ref={moveHandleRef}
              type="button"
              className={styles.dragHandle}
              aria-label={isPickedUp
                ? `${catalog.title} move picked up. Use arrow keys to move, Space or Enter to drop, or Escape to cancel.`
                : `Move ${catalog.title}. Press Space or Enter to pick up.`}
              aria-pressed={isPickedUp}
              aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Space Enter Escape"
              onKeyDown={(event) => onMoveKeyDown(event, item.widget_id)}
            >
              <GripVertical aria-hidden="true" size={18} />
              <span className={styles.controlLabel}>Move</span>
            </button>
          </div>
        ) : isCustomizing && catalog.fixed ? <span className={styles.fixedLabel}>Fixed</span> : null}
      </header>

      {isCustomizing && !catalog.fixed && catalog.allowedSizes.length > 1 ? (
        <button
          type="button"
          className={styles.resizeHandle}
          onPointerDown={(event) => onResizePointerDown(event, item.widget_id)}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerCancel}
          onLostPointerCapture={onResizePointerCancel}
          onClick={(event) => {
            if (event.detail === 0) onResize(item.widget_id);
          }}
          aria-label={`Resize ${catalog.title}. Drag to resize or press Enter to use the next size.`}
          title="Drag to resize"
        >
          <Maximize2 aria-hidden="true" size={17} /><span className={styles.controlLabel}>Resize</span>
        </button>
      ) : null}

      <div className={styles.widgetBody}>
        <WidgetContent
          actionCapacity={composition.actionCapacity}
          density={composition.density}
          maxRows={maxRows}
          model={model}
          stateRuleCapacity={composition.stateRuleCapacity}
        />
      </div>

      <footer className={styles.widgetFooting}>
        <span className={styles.provenance}>{model.provenanceLabel}</span>
        {model.id !== "quick_actions" ? (
          <Link className={styles.sourceLink} href={catalog.sourceRoute}>
            {sourceActionLabel(model.id)}{hiddenRows > 0 ? ` · ${hiddenRows} more` : ""}
          </Link>
        ) : <span className={styles.footingStatus}>Route actions</span>}
      </footer>
    </article>
  );
}

export function DashboardHome({
  currentRole,
  currentStudioId,
  currentUserId,
  datasetLoadError,
  identityReady,
  isPreviewMode,
  retryDashboardDatasets,
  viewModels,
}: DashboardHomeProps) {
  const identity = useMemo(
    () => layoutIdentity(currentUserId, currentStudioId, currentRole),
    [currentRole, currentStudioId, currentUserId]
  );
  const identityScope = identity
    ? `${identity.userId}\u0000${identity.studioId}\u0000${identity.role}`
    : null;
  const [layout, setLayout] = useState<DashboardLayout>(() => buildDefaultDashboardLayout(currentRole));
  const [resolvedLayoutScope, setResolvedLayoutScope] = useState<string | null>(null);
  const layoutResolved = identityReady && identityScope !== null && resolvedLayoutScope === identityScope;
  const [isCustomizing, setIsCustomizing] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [activeDragWidgetId, setActiveDragWidgetId] = useState<DashboardWidgetId | null>(null);
  const [selectedWidgetId, setSelectedWidgetId] = useState<DashboardWidgetId | null>(null);
  const [liftedPreview, setLiftedPreview] = useState<LiftedPreview | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const layoutRef = useRef(layout);
  const homeRef = useRef<HTMLDivElement>(null);
  const sequenceRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef<DashboardLayout | null>(null);
  const panelRefs = useRef(new Map<DashboardWidgetId, HTMLElement>());
  const moveHandleRefs = useRef(new Map<DashboardWidgetId, HTMLButtonElement>());
  const pendingPanelRectsRef = useRef<Map<DashboardWidgetId, DOMRect> | null>(null);
  const panelAnimationsRef = useRef(new Map<DashboardWidgetId, Animation>());
  const dragRef = useRef<DragSession | null>(null);
  const resizeRef = useRef<ResizeSession | null>(null);
  const touchMoveBlockerRef = useRef<((event: TouchEvent) => void) | null>(null);
  const keyboardMoveRef = useRef<KeyboardMoveSession | null>(null);
  const addPanelsTriggerRef = useRef<HTMLButtonElement>(null);
  const customizeTriggerRef = useRef<HTMLButtonElement>(null);
  const libraryHeadingRef = useRef<HTMLHeadingElement>(null);
  const libraryRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active || !identityReady || !identity) {
        return;
      }
      const nextLayout = readDashboardLayout(getBrowserDashboardLayoutStorage(), identity).layout;
      layoutRef.current = nextLayout;
      setLayout(nextLayout);
      setPersistenceError(null);
      setResolvedLayoutScope(identityScope);
      setIsCustomizing(false);
      setIsLibraryOpen(false);
      setActiveDragWidgetId(null);
      setSelectedWidgetId(null);
      setLiftedPreview(null);
      keyboardMoveRef.current = null;
      snapshotRef.current = null;
      const dragSession = dragRef.current;
      if (dragSession?.timer) {
        clearTimeout(dragSession.timer);
      }
      if (dragSession?.reflowTimer) {
        clearTimeout(dragSession.reflowTimer);
      }
      if (dragSession?.autoScrollFrame) {
        cancelAnimationFrame(dragSession.autoScrollFrame);
      }
      releaseLiftStyles(dragSession ? panelRefs.current.get(dragSession.widgetId) : null);
      releaseLiftStyles(resizeRef.current ? panelRefs.current.get(resizeRef.current.widgetId) : null);
      if (touchMoveBlockerRef.current) {
        document.removeEventListener("touchmove", touchMoveBlockerRef.current);
        touchMoveBlockerRef.current = null;
      }
      dragRef.current = null;
      resizeRef.current = null;
    });
    return () => {
      active = false;
    };
  }, [identity, identityReady, identityScope]);

  const capturePanelPositions = useCallback(() => {
    if (!layoutResolved) {
      return;
    }
    pendingPanelRectsRef.current = new Map(
      Array.from(panelRefs.current, ([widgetId, node]) => [widgetId, node.getBoundingClientRect()])
    );
  }, [layoutResolved]);

  useLayoutEffect(() => {
    const previousRects = pendingPanelRectsRef.current;
    pendingPanelRectsRef.current = null;
    const home = homeRef.current;
    if (!layoutResolved || !home || !previousRects) {
      return;
    }

    const duration = readSettleDuration(home);
    for (const [widgetId, node] of panelRefs.current) {
      const previousRect = previousRects.get(widgetId);
      if (!previousRect || liftedPreview?.widgetId === widgetId) {
        continue;
      }
      panelAnimationsRef.current.get(widgetId)?.cancel();
      const nextRect = node.getBoundingClientRect();
      const translateX = previousRect.left - nextRect.left;
      const translateY = previousRect.top - nextRect.top;
      const scaleX = nextRect.width > 0 ? previousRect.width / nextRect.width : 1;
      const scaleY = nextRect.height > 0 ? previousRect.height / nextRect.height : 1;
      if (
        Math.abs(translateX) < 1
        && Math.abs(translateY) < 1
        && Math.abs(scaleX - 1) < 0.01
        && Math.abs(scaleY - 1) < 0.01
      ) {
        continue;
      }
      if (duration === 0) {
        continue;
      }
      const changesSize = Math.abs(scaleX - 1) >= 0.01 || Math.abs(scaleY - 1) >= 0.01;
      const keyframes = changesSize
        ? [{ opacity: 0.78, zIndex: "3" }, { opacity: 1, zIndex: "3" }]
        : [
            { transform: `translate3d(${translateX}px, ${translateY}px, 0)`, zIndex: "3" },
            { transform: "translate3d(0, 0, 0)", zIndex: "3" },
          ];
      const animation = node.animate(keyframes, {
        duration: Math.round(duration * 1.35),
        easing: "cubic-bezier(.16, 1, .3, 1)",
      });
      panelAnimationsRef.current.set(widgetId, animation);
      void animation.finished.catch(() => undefined).finally(() => {
        if (panelAnimationsRef.current.get(widgetId) === animation) {
          panelAnimationsRef.current.delete(widgetId);
        }
      });
    }
  }, [layout.items, layoutResolved, liftedPreview]);

  useEffect(() => () => {
    for (const animation of panelAnimationsRef.current.values()) {
      animation.cancel();
    }
    panelAnimationsRef.current.clear();
  }, []);

  const saveLayout = useCallback((next: DashboardLayout) => {
    if (identity) {
      const result = writeDashboardLayout(getBrowserDashboardLayoutStorage(), identity, next);
      layoutRef.current = result.layout;
      setLayout(result.layout);
      setPersistenceError(result.ok ? null : "This browser could not save your arrangement. It will reset after you leave or reload this page.");
      return;
    }
    layoutRef.current = next;
    setLayout(next);
    setPersistenceError("Your studio role is still loading, so this arrangement cannot be saved yet.");
  }, [identity]);

  const updateLayoutInMemory = useCallback((next: DashboardLayout) => {
    layoutRef.current = next;
    setLayout(next);
  }, []);

  const clearDragSession = useCallback(() => {
    const session = dragRef.current;
    if (session?.timer) {
      clearTimeout(session.timer);
    }
    if (session?.reflowTimer) {
      clearTimeout(session.reflowTimer);
    }
    if (session?.autoScrollFrame) {
      cancelAnimationFrame(session.autoScrollFrame);
    }
    releaseLiftStyles(session ? panelRefs.current.get(session.widgetId) : null);
    if (touchMoveBlockerRef.current) {
      document.removeEventListener("touchmove", touchMoveBlockerRef.current);
      touchMoveBlockerRef.current = null;
    }
    dragRef.current = null;
    setActiveDragWidgetId(null);
    setLiftedPreview((current) => current?.mode === "move" ? null : current);
  }, []);

  const clearResizeSession = useCallback(() => {
    const session = resizeRef.current;
    releaseLiftStyles(session ? panelRefs.current.get(session.widgetId) : null);
    resizeRef.current = null;
    setLiftedPreview((current) => current?.mode === "resize" ? null : current);
  }, []);

  useEffect(() => () => {
    const session = dragRef.current;
    if (session?.timer) {
      clearTimeout(session.timer);
    }
    if (session?.reflowTimer) {
      clearTimeout(session.reflowTimer);
    }
    if (session?.autoScrollFrame) {
      cancelAnimationFrame(session.autoScrollFrame);
    }
    releaseLiftStyles(session ? panelRefs.current.get(session.widgetId) : null);
    releaseLiftStyles(resizeRef.current ? panelRefs.current.get(resizeRef.current.widgetId) : null);
    if (touchMoveBlockerRef.current) {
      document.removeEventListener("touchmove", touchMoveBlockerRef.current);
      touchMoveBlockerRef.current = null;
    }
    dragRef.current = null;
    resizeRef.current = null;
  }, []);

  const focusWidget = useCallback((widgetId: DashboardWidgetId) => {
    requestAnimationFrame(() => panelRefs.current.get(widgetId)?.focus());
  }, []);

  const focusMoveHandle = useCallback((widgetId: DashboardWidgetId) => {
    requestAnimationFrame(() => moveHandleRefs.current.get(widgetId)?.focus());
  }, []);

  const openLibrary = useCallback(() => {
    if (!layoutResolved) {
      return;
    }
    setIsLibraryOpen(true);
  }, [layoutResolved]);

  const closeLibrary = useCallback(() => {
    setIsLibraryOpen(false);
    requestAnimationFrame(() => addPanelsTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (isLibraryOpen) {
      requestAnimationFrame(() => libraryHeadingRef.current?.focus());
    }
  }, [isLibraryOpen]);

  const announcePosition = useCallback((widgetId: DashboardWidgetId, nextItems: DashboardLayoutItem[]) => {
    const item = nextItems.find((candidate) => candidate.widget_id === widgetId);
    const title = DASHBOARD_WIDGET_BY_ID.get(widgetId)?.title ?? "Panel";
    if (item) setAnnouncement(`${title} moved to row ${item.row + 1}, column ${item.column + 1}.`);
  }, []);

  const resizeWidget = useCallback((widgetId: DashboardWidgetId) => {
    const catalog = DASHBOARD_WIDGET_BY_ID.get(widgetId);
    const currentLayout = layoutRef.current;
    const currentItem = currentLayout.items.find((item) => item.widget_id === widgetId);
    if (!catalog || !currentItem || catalog.allowedSizes.length < 2) {
      return;
    }
    const currentSizeIndex = catalog.allowedSizes.indexOf(currentItem.size);
    const nextSize = catalog.allowedSizes[(currentSizeIndex + 1) % catalog.allowedSizes.length];
    if (!nextSize) {
      return;
    }
    const next = {
      ...currentLayout,
      items: resizeDashboardLayoutItem(currentLayout.items, widgetId, nextSize),
    };
    capturePanelPositions();
    saveLayout(next);
    setAnnouncement(`${catalog.title} resized to ${DASHBOARD_WIDGET_SIZE_LABELS[nextSize]}.`);
  }, [capturePanelPositions, saveLayout]);

  const removeWidget = useCallback((widgetId: DashboardWidgetId) => {
    const catalog = DASHBOARD_WIDGET_BY_ID.get(widgetId);
    if (!catalog?.removable) {
      return;
    }
    const currentLayout = layoutRef.current;
    const currentIndex = currentLayout.items.findIndex((item) => item.widget_id === widgetId);
    const remainingItems = currentLayout.items.filter((item) => item.widget_id !== widgetId);
    const next = {
      ...currentLayout,
      items: remainingItems,
      removed_widget_ids: Array.from(new Set([...currentLayout.removed_widget_ids, widgetId])),
    };
    capturePanelPositions();
    saveLayout(next);
    setSelectedWidgetId((current) => current === widgetId ? null : current);
    setAnnouncement(`${catalog.title} removed. It remains available in Add panels.`);
    const focusTarget = remainingItems[Math.min(currentIndex, remainingItems.length - 1)];
    if (focusTarget) {
      focusWidget(focusTarget.widget_id);
    } else {
      requestAnimationFrame(() => customizeTriggerRef.current?.focus());
    }
  }, [capturePanelPositions, focusWidget, saveLayout]);

  const addWidget = useCallback((widgetId: DashboardWidgetId) => {
    const catalog = DASHBOARD_WIDGET_BY_ID.get(widgetId);
    const currentLayout = layoutRef.current;
    if (!catalog || currentLayout.items.some((item) => item.widget_id === widgetId)) {
      return;
    }
    const next = {
      ...currentLayout,
      items: packDashboardLayoutItems([
        ...currentLayout.items,
        { widget_id: widgetId, size: catalog.defaultSize },
      ]),
      removed_widget_ids: currentLayout.removed_widget_ids.filter((id) => id !== widgetId),
    };
    capturePanelPositions();
    saveLayout(next);
    const added = next.items.find((item) => item.widget_id === widgetId);
    setAnnouncement(`${catalog.title} added at row ${(added?.row ?? 0) + 1}, column ${(added?.column ?? 0) + 1}.`);
    setIsLibraryOpen(false);
    focusWidget(widgetId);
  }, [capturePanelPositions, focusWidget, saveLayout]);

  const enterCustomize = useCallback(() => {
    if (!layoutResolved) {
      setAnnouncement("Your role-safe arrangement is still loading.");
      return;
    }
    const currentLayout = layoutRef.current;
    snapshotRef.current = cloneLayout(currentLayout);
    setSelectedWidgetId(null);
    setIsCustomizing(true);
    setAnnouncement("Customize mode started. Drag a panel to move it, use its corner handle to resize, or use the keyboard move control.");
  }, [layoutResolved]);

  const finishCustomize = useCallback(() => {
    const pointerSnapshot = dragRef.current?.active
      ? dragRef.current.beforeLayout
      : resizeRef.current?.active
        ? resizeRef.current.beforeLayout
        : null;
    if (pointerSnapshot) {
      capturePanelPositions();
      saveLayout(pointerSnapshot);
    } else if (keyboardMoveRef.current) {
      saveLayout(layoutRef.current);
    }
    clearDragSession();
    clearResizeSession();
    keyboardMoveRef.current = null;
    snapshotRef.current = null;
    setIsCustomizing(false);
    setSelectedWidgetId(null);
    setIsLibraryOpen(false);
    setAnnouncement("Customize mode finished.");
    requestAnimationFrame(() => customizeTriggerRef.current?.focus());
  }, [capturePanelPositions, clearDragSession, clearResizeSession, saveLayout]);

  const cancelCustomize = useCallback(() => {
    clearDragSession();
    clearResizeSession();
    keyboardMoveRef.current = null;
    const snapshot = snapshotRef.current;
    if (snapshot) {
      capturePanelPositions();
      saveLayout(snapshot);
    }
    snapshotRef.current = null;
    setIsCustomizing(false);
    setSelectedWidgetId(null);
    setIsLibraryOpen(false);
    setAnnouncement("Changes canceled. The previous arrangement was restored.");
    requestAnimationFrame(() => customizeTriggerRef.current?.focus());
  }, [capturePanelPositions, clearDragSession, clearResizeSession, saveLayout]);

  const cancelActiveMove = useCallback(() => {
    const pointerSession = dragRef.current;
    const keyboardSession = keyboardMoveRef.current;
    const session = pointerSession?.active ? pointerSession : keyboardSession;
    if (!session) return false;
    capturePanelPositions();
    updateLayoutInMemory(cloneLayout(session.beforeLayout));
    const widgetId = session.widgetId;
    clearDragSession();
    keyboardMoveRef.current = null;
    setAnnouncement(`${DASHBOARD_WIDGET_BY_ID.get(widgetId)?.title ?? "Panel"} move canceled. Previous placement restored.`);
    focusMoveHandle(widgetId);
    return true;
  }, [capturePanelPositions, clearDragSession, focusMoveHandle, updateLayoutInMemory]);

  const cancelActiveResize = useCallback(() => {
    const session = resizeRef.current;
    if (!session) return false;
    if (session.active) {
      capturePanelPositions();
      updateLayoutInMemory(cloneLayout(session.beforeLayout));
    }
    const widgetId = session.widgetId;
    clearResizeSession();
    setAnnouncement(`${DASHBOARD_WIDGET_BY_ID.get(widgetId)?.title ?? "Panel"} resize canceled. Previous size restored.`);
    focusWidget(widgetId);
    return true;
  }, [capturePanelPositions, clearResizeSession, focusWidget, updateLayoutInMemory]);

  const onMoveKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLButtonElement>,
    widgetId: DashboardWidgetId
  ) => {
    const title = DASHBOARD_WIDGET_BY_ID.get(widgetId)?.title ?? "Panel";
    const session = keyboardMoveRef.current;
    if (event.key === "Escape" && session?.widgetId === widgetId) {
      event.preventDefault();
      event.stopPropagation();
      cancelActiveMove();
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (session?.widgetId === widgetId) {
        saveLayout(layoutRef.current);
        keyboardMoveRef.current = null;
        setActiveDragWidgetId(null);
        const item = layoutRef.current.items.find((candidate) => candidate.widget_id === widgetId);
        setAnnouncement(`${title} dropped at row ${(item?.row ?? 0) + 1}, column ${(item?.column ?? 0) + 1}.`);
      } else if (!session && !dragRef.current && !resizeRef.current) {
        keyboardMoveRef.current = { beforeLayout: cloneLayout(layoutRef.current), widgetId };
        setActiveDragWidgetId(widgetId);
        setAnnouncement(`${title} picked up. Use arrow keys to move, then Space or Enter to drop.`);
      } else {
        const activeId = session?.widgetId ?? dragRef.current?.widgetId;
        const activeTitle = activeId ? DASHBOARD_WIDGET_BY_ID.get(activeId)?.title : "Another panel";
        setAnnouncement(`${activeTitle ?? "Another panel"} is already picked up. Drop or cancel it before moving ${title}.`);
      }
      return;
    }
    if (!session || session.widgetId !== widgetId || !event.key.startsWith("Arrow")) return;
    const direction = event.key.slice(5);
    const deltas: Record<string, { column: number; row: number }> = {
      Left: { column: -1, row: 0 },
      Right: { column: 1, row: 0 },
      Up: { column: 0, row: -1 },
      Down: { column: 0, row: 1 },
    };
    const delta = deltas[direction];
    const item = layoutRef.current.items.find((candidate) => candidate.widget_id === widgetId);
    if (!delta || !item) return;
    event.preventDefault();
    const nextItems = moveDashboardLayoutItem(
      layoutRef.current.items,
      widgetId,
      item.column + delta.column,
      item.row + delta.row
    );
    capturePanelPositions();
    updateLayoutInMemory({ ...layoutRef.current, items: nextItems });
    announcePosition(widgetId, nextItems);
  }, [announcePosition, cancelActiveMove, capturePanelPositions, saveLayout, updateLayoutInMemory]);

  useEffect(() => {
    if (!isCustomizing) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (isLibraryOpen && event.key === "Tab") {
        const library = libraryRef.current;
        const focusable = library
          ? Array.from(library.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), [tabindex]:not([tabindex='-1'])"))
          : [];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first && last) {
          if (event.shiftKey && (document.activeElement === first || document.activeElement === libraryHeadingRef.current)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (cancelActiveMove()) return;
        if (cancelActiveResize()) return;
        if (isLibraryOpen) {
          closeLibrary();
          setAnnouncement("Panel library closed.");
          return;
        }
        cancelCustomize();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelActiveMove, cancelActiveResize, cancelCustomize, closeLibrary, isCustomizing, isLibraryOpen]);

  const resetLayout = useCallback(() => {
    const next = {
      ...buildDefaultDashboardLayout(currentRole),
      client_id: layoutRef.current.client_id,
    };
    capturePanelPositions();
    saveLayout(next);
    setAnnouncement("Dashboard reset to the role-safe default arrangement.");
    focusWidget("needs_attention");
  }, [capturePanelPositions, currentRole, focusWidget, saveLayout]);

  const startDrag = useCallback((widgetId: DashboardWidgetId, pointerId: number) => {
    if (!isCustomizing) {
      clearDragSession();
      return;
    }
    const session = dragRef.current;
    if (!session || session.pointerId !== pointerId || session.widgetId !== widgetId) {
      return;
    }
    const node = panelRefs.current.get(widgetId);
    releaseLiftStyles(node);
    session.active = true;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    if (session.pointerType === "touch" && !touchMoveBlockerRef.current) {
      const blockActiveTouchMove = (event: TouchEvent) => {
        if (dragRef.current?.active) event.preventDefault();
      };
      touchMoveBlockerRef.current = blockActiveTouchMove;
      document.addEventListener("touchmove", blockActiveTouchMove, { passive: false });
    }
    setActiveDragWidgetId(widgetId);
    setLiftedPreview({
      ...session.previewRect,
      grabX: session.grabOffsetX,
      grabY: session.grabOffsetY,
      mode: "move",
      widgetId,
    });
    setAnnouncement(`${DASHBOARD_WIDGET_BY_ID.get(widgetId)?.title ?? "Panel"} picked up.`);
  }, [clearDragSession, isCustomizing]);

  const commitDragTarget = useCallback((session: DragSession, column: number, row: number) => {
    if (dragRef.current !== session || !session.active) return;
    session.lastColumn = column;
    session.lastRow = row;
    session.pendingColumn = column;
    session.pendingRow = row;
    session.reflowTimer = null;
    const storedTarget = projectDashboardFrameTargetToStoredCell(
      layoutRef.current.items,
      session.widgetId,
      session.gridMetrics?.columns ?? DASHBOARD_LAYOUT_COLUMNS,
      column,
      row
    );
    const nextItems = moveDashboardLayoutItem(
      layoutRef.current.items,
      session.widgetId,
      storedTarget.column,
      storedTarget.row,
      session.beforeLayout.items.map((item) => item.widget_id)
    );
    capturePanelPositions();
    updateLayoutInMemory({ ...layoutRef.current, items: nextItems });
  }, [capturePanelPositions, updateLayoutInMemory]);

  const reflowDragAtPointer = useCallback((session: DragSession, clientX: number, clientY: number) => {
    const node = panelRefs.current.get(session.widgetId);
    if (node) {
      node.style.setProperty("--dashboard-lift-translate-x", `${clientX - session.startX}px`);
      node.style.setProperty("--dashboard-lift-translate-y", `${clientY - session.startY}px`);
    }

    let target: { column: number; row: number } | null = null;
    const sequence = sequenceRef.current;
    if (sequence && session.gridMetrics) {
      const sequenceRect = sequence.getBoundingClientRect();
      target = resolveDashboardPointerTarget({
        ...session.gridMetrics,
        grabOffsetX: session.grabOffsetX,
        grabOffsetY: session.grabOffsetY,
        pointerX: clientX,
        pointerY: clientY,
        previousColumn: session.lastColumn,
        previousRow: session.lastRow,
        sequenceLeft: sequenceRect.left,
        sequenceTop: sequenceRect.top,
        size: layoutRef.current.items.find((item) => item.widget_id === session.widgetId)?.size ?? "1x1",
      });
    } else {
      const previewCenterY = clientY - session.grabOffsetY + session.previewRect.height / 2;
      const closest = layoutRef.current.items
        .filter((item) => item.widget_id !== session.widgetId)
        .map((item) => ({ item, rect: panelRefs.current.get(item.widget_id)?.getBoundingClientRect() }))
        .filter((candidate): candidate is { item: DashboardLayoutItem; rect: DOMRect } => Boolean(candidate.rect))
        .sort((left, right) => (
          Math.abs(previewCenterY - (left.rect.top + left.rect.height / 2))
          - Math.abs(previewCenterY - (right.rect.top + right.rect.height / 2))
        ))[0];
      if (closest) {
        target = { column: closest.item.column, row: closest.item.row };
      }
    }

    if (!target || (target.column === session.lastColumn && target.row === session.lastRow)) {
      if (session.reflowTimer) clearTimeout(session.reflowTimer);
      session.reflowTimer = null;
      session.pendingColumn = session.lastColumn;
      session.pendingRow = session.lastRow;
      return;
    }
    if (target.column === session.pendingColumn && target.row === session.pendingRow) return;
    if (session.reflowTimer) clearTimeout(session.reflowTimer);
    session.pendingColumn = target.column;
    session.pendingRow = target.row;
    session.reflowTimer = setTimeout(() => {
      commitDragTarget(session, session.pendingColumn, session.pendingRow);
    }, 80);
  }, [commitDragTarget]);

  const updateDragAutoScroll = useCallback((session: DragSession, clientY: number) => {
    const edge = 88;
    const upperDistance = Math.max(0, edge - clientY);
    const lowerDistance = Math.max(0, clientY - (window.innerHeight - edge));
    session.autoScrollVelocity = upperDistance > 0
      ? -Math.min(16, 3 + upperDistance * 0.16)
      : lowerDistance > 0
        ? Math.min(16, 3 + lowerDistance * 0.16)
        : 0;
    if (session.autoScrollVelocity === 0) {
      if (session.autoScrollFrame) cancelAnimationFrame(session.autoScrollFrame);
      session.autoScrollFrame = null;
      return;
    }
    if (session.autoScrollFrame) return;
    const tick = () => {
      if (dragRef.current !== session || !session.active || session.autoScrollVelocity === 0) {
        session.autoScrollFrame = null;
        return;
      }
      window.scrollBy({ top: session.autoScrollVelocity, behavior: "auto" });
      reflowDragAtPointer(session, session.lastClientX, session.lastClientY);
      session.autoScrollFrame = requestAnimationFrame(tick);
    };
    session.autoScrollFrame = requestAnimationFrame(tick);
  }, [reflowDragAtPointer]);

  const onPointerDown = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    widgetId: DashboardWidgetId
  ) => {
    if (!isCustomizing || DASHBOARD_WIDGET_BY_ID.get(widgetId)?.fixed) {
      return;
    }
    setSelectedWidgetId(widgetId);
    const activeMoveId = keyboardMoveRef.current?.widgetId ?? dragRef.current?.widgetId ?? resizeRef.current?.widgetId;
    if (activeMoveId) {
      const activeTitle = DASHBOARD_WIDGET_BY_ID.get(activeMoveId)?.title ?? "Another panel";
      setAnnouncement(`${activeTitle} is already picked up. Drop or cancel it before starting another move.`);
      return;
    }
    const item = layoutRef.current.items.find((candidate) => candidate.widget_id === widgetId);
    const itemRect = event.currentTarget.getBoundingClientRect();
    const sequence = sequenceRef.current;
    if (!item || !sequence) return;
    const gridMetrics = readGridMetrics(sequence, itemRect, item.size);
    const frameItems = gridMetrics && gridMetrics.columns !== DASHBOARD_LAYOUT_COLUMNS
      ? packDashboardLayoutItems(layoutRef.current.items, gridMetrics.columns, false)
      : layoutRef.current.items;
    if (gridMetrics) {
      gridMetrics.maxRows = Math.max(
        DASHBOARD_LAYOUT_MAX_ROWS,
        ...frameItems.map((candidate) => (
          candidate.row + getDashboardWidgetFootprint(candidate.size).rows
        ))
      );
    }
    const frameItem = frameItems.find((candidate) => candidate.widget_id === widgetId) ?? item;
    const session: DragSession = {
      active: false,
      autoScrollFrame: null,
      autoScrollVelocity: 0,
      beforeLayout: cloneLayout(layoutRef.current),
      grabOffsetX: event.clientX - itemRect.left,
      grabOffsetY: event.clientY - itemRect.top,
      gridMetrics,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      lastColumn: frameItem?.column ?? item.column,
      lastRow: frameItem?.row ?? item.row,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      pendingColumn: frameItem?.column ?? item.column,
      pendingRow: frameItem?.row ?? item.row,
      previewRect: { height: itemRect.height, left: itemRect.left, top: itemRect.top, width: itemRect.width },
      reflowTimer: null,
      startX: event.clientX,
      startY: event.clientY,
      timer: null,
      widgetId,
    };
    dragRef.current = session;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      dragRef.current = null;
      return;
    }
    if (event.pointerType === "touch") {
      session.timer = setTimeout(() => startDrag(widgetId, event.pointerId), 280);
    }
  }, [isCustomizing, startDrag]);

  const movePointerDrag = useCallback((pointerId: number, clientX: number, clientY: number) => {
    if (!isCustomizing) {
      clearDragSession();
      return;
    }
    const session = dragRef.current;
    if (!session || session.pointerId !== pointerId) {
      return;
    }
    const distance = Math.hypot(
      clientX - session.startX,
      clientY - session.startY
    );
    if (!session.active && session.pointerType !== "touch" && distance >= 5) {
      startDrag(session.widgetId, session.pointerId);
    }
    if (!session.active && session.pointerType === "touch" && distance > 8) {
      if (session.timer) clearTimeout(session.timer);
      dragRef.current = null;
      setActiveDragWidgetId(null);
      return;
    }
    if (!session.active) {
      return;
    }
    session.lastClientX = clientX;
    session.lastClientY = clientY;
    reflowDragAtPointer(session, clientX, clientY);
    updateDragAutoScroll(session, clientY);
  }, [clearDragSession, isCustomizing, reflowDragAtPointer, startDrag, updateDragAutoScroll]);

  const finishPointerDrag = useCallback((pointerId: number) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== pointerId) {
      return;
    }
    if (isCustomizing && session.active) {
      if (session.pendingColumn !== session.lastColumn || session.pendingRow !== session.lastRow) {
        if (session.reflowTimer) clearTimeout(session.reflowTimer);
        commitDragTarget(session, session.pendingColumn, session.pendingRow);
      }
      capturePanelPositions();
      saveLayout(layoutRef.current);
      const item = layoutRef.current.items.find((candidate) => candidate.widget_id === session.widgetId);
      setAnnouncement(`${DASHBOARD_WIDGET_BY_ID.get(session.widgetId)?.title ?? "Panel"} dropped at row ${(item?.row ?? 0) + 1}, column ${(item?.column ?? 0) + 1}.`);
      focusMoveHandle(session.widgetId);
    }
    clearDragSession();
  }, [capturePanelPositions, clearDragSession, commitDragTarget, focusMoveHandle, isCustomizing, saveLayout]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    movePointerDrag(event.pointerId, event.clientX, event.clientY);
    if (dragRef.current?.active) event.preventDefault();
  }, [movePointerDrag]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    finishPointerDrag(event.pointerId);
  }, [finishPointerDrag]);

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    if (session.active) cancelActiveMove();
    else clearDragSession();
  }, [cancelActiveMove, clearDragSession]);

  const onLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId || session.active) return;
    clearDragSession();
  }, [clearDragSession]);

  useEffect(() => {
    if (liftedPreview?.mode !== "move") return;
    const onWindowPointerMove = (event: PointerEvent) => {
      const session = dragRef.current;
      if (!session?.active || session.pointerId !== event.pointerId) return;
      event.preventDefault();
      movePointerDrag(event.pointerId, event.clientX, event.clientY);
    };
    const onWindowPointerUp = (event: PointerEvent) => finishPointerDrag(event.pointerId);
    const onWindowPointerCancel = (event: PointerEvent) => {
      const session = dragRef.current;
      if (session?.pointerId === event.pointerId) cancelActiveMove();
    };
    window.addEventListener("pointermove", onWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerCancel);
    return () => {
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerCancel);
    };
  }, [cancelActiveMove, finishPointerDrag, liftedPreview?.mode, movePointerDrag]);

  const onResizePointerDown = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    widgetId: DashboardWidgetId
  ) => {
    event.stopPropagation();
    if (!isCustomizing || dragRef.current || resizeRef.current || keyboardMoveRef.current) return;
    setSelectedWidgetId(widgetId);
    const item = layoutRef.current.items.find((candidate) => candidate.widget_id === widgetId);
    const catalog = DASHBOARD_WIDGET_BY_ID.get(widgetId);
    const node = panelRefs.current.get(widgetId);
    const sequence = sequenceRef.current;
    if (!item || !catalog || !node || !sequence || catalog.allowedSizes.length < 2) return;
    const itemRect = node.getBoundingClientRect();
    releaseLiftStyles(node);
    const gridMetrics = readGridMetrics(sequence, itemRect, item.size);
    if (!gridMetrics) {
      resizeWidget(widgetId);
      return;
    }
    resizeRef.current = {
      active: false,
      beforeLayout: cloneLayout(layoutRef.current),
      currentSize: item.size,
      gridMetrics,
      pointerId: event.pointerId,
      previewRect: { height: itemRect.height, left: itemRect.left, top: itemRect.top, width: itemRect.width },
      startSize: item.size,
      startX: event.clientX,
      startY: event.clientY,
      widgetId,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      resizeRef.current = null;
    }
  }, [isCustomizing, resizeWidget]);

  const onResizePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const session = resizeRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
    if (!session.active && distance < 5) return;
    event.preventDefault();
    if (!session.active) {
      session.active = true;
      setLiftedPreview({
        ...session.previewRect,
        grabX: 0,
        grabY: 0,
        mode: "resize",
        widgetId: session.widgetId,
      });
    }
    const catalog = DASHBOARD_WIDGET_BY_ID.get(session.widgetId);
    const node = panelRefs.current.get(session.widgetId);
    if (!catalog || !node) return;
    const preview = clampDashboardResizePreview(
      session.previewRect.width + event.clientX - session.startX,
      session.previewRect.height + event.clientY - session.startY,
      catalog.allowedSizes,
      session.gridMetrics,
      session.startSize
    );
    node.style.setProperty("--dashboard-lift-width", `${preview.width}px`);
    node.style.setProperty("--dashboard-lift-height", `${preview.height}px`);
    const nextSize = chooseDashboardResizeSize({
      ...session.gridMetrics,
      allowedSizes: catalog.allowedSizes,
      currentSize: session.currentSize,
      height: preview.height,
      width: preview.width,
    });
    if (nextSize === session.currentSize) return;
    session.currentSize = nextSize;
    const nextItems = resizeDashboardLayoutItem(layoutRef.current.items, session.widgetId, nextSize);
    capturePanelPositions();
    updateLayoutInMemory({ ...layoutRef.current, items: nextItems });
  }, [capturePanelPositions, updateLayoutInMemory]);

  const onResizePointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const session = resizeRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (!session.active) {
      resizeRef.current = null;
      resizeWidget(session.widgetId);
      return;
    }
    capturePanelPositions();
    saveLayout(layoutRef.current);
    setAnnouncement(`${DASHBOARD_WIDGET_BY_ID.get(session.widgetId)?.title ?? "Panel"} resized to ${DASHBOARD_WIDGET_SIZE_LABELS[session.currentSize]}.`);
    const widgetId = session.widgetId;
    clearResizeSession();
    focusWidget(widgetId);
  }, [capturePanelPositions, clearResizeSession, focusWidget, resizeWidget, saveLayout]);

  const onResizePointerCancel = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const session = resizeRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (session.active) cancelActiveResize();
    else clearResizeSession();
  }, [cancelActiveResize, clearResizeSession]);

  const addableWidgets = getAddableDashboardWidgets(currentRole, layout.items)
    .filter((entry) => viewModels[entry.id]?.state !== "unavailable");
  const tabletItems = packDashboardLayoutItems(layout.items, 2, false);
  const tabletItemsById = new Map(tabletItems.map((item) => [item.widget_id, item]));
  const renderWidget = (item: DashboardLayoutItem, index: number) => {
    const tabletItem = tabletItemsById.get(item.widget_id) ?? item;
    const itemPreview = liftedPreview?.widgetId === item.widget_id ? liftedPreview : null;
    const footprint = getDashboardWidgetFootprint(item.size);
    const placeholderStyle = {
      "--dashboard-column": item.column + 1,
      "--dashboard-row": item.row + 1,
      "--dashboard-column-span": footprint.columns,
      "--dashboard-row-span": footprint.rows,
      "--dashboard-tablet-column": tabletItem.column + 1,
      "--dashboard-tablet-row": tabletItem.row + 1,
    } as CSSProperties;
    return (
      <Fragment key={item.widget_id}>
        {itemPreview ? (
          <div
            className={styles.widgetPlaceholder}
            data-widget-placeholder={item.widget_id}
            data-density={getDashboardWidgetComposition(item.size).density}
            style={placeholderStyle}
            aria-hidden="true"
          />
        ) : null}
        <HomeWidget
          index={index}
          item={item}
          isCustomizing={isCustomizing}
          isPickedUp={activeDragWidgetId === item.widget_id}
          isSelected={selectedWidgetId === item.widget_id}
          liftedPreview={itemPreview}
          model={viewModels[item.widget_id]}
          moveHandleRef={(node) => {
            if (node) moveHandleRefs.current.set(item.widget_id, node);
            else moveHandleRefs.current.delete(item.widget_id);
          }}
          onMoveKeyDown={onMoveKeyDown}
          onLostPointerCapture={onLostPointerCapture}
          onPointerCancel={onPointerCancel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onRemove={removeWidget}
          onResize={resizeWidget}
          onResizePointerCancel={onResizePointerCancel}
          onResizePointerDown={onResizePointerDown}
          onResizePointerMove={onResizePointerMove}
          onResizePointerUp={onResizePointerUp}
          panelRef={(node) => {
            if (node) panelRefs.current.set(item.widget_id, node);
            else panelRefs.current.delete(item.widget_id);
          }}
          tabletItem={tabletItem}
          total={layout.items.length}
        />
      </Fragment>
    );
  };

  return (
    <div
      ref={homeRef}
      className={styles.home}
      data-koaryu-dashboard-home="true"
      data-koaryu-dashboard-ready={layoutResolved ? "true" : "false"}
      data-layout-resolved={layoutResolved ? "true" : "false"}
      data-dashboard-provenance={isPreviewMode ? "preview" : "live"}
      aria-busy={!layoutResolved}
    >
      <section className={styles.homeHeading} aria-labelledby="dashboard-home-heading">
        <div>
          <h1 id="dashboard-home-heading">Dashboard</h1>
        </div>
        <div className={styles.homeActions}>
          {isCustomizing && layoutResolved ? (
            <>
              <button ref={addPanelsTriggerRef} type="button" onClick={openLibrary} aria-expanded={isLibraryOpen} aria-haspopup="dialog">
                <Plus aria-hidden="true" size={17} /> Add panels
              </button>
              <button type="button" onClick={resetLayout}>
                <RotateCcw aria-hidden="true" size={17} /> Reset
              </button>
              <button type="button" onClick={cancelCustomize}>Cancel</button>
              <button type="button" className={styles.primaryAction} onClick={finishCustomize}>Done</button>
            </>
          ) : (
            <button
              ref={customizeTriggerRef}
              type="button"
              className={styles.furnitureAction}
              onClick={enterCustomize}
              disabled={!layoutResolved}
              aria-describedby={!layoutResolved ? "dashboard-layout-status" : undefined}
              title={!layoutResolved ? "Available after this studio arrangement loads" : "Arrange Home panels"}
            >
              <Settings2 aria-hidden="true" size={17} /> Customize
            </button>
          )}
        </div>
      </section>

      {datasetLoadError ? (
        <div className={styles.errorBand}>
          <DatasetReadinessErrorPanel
            error={datasetLoadError}
            onRetry={retryDashboardDatasets}
            title="Some Dashboard data is unavailable"
          />
        </div>
      ) : null}

      {isCustomizing ? (
        <p className={styles.customizeNotice}>
          Arrangement changes stay on this browser for this user, studio, and role. Escape cancels an active move; Cancel restores the entry snapshot.
        </p>
      ) : null}

      {persistenceError ? (
        <p className={styles.persistenceNotice} role="status">{persistenceError}</p>
      ) : null}

      {!layoutResolved ? (
        <section className={styles.layoutLoading} id="dashboard-layout-status" role="status" aria-live="polite">
          <span className={styles.layoutLoadingMark} aria-hidden="true" />
          <div>
            <strong>Arranging this studio’s Home</strong>
            <p>Loading the saved panel geometry for your current role.</p>
          </div>
        </section>
      ) : (
        <section
          className={`${styles.canvas} ${isCustomizing ? styles.customizing : ""}`}
          aria-label="Customizable home panels"
        >
          <div ref={sequenceRef} className={styles.sequence} data-layout-resolved="true">
            {layout.items.map(renderWidget)}
          </div>
        </section>
      )}

      {isLibraryOpen && layoutResolved ? (
        <aside ref={libraryRef} className={styles.library} role="dialog" aria-modal="true" aria-labelledby="widget-library-heading">
          <header>
            <div>
              <p className={styles.eyebrow}>Panel library</p>
              <h2 ref={libraryHeadingRef} tabIndex={-1} id="widget-library-heading">Add to your home</h2>
              <p>Only panels entitled for your current role and backed by an available source appear here.</p>
            </div>
            <button type="button" onClick={closeLibrary} aria-label="Close panel library">
              <X aria-hidden="true" size={18} /> Close
            </button>
          </header>
          {addableWidgets.length > 0 ? (
            <div className={styles.libraryList}>
              {addableWidgets.map((entry) => (
                <button type="button" key={entry.id} onClick={() => addWidget(entry.id)}>
                  <strong>{entry.title}</strong>
                  <span>{entry.category} · {entry.allowedSizes.join(" or ")}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className={styles.libraryEmpty}>Every available panel is already on your home.</p>
          )}
        </aside>
      ) : null}

      <p className={styles.liveRegion} aria-live="polite" aria-atomic="true">{announcement}</p>
    </div>
  );
}
