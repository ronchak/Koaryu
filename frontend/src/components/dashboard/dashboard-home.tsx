"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowDown,
  ArrowUp,
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
  readDashboardLayout,
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
  isPreviewMode: boolean;
  retryDashboardDatasets: () => void;
  studioDescription: string;
  viewModels: Record<DashboardWidgetId, DashboardWidgetViewModel>;
};

type DragSession = {
  active: boolean;
  pointerId: number;
  startY: number;
  timer: ReturnType<typeof setTimeout> | null;
  widgetId: DashboardWidgetId;
};

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

function moveLayoutItem(
  items: readonly DashboardLayoutItem[],
  widgetId: DashboardWidgetId,
  toIndex: number
): DashboardLayoutItem[] {
  const fromIndex = items.findIndex((item) => item.widget_id === widgetId);
  if (fromIndex <= 0 || toIndex <= 0 || toIndex >= items.length || fromIndex === toIndex) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) {
    return next;
  }
  next.splice(toIndex, 0, moved);
  return next;
}

function stateLabel(state: DashboardWidgetViewModel["state"]): string {
  if (state === "loading") return "Loading";
  if (state === "error") return "Error";
  if (state === "partial") return "Partial";
  return "Unavailable";
}

function isMaterialState(state: DashboardWidgetViewModel["state"]): boolean {
  return state === "loading" || state === "error" || state === "partial" || state === "unavailable";
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
      <span>{model.provenanceLabel}</span>
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
  if (size === "2x2" || size === "4x2") {
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
  onMove,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onRemove,
  onResize,
  panelRef,
  total,
}: {
  index: number;
  item: DashboardLayoutItem;
  isCustomizing: boolean;
  isPickedUp: boolean;
  model: DashboardWidgetViewModel;
  onMove: (widgetId: DashboardWidgetId, direction: -1 | 1) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, widgetId: DashboardWidgetId) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onRemove: (widgetId: DashboardWidgetId) => void;
  onResize: (widgetId: DashboardWidgetId) => void;
  panelRef: (node: HTMLElement | null) => void;
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

  return (
    <article
      ref={panelRef}
      className={`${styles.widget} ${catalog.fixed ? styles.attentionWidget : ""} ${isPickedUp ? styles.pickedUp : ""}`}
      data-widget-id={item.widget_id}
      data-size={item.size}
      data-state={model.state}
      tabIndex={-1}
      aria-label={`${catalog.title}, position ${index + 1} of ${total}`}
    >
      <header className={styles.widgetBand}>
        <div className={styles.bandTitle}>
          <span>{catalog.title}</span>
          <span className={styles.window}>{catalog.windowCopy}</span>
        </div>
        {isCustomizing && !catalog.fixed ? (
          <button
            type="button"
            className={styles.dragHandle}
            aria-label={`Drag ${catalog.title}`}
            aria-pressed={isPickedUp}
            onPointerDown={(event) => onPointerDown(event, item.widget_id)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <GripVertical aria-hidden="true" size={18} />
            <span className={styles.controlLabel}>Drag</span>
          </button>
        ) : isCustomizing && catalog.fixed ? <span className={styles.fixedLabel}>Fixed</span> : null}
      </header>

      {isCustomizing && !catalog.fixed ? (
        <div className={styles.editControls} aria-label={`${catalog.title} layout controls`}>
          <button
            type="button"
            onClick={() => onMove(item.widget_id, -1)}
            disabled={index <= 1}
            aria-label={`Move ${catalog.title} earlier`}
            title="Move earlier"
          >
            <ArrowUp aria-hidden="true" size={17} /><span className={styles.controlLabel}>Earlier</span>
          </button>
          <button
            type="button"
            onClick={() => onMove(item.widget_id, 1)}
            disabled={index >= total - 1}
            aria-label={`Move ${catalog.title} later`}
            title="Move later"
          >
            <ArrowDown aria-hidden="true" size={17} /><span className={styles.controlLabel}>Later</span>
          </button>
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
        {model.id !== "quick_actions" ? (
          <Link className={styles.sourceLink} href={catalog.sourceRoute}>
            {sourceActionLabel(model.id)}{hiddenRows > 0 ? ` · ${hiddenRows} more` : ""}
          </Link>
        ) : null}
      </div>
    </article>
  );
}

export function DashboardHome({
  currentRole,
  currentStudioId,
  currentUserId,
  datasetLoadError,
  isPreviewMode,
  retryDashboardDatasets,
  studioDescription,
  viewModels,
}: DashboardHomeProps) {
  const identity = useMemo(
    () => layoutIdentity(currentUserId, currentStudioId, currentRole),
    [currentRole, currentStudioId, currentUserId]
  );
  const [layout, setLayout] = useState<DashboardLayout>(() => buildDefaultDashboardLayout(currentRole));
  const [isCustomizing, setIsCustomizing] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [activeDragWidgetId, setActiveDragWidgetId] = useState<DashboardWidgetId | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const snapshotRef = useRef<DashboardLayout | null>(null);
  const panelRefs = useRef(new Map<DashboardWidgetId, HTMLElement>());
  const dragRef = useRef<DragSession | null>(null);
  const addPanelsTriggerRef = useRef<HTMLButtonElement>(null);
  const customizeTriggerRef = useRef<HTMLButtonElement>(null);
  const libraryHeadingRef = useRef<HTMLHeadingElement>(null);
  const libraryRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) {
        return;
      }
      const nextLayout = identity
        ? readDashboardLayout(getBrowserDashboardLayoutStorage(), identity).layout
        : buildDefaultDashboardLayout(currentRole);
      setLayout(nextLayout);
    });
    return () => {
      active = false;
    };
  }, [currentRole, identity]);

  const saveLayout = useCallback((next: DashboardLayout) => {
    if (identity) {
      const result = writeDashboardLayout(getBrowserDashboardLayoutStorage(), identity, next);
      setLayout(result.layout);
      return;
    }
    setLayout(next);
  }, [identity]);

  const focusWidget = useCallback((widgetId: DashboardWidgetId) => {
    requestAnimationFrame(() => panelRefs.current.get(widgetId)?.focus());
  }, []);

  const openLibrary = useCallback(() => {
    setIsLibraryOpen(true);
  }, []);

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
    const index = nextItems.findIndex((item) => item.widget_id === widgetId);
    const title = DASHBOARD_WIDGET_BY_ID.get(widgetId)?.title ?? "Panel";
    setAnnouncement(`${title} moved to position ${index + 1} of ${nextItems.length}.`);
  }, []);

  const moveWidget = useCallback((widgetId: DashboardWidgetId, direction: -1 | 1) => {
    const currentIndex = layout.items.findIndex((item) => item.widget_id === widgetId);
    const nextItems = moveLayoutItem(layout.items, widgetId, currentIndex + direction);
    if (nextItems.every((item, index) => item === layout.items[index])) {
      return;
    }
    saveLayout({ ...layout, items: nextItems });
    announcePosition(widgetId, nextItems);
    focusWidget(widgetId);
  }, [announcePosition, focusWidget, layout, saveLayout]);

  const resizeWidget = useCallback((widgetId: DashboardWidgetId) => {
    const catalog = DASHBOARD_WIDGET_BY_ID.get(widgetId);
    const currentItem = layout.items.find((item) => item.widget_id === widgetId);
    if (!catalog || !currentItem || catalog.allowedSizes.length < 2) {
      return;
    }
    const currentSizeIndex = catalog.allowedSizes.indexOf(currentItem.size);
    const nextSize = catalog.allowedSizes[(currentSizeIndex + 1) % catalog.allowedSizes.length];
    if (!nextSize) {
      return;
    }
    const next = {
      ...layout,
      items: layout.items.map((item) => item.widget_id === widgetId ? { ...item, size: nextSize } : item),
    };
    saveLayout(next);
    setAnnouncement(`${catalog.title} resized to ${nextSize}.`);
    focusWidget(widgetId);
  }, [focusWidget, layout, saveLayout]);

  const removeWidget = useCallback((widgetId: DashboardWidgetId) => {
    const catalog = DASHBOARD_WIDGET_BY_ID.get(widgetId);
    if (!catalog?.removable) {
      return;
    }
    const currentIndex = layout.items.findIndex((item) => item.widget_id === widgetId);
    const remainingItems = layout.items.filter((item) => item.widget_id !== widgetId);
    const next = {
      ...layout,
      items: remainingItems,
      removed_widget_ids: Array.from(new Set([...layout.removed_widget_ids, widgetId])),
    };
    saveLayout(next);
    setAnnouncement(`${catalog.title} removed. It remains available in Add panels.`);
    const focusTarget = remainingItems[Math.min(currentIndex, remainingItems.length - 1)];
    if (focusTarget) {
      focusWidget(focusTarget.widget_id);
    } else {
      requestAnimationFrame(() => customizeTriggerRef.current?.focus());
    }
  }, [focusWidget, layout, saveLayout]);

  const addWidget = useCallback((widgetId: DashboardWidgetId) => {
    const catalog = DASHBOARD_WIDGET_BY_ID.get(widgetId);
    if (!catalog || layout.items.some((item) => item.widget_id === widgetId)) {
      return;
    }
    const next = {
      ...layout,
      items: [...layout.items, { widget_id: widgetId, size: catalog.defaultSize }],
      removed_widget_ids: layout.removed_widget_ids.filter((id) => id !== widgetId),
    };
    saveLayout(next);
    setAnnouncement(`${catalog.title} added at position ${next.items.length}.`);
    setIsLibraryOpen(false);
    focusWidget(widgetId);
  }, [focusWidget, layout, saveLayout]);

  const enterCustomize = useCallback(() => {
    snapshotRef.current = {
      ...layout,
      items: layout.items.map((item) => ({ ...item })),
      removed_widget_ids: [...layout.removed_widget_ids],
    };
    setIsCustomizing(true);
    setAnnouncement("Customize mode started. Use the visible move, resize, and remove controls.");
  }, [layout]);

  const finishCustomize = useCallback(() => {
    snapshotRef.current = null;
    setIsCustomizing(false);
    setIsLibraryOpen(false);
    setActiveDragWidgetId(null);
    setAnnouncement("Customize mode finished.");
    requestAnimationFrame(() => customizeTriggerRef.current?.focus());
  }, []);

  const cancelCustomize = useCallback(() => {
    const snapshot = snapshotRef.current;
    if (snapshot) {
      saveLayout(snapshot);
    }
    snapshotRef.current = null;
    setIsCustomizing(false);
    setIsLibraryOpen(false);
    setActiveDragWidgetId(null);
    setAnnouncement("Changes canceled. The previous arrangement was restored.");
    requestAnimationFrame(() => customizeTriggerRef.current?.focus());
  }, [saveLayout]);

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
  }, [cancelCustomize, closeLibrary, isCustomizing, isLibraryOpen]);

  const resetLayout = useCallback(() => {
    const next = {
      ...buildDefaultDashboardLayout(currentRole),
      client_id: layout.client_id,
    };
    saveLayout(next);
    setAnnouncement("Dashboard reset to the role-safe default arrangement.");
    focusWidget("needs_attention");
  }, [currentRole, focusWidget, layout.client_id, saveLayout]);

  const reorderTowardTarget = useCallback((widgetId: DashboardWidgetId, targetId: DashboardWidgetId) => {
    const targetIndex = layout.items.findIndex((item) => item.widget_id === targetId);
    const nextItems = moveLayoutItem(layout.items, widgetId, targetIndex);
    if (nextItems.every((item, index) => item === layout.items[index])) {
      return;
    }
    saveLayout({ ...layout, items: nextItems });
    announcePosition(widgetId, nextItems);
  }, [announcePosition, layout, saveLayout]);

  const startDrag = useCallback((widgetId: DashboardWidgetId, pointerId: number) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== pointerId || session.widgetId !== widgetId) {
      return;
    }
    session.active = true;
    setActiveDragWidgetId(widgetId);
    setAnnouncement(`${DASHBOARD_WIDGET_BY_ID.get(widgetId)?.title ?? "Panel"} picked up.`);
  }, []);

  const onPointerDown = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    widgetId: DashboardWidgetId
  ) => {
    if (!isCustomizing || widgetId === "needs_attention") {
      return;
    }
    const session: DragSession = {
      active: event.pointerType !== "touch",
      pointerId: event.pointerId,
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
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    if (!session.active && Math.abs(event.clientY - session.startY) > 8) {
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
    if (targetId && targetId !== session.widgetId && targetId !== "needs_attention") {
      reorderTowardTarget(session.widgetId, targetId);
    }
    if (event.clientY < 72) {
      window.scrollBy({ top: -24, behavior: "auto" });
    } else if (event.clientY > window.innerHeight - 72) {
      window.scrollBy({ top: 24, behavior: "auto" });
    }
  }, [reorderTowardTarget]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    if (session.timer) clearTimeout(session.timer);
    if (session.active) {
      const index = layout.items.findIndex((item) => item.widget_id === session.widgetId);
      setAnnouncement(`${DASHBOARD_WIDGET_BY_ID.get(session.widgetId)?.title ?? "Panel"} dropped at position ${index + 1}.`);
      focusWidget(session.widgetId);
    }
    dragRef.current = null;
    setActiveDragWidgetId(null);
  }, [focusWidget, layout.items]);

  const addableWidgets = getAddableDashboardWidgets(currentRole, layout.items);

  return (
    <div
      className={styles.home}
      data-koaryu-dashboard-home="true"
      data-dashboard-provenance={isPreviewMode ? "preview" : "live"}
    >
      <section className={styles.homeHeading} aria-labelledby="dashboard-home-heading">
        <div>
          <p className={styles.eyebrow}>Tatami Home · personal arrangement</p>
          <h1 id="dashboard-home-heading">My studio</h1>
          <p>{studioDescription}</p>
        </div>
        <div className={styles.homeActions}>
          {isCustomizing ? (
            <>
              <button ref={addPanelsTriggerRef} type="button" onClick={openLibrary} aria-expanded={isLibraryOpen} aria-haspopup="dialog">
                <Plus aria-hidden="true" size={17} /> Add panels
              </button>
              <button type="button" onClick={resetLayout}>
                <RotateCcw aria-hidden="true" size={17} /> Reset
              </button>
              <button type="button" className={styles.primaryAction} onClick={finishCustomize}>Done</button>
            </>
          ) : (
            <button ref={customizeTriggerRef} type="button" className={styles.primaryAction} onClick={enterCustomize}>
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
          Arrangement changes stay on this browser for this user, studio, and role. Press Escape to restore the entry snapshot.
        </p>
      ) : null}

      <section
        className={`${styles.canvas} ${isCustomizing ? styles.customizing : ""}`}
        aria-label="Customizable home panels"
      >
        <div className={styles.grid}>
          {layout.items.map((item, index) => (
            <HomeWidget
              key={item.widget_id}
              index={index}
              item={item}
              isCustomizing={isCustomizing}
              isPickedUp={activeDragWidgetId === item.widget_id}
              model={viewModels[item.widget_id]}
              onMove={moveWidget}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onRemove={removeWidget}
              onResize={resizeWidget}
              panelRef={(node) => {
                if (node) panelRefs.current.set(item.widget_id, node);
                else panelRefs.current.delete(item.widget_id);
              }}
              total={layout.items.length}
            />
          ))}
        </div>
      </section>

      {isLibraryOpen ? (
        <aside ref={libraryRef} className={styles.library} role="dialog" aria-modal="true" aria-labelledby="widget-library-heading">
          <header>
            <div>
              <p className={styles.eyebrow}>Panel library</p>
              <h2 ref={libraryHeadingRef} tabIndex={-1} id="widget-library-heading">Add to your home</h2>
              <p>Only panels entitled for the current server-derived role appear here.</p>
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
