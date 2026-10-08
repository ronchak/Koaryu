"use client";

import { useEffect, useRef, useState } from "react";

import styles from "./legal-document.module.css";

export interface LegalContentsItem {
  id: string;
  label: string;
  number?: string;
}

// The heading the reader is in is the last one above this line.
const READING_LINE = 0.28;

function useCurrentSection(ids: readonly string[]) {
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (sections.length === 0) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = window.innerHeight * READING_LINE;
      let next: string | null = null;
      for (const section of sections) {
        if (section.getBoundingClientRect().top - line > 0) break;
        next = section.id;
      }
      const atEnd =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      if (atEnd) next = sections[sections.length - 1].id;
      setCurrent(next);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [ids]);

  return current;
}

function ContentsList({
  current,
  items,
  onNavigate,
}: {
  current: string | null;
  items: readonly LegalContentsItem[];
  onNavigate?: () => void;
}) {
  return (
    <ol className={styles.contentsList}>
      {items.map((item) => (
        <li key={item.id}>
          <a
            href={`#${item.id}`}
            aria-current={current === item.id ? "location" : undefined}
            onClick={onNavigate}
          >
            <span className={styles.contentsNumber} aria-hidden="true">
              {item.number ?? ""}
            </span>
            <span>{item.label}</span>
          </a>
        </li>
      ))}
    </ol>
  );
}

export function LegalContents({
  items,
  label,
}: {
  items: readonly LegalContentsItem[];
  label: string;
}) {
  const [ids] = useState(() => items.map((item) => item.id));
  const current = useCurrentSection(ids);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLDetailsElement>(null);
  const numbered = items.filter((item) => item.number).length;

  // A long contents list scrolls on its own; keep the reader's entry inside it.
  useEffect(() => {
    const nav = navRef.current;
    const link = nav?.querySelector<HTMLElement>('a[aria-current="location"]');
    if (!nav || !link || nav.scrollHeight <= nav.clientHeight) return;
    const navBox = nav.getBoundingClientRect();
    const linkBox = link.getBoundingClientRect();
    if (linkBox.top >= navBox.top + 48 && linkBox.bottom <= navBox.bottom - 48) return;
    nav.scrollTop += linkBox.top - navBox.top - nav.clientHeight / 2 + linkBox.height / 2;
  }, [current]);

  return (
    <nav ref={navRef} className={styles.contents} aria-label={label}>
      <div className={styles.contentsDesktop}>
        <p className={styles.eyebrow}>Contents</p>
        <ContentsList current={current} items={items} />
      </div>
      <details ref={toggleRef} className={styles.contentsToggle}>
        <summary>
          <span className={styles.eyebrow}>Contents</span>
          <span className={styles.contentsCount}>{numbered} sections</span>
        </summary>
        <ContentsList
          current={current}
          items={items}
          onNavigate={() => toggleRef.current?.removeAttribute("open")}
        />
      </details>
    </nav>
  );
}

export function LegalPrintButton() {
  return (
    <button type="button" className={styles.printButton} onClick={() => window.print()}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M4 6V1.75h8V6M4 12H2.5A1 1 0 0 1 1.5 11V7a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H12M4 9.5h8v4.75H4z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
      Print or save PDF
    </button>
  );
}
