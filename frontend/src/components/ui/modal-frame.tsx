"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

type ModalFrameLabel =
  | { ariaLabel: string; ariaLabelledBy?: never }
  | { ariaLabel?: never; ariaLabelledBy: string };

type ModalFrameProps = ModalFrameLabel & {
  children: ReactNode;
  onBackdropClick?: () => void;
  rootClassName?: string;
  panelClassName: string;
  ariaDescribedBy?: string;
  role?: "dialog" | "alertdialog";
};

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(" ");
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function ModalFrame({
  children,
  onBackdropClick,
  rootClassName,
  panelClassName,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  role = "dialog",
}: ModalFrameProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const panel = panelRef.current;

    window.requestAnimationFrame(() => {
      const nextFocus = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? panel;
      nextFocus?.focus();
    });

    return () => {
      if (previousActiveElement && document.contains(previousActiveElement)) {
        previousActiveElement.focus();
      }
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && onBackdropClick) {
      event.stopPropagation();
      onBackdropClick();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    ).filter((element) => element.offsetParent !== null || element === document.activeElement);

    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;

    if (event.shiftKey && activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={joinClassNames("koaryu-modal-root", rootClassName)}
      onKeyDown={handleKeyDown}
    >
      <div
        aria-hidden="true"
        className="koaryu-modal-backdrop"
        onClick={onBackdropClick}
      />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        className={joinClassNames("koaryu-modal-panel", panelClassName)}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
