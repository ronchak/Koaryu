"use client";

import { GripVertical } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { HorizonSheet, usePositionSettle } from "@/components/ui/horizon";
import { HOME_COPY } from "@/lib/dashboard/home-copy";
import { HOME_PANEL_KEYS } from "@/lib/dashboard/home-panels";
import type { HomePanelId, HomePreferences } from "@/lib/dashboard/home-preferences";
import styles from "./edit-home-sheet.module.css";

/*
 * Edit Home (D5): the fixed bands, said once, then each optional panel the
 * role may see with a handle, its title and a switch. Every change applies to
 * Home behind the sheet at once; there is nothing to cancel. Reorder with the
 * handle by dragging (insertion index, never coordinates) or with ArrowUp and
 * ArrowDown; a polite live region says what happened.
 */

const COPY = HOME_COPY.edit;
const BANDS = [COPY.band.glance, COPY.band.attention, COPY.band.classes] as const;

export type EditHomeSheetProps = {
  preferences: HomePreferences;
  isDefault: boolean;
  onMove: (id: HomePanelId, offset: number) => void;
  onMoveTo: (id: HomePanelId, index: number) => void;
  onShow: (id: HomePanelId, shown: boolean) => void;
  onReset: () => void;
  /** Done, Escape and the backdrop all close the sheet this way. */
  onDone: () => void;
};

type Drag = {
  id: HomePanelId;
  pointerId: number;
  /** Pointer distance from the row's top when it was picked up. */
  grab: number;
  clientY: number;
  startIndex: number;
  /** Removes the window listeners that follow this gesture. */
  detach: () => void;
};

function panelTitle(id: HomePanelId): string {
  return COPY.panel[HOME_PANEL_KEYS[id]];
}

