"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import styles from "./reveal-text.module.css";

/*
 * Text an ellipsis may cut. While it is cut, a click on it shows it whole in
 * place instead of doing what the row around it does; a second click, a click
 * anywhere else (which still does its own thing) or Escape folds it again. It
 * is not a control: the whole text is already in the page for screen readers
 * (and in `title` on hover), and the keyboard keeps the row's own action. Text
 * that fits is left alone, so a click on it still opens the row.
 */

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function isCut(node: HTMLElement): boolean {
  return node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
}

type RevealTextProps = Omit<HTMLAttributes<HTMLElement>, "onClick" | "children"> & {
  as?: "span" | "strong" | "p";
  children: ReactNode;
};

export function RevealText({ as: Tag = "span", className, children, ...rest }: RevealTextProps) {
  const node = useRef<HTMLElement | null>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);

  // Measured before paint and on every resize; an open text is not re-measured.
  useIsomorphicLayoutEffect(() => {
    const element = node.current;
    if (!element || open) return;
    const measure = () => setCut(isCut(element));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children, open]);

  // A click anywhere else folds it and still does what that click does, so a
  // click on the rest of an opened row or block opens it in the same click.
  useEffect(() => {
    if (!open) return;
    const foldOutside = (event: MouseEvent) => {
      if (!node.current?.contains(event.target as Node)) setOpen(false);
    };
    const foldOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", foldOutside, true);
    document.addEventListener("keydown", foldOnEscape);
    return () => {
      document.removeEventListener("click", foldOutside, true);
      document.removeEventListener("keydown", foldOnEscape);
    };
  }, [open]);

  const toggle = (event: ReactMouseEvent<HTMLElement>) => {
    if (!open && !cut) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(!open);
  };

  return (
    <Tag
      {...rest}
      ref={(element: HTMLElement | null) => {
        node.current = element;
      }}
      className={className ? `${styles.reveal} ${className}` : styles.reveal}
      data-cut={cut ? "true" : undefined}
      data-open={open ? "true" : undefined}
      onClick={toggle}
    >
      {children}
    </Tag>
  );
}
