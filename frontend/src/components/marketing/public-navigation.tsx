"use client";

import { usePathname } from "next/navigation";
import { MarketingNavLink } from "./marketing-primitives";
import { useEffect, useRef, type ReactNode } from "react";

import styles from "./public-pages.module.css";

export function PublicDocumentLink({
  href,
  children,
  ...props
}: {
  href: string;
  children: ReactNode;
  className?: string;
  prefetch?: false;
}) {
  const pathname = usePathname();
  return (
    <MarketingNavLink href={href} aria-current={pathname === href ? "page" : undefined} {...props}>
      {children}
    </MarketingNavLink>
  );
}

/** Native details remains usable before JavaScript, with familiar dismissal after hydration. */
export function PublicMobileNavigation({ children }: { children: ReactNode }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const details = detailsRef.current;
    if (!details) return;

    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !details?.contains(event.target)) {
        details?.removeAttribute("open");
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !details?.open) return;
      details.removeAttribute("open");
      details.querySelector("summary")?.focus();
    }

    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <details
      ref={detailsRef}
      className={styles.mobileNavigation}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a")) {
          detailsRef.current?.removeAttribute("open");
        }
      }}
    >
      <summary aria-label="Navigation menu">
        <span className={styles.mobileMenuLabel}>Menu</span>
        <span className={styles.mobileMenuIcon} aria-hidden="true" />
      </summary>
      <nav className={styles.mobileMenu} aria-label="Mobile navigation">
        {children}
      </nav>
    </details>
  );
}