export function EditHomeSheet({
  preferences,
  isDefault,
  onMove,
  onMoveTo,
  onShow,
  onReset,
  onDone,
}: EditHomeSheetProps) {
  const settle = usePositionSettle<HomePanelId>();
  const listRef = useRef<HTMLUListElement | null>(null);
  const rows = useRef(new Map<HomePanelId, HTMLLIElement>());
  const handles = useRef(new Map<HomePanelId, HTMLButtonElement>());
  const resetRef = useRef<HTMLButtonElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);
  const refocus = useRef<HomePanelId | "done" | null>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<HomePanelId | null>(null);
  const [announcement, setAnnouncement] = useState({ text: "", serial: 0 });
  const { order, hidden } = preferences;

  const announce = (text: string) =>
    setAnnouncement((current) => ({ text, serial: current.serial + 1 }));
  const announceMove = (id: HomePanelId, offset: number) =>
    announce(
      offset < 0 ? COPY.announce.movedUp(panelTitle(id)) : COPY.announce.movedDown(panelTitle(id)),
    );

  // Keep the dragged row under the pointer after its slot changes.
  const placeDragged = () => {
    const current = drag.current;
    const row = current ? rows.current.get(current.id) : null;
    const list = listRef.current;
    if (!current || !row || !list) return;
    const naturalTop = list.getBoundingClientRect().top + row.offsetTop;
    row.style.transform = `translate3d(0, ${current.clientY - current.grab - naturalTop}px, 0)`;
  };

  useLayoutEffect(() => {
    placeDragged();
    // Moving the dragged row in the DOM drops its pointer capture; take it back
    // so a release outside the window still ends the drag.
    const current = drag.current;
    const handle = current ? handles.current.get(current.id) : null;
    if (current && handle && !handle.hasPointerCapture(current.pointerId)) {
      try {
        handle.setPointerCapture(current.pointerId);
      } catch {
        // The pointer is already gone; its pointerup or pointercancel ends the drag.
      }
    }
    const target = refocus.current;
    refocus.current = null;
    const node = target === "done" ? doneRef.current : target ? handles.current.get(target) : null;
    if (node && document.activeElement !== node) node.focus();
  });

  function move(id: HomePanelId, offset: number) {
    const target = order.indexOf(id) + offset;
    if (target < 0 || target >= order.length) return;
    settle.capture();
    refocus.current = id;
    onMove(id, offset);
    announceMove(id, offset);
  }

  function onHandleKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: HomePanelId) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    if (drag.current) return;
    move(id, event.key === "ArrowUp" ? -1 : 1);
  }

  function toggle(id: HomePanelId) {
    const shown = hidden.includes(id);
    onShow(id, shown);
    announce(shown ? COPY.announce.shown(panelTitle(id)) : COPY.announce.hidden(panelTitle(id)));
  }

  function reset() {
    settle.capture();
    // Reset disables itself; keep focus inside the sheet, on Done.
    if (document.activeElement === resetRef.current) refocus.current = "done";
    onReset();
    announce(COPY.announce.reset);
  }

  // ── Pointer and touch drag: the row follows the pointer; the list reorders
  // by insertion index as the row's middle passes its neighbours' middles.
  // The gesture is followed on the window, not the handle: each reorder moves
  // the dragged row in the DOM, which releases the handle's pointer capture,
  // so only pointerup or pointercancel ends a drag.
  const dragListeners = useRef<{
    move: (event: PointerEvent) => void;
    end: (event: PointerEvent) => void;
  } | null>(null);
  useEffect(() => () => drag.current?.detach(), []);

  function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: HomePanelId) {
    if (drag.current || (event.pointerType === "mouse" && event.button !== 0)) return;
    const row = rows.current.get(id);
    if (!row) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => dragListeners.current?.move(pointer);
    const end = (pointer: PointerEvent) => dragListeners.current?.end(pointer);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    drag.current = {
      id,
      pointerId: event.pointerId,
      grab: event.clientY - row.getBoundingClientRect().top,
      clientY: event.clientY,
      startIndex: order.indexOf(id),
      detach: () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", end, true);
        window.removeEventListener("pointercancel", end, true);
      },
    };
    setDragging(id);
  }

  function onDragMove(event: PointerEvent) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    current.clientY = event.clientY;
    placeDragged();
    const row = rows.current.get(current.id);
    const list = listRef.current;
    if (!row || !list) return;
    const listTop = list.getBoundingClientRect().top;
    const middle = current.clientY - current.grab + row.offsetHeight / 2;
    let index = 0;
    for (const other of order) {
      if (other === current.id) continue;
      const node = rows.current.get(other);
      if (node && listTop + node.offsetTop + node.offsetHeight / 2 < middle) index += 1;
    }
    if (index !== order.indexOf(current.id)) {
      settle.capture({ except: current.id });
      // The moved row loses focus with its place in the DOM; keep it on the handle.
      refocus.current = current.id;
      onMoveTo(current.id, index);
    }
  }

  function endDrag(event: PointerEvent) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    current.detach();
    drag.current = null;
    setDragging(null);
    const handle = handles.current.get(current.id);
    if (handle?.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    const row = rows.current.get(current.id);
    if (row) {
      const offset = row.style.transform;
      row.style.removeProperty("transform");
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (offset && !reduce && typeof row.animate === "function") {
        row.animate([{ transform: offset }, { transform: "translate3d(0, 0, 0)" }], {
          duration: 180,
          easing: "cubic-bezier(.16, 1, .3, 1)",
        });
      }
    }
    const moved = order.indexOf(current.id) - current.startIndex;
    if (moved !== 0) announceMove(current.id, moved);
  }

  // The window listeners always reach this render's handlers (its `order`).
  useLayoutEffect(() => {
    dragListeners.current = { move: onDragMove, end: endDrag };
  });

  return (
    <HorizonSheet
      titleId="home-edit-title"
      title={COPY.title}
      onClose={onDone}
      data-home-edit="sheet"
      footer={
        <>
          <Button
            ref={resetRef}
            variant="ghost"
            size="lg"
            data-home-edit="reset"
            disabled={isDefault}
            onClick={reset}
          >
            {COPY.reset}
          </Button>
          <Button ref={doneRef} variant="primary" size="lg" data-home-edit="done" onClick={onDone}>
            {COPY.done}
          </Button>
        </>
      }
    >
      <section className={styles.group} aria-labelledby="home-edit-always">
        <h3 id="home-edit-always" className={styles.groupLabel}>
          {COPY.alwaysShown}
        </h3>
        <ul className={styles.list}>
          {BANDS.map((band) => (
            <li key={band} className={styles.fixedRow} data-home-edit-band="">
              {band}
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.group} aria-labelledby="home-edit-panels">
        <h3 id="home-edit-panels" className={styles.groupLabel}>
          {COPY.panels}
        </h3>
        <ul ref={listRef} className={styles.list}>
          {order.map((id) => {
            const title = panelTitle(id);
            const shown = !hidden.includes(id);
            const register = settle.register(id);
            return (
              <li
                key={id}
                ref={(node) => {
                  register(node);
                  if (node) rows.current.set(id, node);
                  else rows.current.delete(id);
                }}
                className={styles.row}
                data-home-edit-panel={HOME_PANEL_KEYS[id]}
                data-shown={shown ? "true" : "false"}
                data-dragging={dragging === id ? "true" : undefined}
              >
                <button
                  type="button"
                  ref={(node) => {
                    if (node) handles.current.set(id, node);
                    else handles.current.delete(id);
                  }}
                  className={styles.handle}
                  aria-label={COPY.move(title)}
                  onKeyDown={(event) => onHandleKeyDown(event, id)}
                  onPointerDown={(event) => onPointerDown(event, id)}
                >
                  <GripVertical aria-hidden="true" />
                </button>
                <span className={styles.rowTitle}>{title}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={shown}
                  aria-label={COPY.show(title)}
                  className={styles.switch}
                  onClick={() => toggle(id)}
                >
                  <span className={styles.track} aria-hidden="true">
                    <span className={styles.thumb} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        <span key={announcement.serial}>{announcement.text}</span>
      </p>
    </HorizonSheet>
  );
}
