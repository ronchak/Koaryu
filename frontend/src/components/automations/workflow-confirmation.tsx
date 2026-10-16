"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./workflow-workspace.module.css";

/** A modal question with one way to keep editing and one to confirm; focus returns on close. */
export function WorkflowConfirmation({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  disabled = false,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        dialog.current?.close();
        onCancel();
      }}
    >
      <h2>{title}</h2>
      <div className={styles.dialogBody}>{children}</div>
      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => {
            dialog.current?.close();
            onCancel();
          }}
          autoFocus
        >
          Keep editing
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            dialog.current?.close();
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
