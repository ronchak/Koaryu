import Link from "next/link";

import { MarketingActionLink } from "../marketing-primitives";
import styles from "./page.module.css";

function prefetchFor(href: string): false | undefined {
  return href === "/signup" || href === "/login" ? false : undefined;
}

export function LandingAction({
  href,
  label,
  variant = "secondary",
}: {
  href: string;
  label: string;
  variant?: "primary" | "secondary";
}) {
  return (
    <MarketingActionLink
      href={href}
      prefetch={prefetchFor(href)}
      variant={variant}
      className={styles.action}
    >
      {label}
    </MarketingActionLink>
  );
}

export function LandingTextLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className={styles.textLink} href={href}>
      {label} <span aria-hidden="true">→</span>
    </Link>
  );
}
