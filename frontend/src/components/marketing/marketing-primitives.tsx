import Link from "next/link";
import type {
  ButtonHTMLAttributes,
  ComponentPropsWithoutRef,
  ReactNode,
} from "react";

import styles from "./marketing-foundation.module.css";

type NextLinkProps = ComponentPropsWithoutRef<typeof Link>;

interface MarketingLinkProps extends Omit<NextLinkProps, "children" | "className"> {
  children: ReactNode;
  className?: string;
}

export interface MarketingBrandLinkProps
  extends Omit<MarketingLinkProps, "children"> {
  children?: ReactNode;
}

export interface MarketingActionLinkProps extends MarketingLinkProps {
  variant?: "primary" | "secondary";
}

export type MarketingMenuButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
>;

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(" ");
}

export function MarketingBrandLink({
  children = "Koaryu",
  className,
  "aria-label": ariaLabel = "Return to Koaryu home",
  ...props
}: MarketingBrandLinkProps) {
  return (
    <Link
      {...props}
      aria-label={ariaLabel}
      className={joinClassNames(styles.wordmark, className)}
    >
      {children}
    </Link>
  );
}

export function MarketingNavLink({
  children,
  className,
  ...props
}: MarketingLinkProps) {
  return (
    <Link {...props} className={joinClassNames(styles.navLink, className)}>
      {children}
    </Link>
  );
}

export function MarketingActionLink({
  children,
  className,
  variant = "primary",
  ...props
}: MarketingActionLinkProps) {
  const variantClass =
    variant === "primary" ? styles.primaryAction : styles.secondaryAction;

  return (
    <Link
      {...props}
      className={joinClassNames(styles.actionLink, variantClass, className)}
    >
      <span className={variant === "primary" ? styles.primaryActionLabel : undefined}>
        {children}
      </span>
    </Link>
  );
}

export function MarketingMenuButton({
  className,
  type = "button",
  "aria-expanded": ariaExpanded,
  "aria-label": ariaLabel,
  ...props
}: MarketingMenuButtonProps) {
  return (
    <button
      {...props}
      type={type}
      aria-expanded={ariaExpanded}
      aria-label={
        ariaLabel ?? (ariaExpanded ? "Close navigation" : "Open navigation")
      }
      className={joinClassNames(styles.menuButton, className)}
    >
      <span className={styles.menuIcon} aria-hidden="true" />
    </button>
  );
}
