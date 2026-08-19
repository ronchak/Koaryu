"use client";

import Link from "next/link";
import {
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
  Plus,
  RotateCcw,
  Settings2,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { DatasetReadinessErrorPanel } from "@/components/dataset-readiness-panel";
import {
  buildDefaultDashboardLayout,
  getAddableDashboardWidgets,
  getBrowserDashboardLayoutStorage,
  getDashboardWidgetFootprint,
  moveDashboardLayoutItem,
  packDashboardLayoutItems,
  readDashboardLayout,
  resizeDashboardLayoutItem,
  writeDashboardLayout,
  type DashboardLayout,
  type DashboardLayoutIdentity,
  type DashboardLayoutItem,
} from "@/lib/dashboard-layout-store";
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
  beforeLayout: DashboardLayout;
  lastColumn: number;
  lastRow: number;
  pointerId: number;
  startX: number;
  startY: number;
  timer: ReturnType<typeof setTimeout> | null;
  widgetId: DashboardWidgetId;
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
  return (
    <div className={styles.stateLine}>
      <span className={styles.stateStamp}>{stateLabel(model.state)}</span>
    </div>
  );
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
    <>
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
    </>
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
    <>
      {model.metric ? <strong className={styles.queueCount}>{model.metric}</strong> : null}
      {model.rows.length > 0 ? (
        <ul className={styles.queue}>
          {model.rows.slice(0, maxRows).map((row, rowIndex) => (
            <li key={`${row.label}-${rowIndex}`}>
              {row.href ? <Link href={row.href}>{row.label}</Link> : <strong>{row.label}</strong>}
              {row.meta ? <small>{row.meta}</small> : null}
            </li>
          ))}
        </ul>
      ) : <p className={styles.detail}>{model.detail}</p>}
    </>
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
  model,
  size,
}: {
  model: DashboardWidgetViewModel;
  size: DashboardWidgetSize;
}) {
  return (
    <>
      <RatioRing model={model} />
      {model.rows.length > 0 && size !== "1x1" ? (
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

function QuickActionsContent({ model }: { model: DashboardWidgetViewModel }) {
  return (
    <div className={styles.quickActions}>
      {model.actions.map((action, index) => {
        const Icon = QUICK_ACTION_ICONS[index] ?? Plus;
        return <Link href={action.href} key={action.href}><Icon aria-hidden="true" size={18} /><span>{action.label}</span></Link>;
      })}
    </div>
  );
}

function visibleRowLimit(model: DashboardWidgetViewModel, size: DashboardWidgetSize): number {
  if (size === "2x2" || size === "1x2") {
    return 5;
  }
  if (
    model.id === "classes_today"
    || model.id === "needs_attention"
    || model.id === "lead_follow_ups"
    || model.id === "promotions_due"
    || model.id === "recent_students"
  ) {
    return 1;
  }
  return 5;
}

function WidgetContent({
  maxRows,
  model,
  size,
}: {
  maxRows: number;
  model: DashboardWidgetViewModel;
  size: DashboardWidgetSize;
}) {
  if (model.state === "loading" || model.state === "error" || model.state === "unavailable") {
    return (
      <div className={styles.stateBody}>
        <p className={styles.detail}>{model.detail}</p>
        <span className={styles.stateRule} aria-hidden="true" />
        <span className={styles.stateRule} aria-hidden="true" />
        <span className={styles.stateRule} aria-hidden="true" />
      </div>
    );
  }
  if (model.state === "partial" && model.rows.length === 0) {
    return <p className={styles.detail}>{model.detail}</p>;
  }
  if (model.id === "classes_today") return <AgendaContent maxRows={maxRows} model={model} />;
  if (model.id === "student_pulse") return <RatioRing model={model} />;
  if (model.id === "attendance") return <AttendanceContent model={model} />;
  if (model.id === "setup_progress") return <SetupContent model={model} size={size} />;
  if (model.id === "quick_actions") return <QuickActionsContent model={model} />;
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
  panelRef,
  tabletItem,
  total,
}: {
  index: number;
  item: DashboardLayoutItem;
  isCustomizing: boolean;
  isPickedUp: boolean;
  model: DashboardWidgetViewModel;
  moveHandleRef: (node: HTMLButtonElement | null) => void;
  onMoveKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, widgetId: DashboardWidgetId) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, widgetId: DashboardWidgetId) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onRemove: (widgetId: DashboardWidgetId) => void;
  onResize: (widgetId: DashboardWidgetId) => void;
  panelRef: (node: HTMLElement | null) => void;
  tabletItem: DashboardLayoutItem;
  total: number;
}) {
  const catalog = DASHBOARD_WIDGET_BY_ID.get(item.widget_id);
  if (!catalog) {
    return null;
  }
  const maxRows = visibleRowLimit(model, item.size);
  const hiddenRows = Math.max(
    0,
    model.rows.length + (model.overflowCount ?? 0) - maxRows
  );
  const footprint = getDashboardWidgetFootprint(item.size);
  const widgetStyle = {
    "--dashboard-column": item.column + 1,
    "--dashboard-row": item.row + 1,
    "--dashboard-column-span": footprint.columns,
    "--dashboard-row-span": footprint.rows,
    "--dashboard-tablet-column": tabletItem.column + 1,
    "--dashboard-tablet-row": tabletItem.row + 1,
  } as CSSProperties;

  return (
    <article
      ref={panelRef}
      className={`${styles.widget} ${catalog.fixed ? styles.attentionWidget : ""} ${isPickedUp ? styles.pickedUp : ""}`}
      data-widget-id={item.widget_id}
      data-size={item.size}
      data-state={model.state}
      style={widgetStyle}
      tabIndex={-1}
      aria-label={`${catalog.title}, row ${item.row + 1}, column ${item.column + 1}, ${DASHBOARD_WIDGET_SIZE_LABELS[item.size]}, position ${index + 1} of ${total}`}
    >
      <header className={styles.widgetBand}>
        <div className={styles.bandTitle}>
          <span>{catalog.title}</span>
        </div>
        {isCustomizing && !catalog.fixed ? (
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
            onPointerDown={(event) => onPointerDown(event, item.widget_id)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onLostPointerCapture={onLostPointerCapture}
          >
            <GripVertical aria-hidden="true" size={18} />
            <span className={styles.controlLabel}>Move</span>
          </button>
        ) : isCustomizing && catalog.fixed ? <span className={styles.fixedLabel}>Fixed</span> : null}
      </header>

      {isCustomizing && !catalog.fixed ? (
        <div className={styles.editControls} aria-label={`${catalog.title} layout controls`}>
          {catalog.allowedSizes.length > 1 ? (
            <button type="button" onClick={() => onResize(item.widget_id)} aria-label={`Resize ${catalog.title}`} title="Resize">
              <Maximize2 aria-hidden="true" size={17} /><span className={styles.controlLabel}>Resize</span>
            </button>
          ) : null}
          {catalog.removable ? (
            <button type="button" onClick={() => onRemove(item.widget_id)} aria-label={`Remove ${catalog.title}`} title="Remove">
              <Trash2 aria-hidden="true" size={17} /><span className={styles.controlLabel}>Remove</span>
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={styles.widgetBody}>
        <MaterialState model={model} />
        <WidgetContent maxRows={maxRows} model={model} size={item.size} />
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
      keyboardMoveRef.current = null;
      snapshotRef.current = null;
      const dragSession = dragRef.current;
      if (dragSession?.timer) {
        clearTimeout(dragSession.timer);
      }
      dragRef.current = null;
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
      if (!previousRect) {
        continue;
      }
      const nextRect = node.getBoundingClientRect();
      const translateX = previousRect.left - nextRect.left;
      const translateY = previousRect.top - nextRect.top;
      if (Math.abs(translateX) < 1 && Math.abs(translateY) < 1) {
        continue;
      }
      panelAnimationsRef.current.get(widgetId)?.cancel();
      if (duration === 0) {
        continue;
      }
      const animation = node.animate([
        { opacity: 0.92, transform: `translate(${translateX}px, ${translateY}px)` },
        { opacity: 1, transform: "translate(0, 0)" },
      ], {
        duration,
        easing: "cubic-bezier(.16, 1, .3, 1)",
      });
      panelAnimationsRef.current.set(widgetId, animation);
      void animation.finished.catch(() => undefined).finally(() => {
        if (panelAnimationsRef.current.get(widgetId) === animation) {
          panelAnimationsRef.current.delete(widgetId);
        }
      });
    }
  }, [layout.items, layoutResolved]);

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
    dragRef.current = null;
    setActiveDragWidgetId(null);
  }, []);

  useEffect(() => () => {
    const session = dragRef.current;
    if (session?.timer) {
      clearTimeout(session.timer);
    }
    dragRef.current = null;
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
    focusWidget(widgetId);
  }, [capturePanelPositions, focusWidget, saveLayout]);

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
    setIsCustomizing(true);
    setAnnouncement("Customize mode started. Drag a move handle, or focus it and press Space or Enter.");
  }, [layoutResolved]);

  const finishCustomize = useCallback(() => {
    if (dragRef.current?.active || keyboardMoveRef.current) {
      saveLayout(layoutRef.current);
    }
    clearDragSession();
    keyboardMoveRef.current = null;
    snapshotRef.current = null;
    setIsCustomizing(false);
    setIsLibraryOpen(false);
    setAnnouncement("Customize mode finished.");
    requestAnimationFrame(() => customizeTriggerRef.current?.focus());
  }, [clearDragSession, saveLayout]);

  const cancelCustomize = useCallback(() => {
    clearDragSession();
    keyboardMoveRef.current = null;
    const snapshot = snapshotRef.current;
    if (snapshot) {
      capturePanelPositions();
      saveLayout(snapshot);
    }
    snapshotRef.current = null;
    setIsCustomizing(false);
    setIsLibraryOpen(false);
    setAnnouncement("Changes canceled. The previous arrangement was restored.");
    requestAnimationFrame(() => customizeTriggerRef.current?.focus());
  }, [capturePanelPositions, clearDragSession, saveLayout]);

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
      } else if (!session && !dragRef.current) {
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
  }, [cancelActiveMove, cancelCustomize, closeLibrary, isCustomizing, isLibraryOpen]);

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
    session.active = true;
    setActiveDragWidgetId(widgetId);
    setAnnouncement(`${DASHBOARD_WIDGET_BY_ID.get(widgetId)?.title ?? "Panel"} picked up.`);
  }, [clearDragSession, isCustomizing]);

  const onPointerDown = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    widgetId: DashboardWidgetId
  ) => {
    if (!isCustomizing || widgetId === "needs_attention") {
      return;
    }
    const activeMoveId = keyboardMoveRef.current?.widgetId ?? dragRef.current?.widgetId;
    if (activeMoveId) {
      const activeTitle = DASHBOARD_WIDGET_BY_ID.get(activeMoveId)?.title ?? "Another panel";
      setAnnouncement(`${activeTitle} is already picked up. Drop or cancel it before starting another move.`);
      return;
    }
    const session: DragSession = {
      active: event.pointerType !== "touch",
      beforeLayout: cloneLayout(layoutRef.current),
      lastColumn: -1,
      lastRow: -1,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: null,
      widgetId,
    };
    dragRef.current = session;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.pointerType === "touch") {
      session.timer = setTimeout(() => startDrag(widgetId, event.pointerId), 500);
    } else {
      startDrag(widgetId, event.pointerId);
    }
  }, [isCustomizing, startDrag]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!isCustomizing) {
      clearDragSession();
      return;
    }
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    if (!session.active && Math.hypot(
      event.clientX - session.startX,
      event.clientY - session.startY
    ) > 8) {
      if (session.timer) clearTimeout(session.timer);
      dragRef.current = null;
      setActiveDragWidgetId(null);
      return;
    }
    if (!session.active) {
      return;
    }
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-widget-id]");
    const targetId = target?.dataset.widgetId as DashboardWidgetId | undefined;
    const targetItem = targetId && targetId !== session.widgetId
      ? layoutRef.current.items.find((item) => item.widget_id === targetId)
      : null;
    const sequence = sequenceRef.current;
    const sequenceRect = sequence?.getBoundingClientRect();
    let column = targetItem?.column;
    let row = targetItem?.row;
    if (column === undefined && row === undefined && sequence && sequenceRect) {
      const renderedColumns = window.getComputedStyle(sequence).gridTemplateColumns.split(" ").length;
      if (renderedColumns >= 4) {
        column = Math.max(0, Math.min(3, Math.floor(
          ((event.clientX - sequenceRect.left) / sequenceRect.width) * 4
        )));
        const rowHeight = Math.max(1, Number.parseFloat(window.getComputedStyle(sequence).gridAutoRows) || 160);
        row = Math.max(0, Math.floor((event.clientY - sequenceRect.top) / rowHeight));
      }
    }
    if (column !== undefined && row !== undefined && (
      column !== session.lastColumn || row !== session.lastRow
    )) {
      session.lastColumn = column;
      session.lastRow = row;
      const nextItems = moveDashboardLayoutItem(layoutRef.current.items, session.widgetId, column, row);
      capturePanelPositions();
      updateLayoutInMemory({ ...layoutRef.current, items: nextItems });
      announcePosition(session.widgetId, nextItems);
    }
    if (event.clientY < 72) {
      window.scrollBy({ top: -24, behavior: "auto" });
    } else if (event.clientY > window.innerHeight - 72) {
      window.scrollBy({ top: 24, behavior: "auto" });
    }
  }, [announcePosition, capturePanelPositions, clearDragSession, isCustomizing, updateLayoutInMemory]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    if (isCustomizing && session.active) {
      saveLayout(layoutRef.current);
      const item = layoutRef.current.items.find((candidate) => candidate.widget_id === session.widgetId);
      setAnnouncement(`${DASHBOARD_WIDGET_BY_ID.get(session.widgetId)?.title ?? "Panel"} dropped at row ${(item?.row ?? 0) + 1}, column ${(item?.column ?? 0) + 1}.`);
      focusMoveHandle(session.widgetId);
    }
    clearDragSession();
  }, [clearDragSession, focusMoveHandle, isCustomizing, saveLayout]);

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    if (session.active) cancelActiveMove();
    else clearDragSession();
  }, [cancelActiveMove, clearDragSession]);

  const addableWidgets = getAddableDashboardWidgets(currentRole, layout.items)
    .filter((entry) => viewModels[entry.id]?.state !== "unavailable");
  const tabletItems = packDashboardLayoutItems(layout.items, 2, false);
  const tabletItemsById = new Map(tabletItems.map((item) => [item.widget_id, item]));
  const renderWidget = (item: DashboardLayoutItem, index: number) => (
    <HomeWidget
      key={item.widget_id}
      index={index}
      item={item}
      isCustomizing={isCustomizing}
      isPickedUp={activeDragWidgetId === item.widget_id}
      model={viewModels[item.widget_id]}
      moveHandleRef={(node) => {
        if (node) moveHandleRefs.current.set(item.widget_id, node);
        else moveHandleRefs.current.delete(item.widget_id);
      }}
      onMoveKeyDown={onMoveKeyDown}
      onLostPointerCapture={onPointerCancel}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onRemove={removeWidget}
      onResize={resizeWidget}
      panelRef={(node) => {
        if (node) panelRefs.current.set(item.widget_id, node);
        else panelRefs.current.delete(item.widget_id);
      }}
      tabletItem={tabletItemsById.get(item.widget_id) ?? item}
      total={layout.items.length}
    />
  );

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
