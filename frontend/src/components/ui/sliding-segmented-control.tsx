"use client";

import {
  useRef,
  type CSSProperties,
  type ElementType,
  type KeyboardEvent,
} from "react";

import styles from "./sliding-segmented-control.module.css";

export type SlidingSegment<T extends string> = {
  id: T;
  label: string;
  icon?: ElementType;
  disabled?: boolean;
  controls?: string;
};

type SlidingSegmentedControlProps<T extends string> = {
  activeValue: T;
  ariaLabel: string;
  className?: string;
  idPrefix?: string;
  items: SlidingSegment<T>[];
  mode?: "selection" | "tabs";
  onChange: (value: T) => void;
  size?: "compact" | "default";
};

export function SlidingSegmentedControl<T extends string>({
  activeValue,
  ariaLabel,
  className = "",
  idPrefix,
  items,
  mode = "selection",
  onChange,
  size = "default",
}: SlidingSegmentedControlProps<T>) {
  const buttonRefs = useRef(new Map<T, HTMLButtonElement>());
  const activeIndex = items.findIndex((item) => item.id === activeValue);
  const selectedIndex = Math.max(0, activeIndex);

  function moveSelection(event: KeyboardEvent<HTMLButtonElement>, currentId: T) {
    const enabledItems = items.filter((item) => !item.disabled);
    const currentIndex = enabledItems.findIndex((item) => item.id === currentId);
    let nextIndex: number | null = null;

    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + enabledItems.length) % enabledItems.length;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % enabledItems.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = enabledItems.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextItem = enabledItems[nextIndex];
    if (!nextItem) return;

    onChange(nextItem.id);
    window.requestAnimationFrame(() => buttonRefs.current.get(nextItem.id)?.focus());
  }

  return (
    <div
      role={mode === "tabs" ? "tablist" : "group"}
      aria-label={ariaLabel}
      className={`${styles.control} ${className}`.trim()}
      data-has-selection={activeIndex >= 0 ? "true" : "false"}
      data-size={size}
      style={{
        "--segment-count": items.length,
        "--segment-index": selectedIndex,
      } as CSSProperties}
    >
      <span className={styles.indicator} aria-hidden="true" />
      {items.map((item, index) => {
        const Icon = item.icon;
        const selected = item.id === activeValue;
        const isFallbackTabStop = activeIndex < 0 && index === 0;

        return (
          <button
            key={item.id}
            ref={(node) => {
              if (node) buttonRefs.current.set(item.id, node);
              else buttonRefs.current.delete(item.id);
            }}
            id={idPrefix ? `${idPrefix}-${item.id}` : undefined}
            type="button"
            role={mode === "tabs" ? "tab" : undefined}
            aria-selected={mode === "tabs" ? selected : undefined}
            aria-pressed={mode === "selection" ? selected : undefined}
            aria-controls={mode === "tabs" ? item.controls : undefined}
            tabIndex={selected || isFallbackTabStop ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => moveSelection(event, item.id)}
            className={styles.button}
            data-active={selected ? "true" : "false"}
          >
            {Icon ? <Icon aria-hidden="true" className={styles.icon} /> : null}
            <span className={styles.label}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
