"use client";

import type { ReactNode } from "react";
import { ModalFrame } from "./modal-frame";
import type { HorizonDataAttributes } from "./horizon-parts";
import styles from "./horizon-sheet.module.css";

/**
 * A sheet for settings that apply as they change: a right-side sheet on wider
 * screens, a full-height bottom sheet at 640px and below, with the footer
 * always in reach. Built on `ModalFrame`: `role="dialog"`, `aria-modal`,
 * labelled by its title; focus moves in on open, stays inside, and returns to
 * where it was on close; Escape and the backdrop call `onClose`. The backdrop
 * only veils the page, so changes behind the sheet stay visible.
 *
 * - `title` is the dialog's name, shown as its heading; `titleId` must be unique.
 * - `footer` holds the sheet's actions (one primary at most).
 * - `data-*` attributes land on the dialog's content.
 */
export function HorizonSheet({
  children,
  footer,
  onClose,
  title,
  titleId,
  ...data
}: {
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  title: ReactNode;
  titleId: string;
} & HorizonDataAttributes) {
  return (
    <ModalFrame
      rootClassName={styles.root}
      panelClassName={styles.sheet}
      ariaLabelledBy={titleId}
      onBackdropClick={onClose}
    >
      <div {...data} className={styles.content}>
        <header className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
        </header>
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.foot}>{footer}</footer> : null}
      </div>
    </ModalFrame>
  );
}
