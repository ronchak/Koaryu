import type { ReactNode } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";

type ActionVariant = "primary" | "secondary" | "ghost";

interface StatusActionProps {
  children: ReactNode;
  icon: LucideIcon;
  href?: string;
  onClick?: () => void;
  variant?: ActionVariant;
}

// Horizon: the ink call to action (amber at night) and paper secondaries.
const actionStyles: Record<ActionVariant, string> = {
  primary:
    "bg-[var(--hz-cta)] text-[var(--hz-cta-ink)] shadow-[0_8px_22px_rgb(45_34_18/16%)] hover:-translate-y-px",
  secondary: "border border-border bg-surface text-text-primary hover:bg-surface-raised",
  ghost: "text-text-secondary hover:bg-surface-raised hover:text-text-primary",
};

export function StatusAction({
  children,
  icon: Icon,
  href,
  onClick,
  variant = "primary",
}: StatusActionProps) {
  const className = `
    inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px]
    px-4 py-2 text-sm font-semibold
    transition-[background-color,border-color,color,transform] duration-150 ease-out
    motion-reduce:transition-none motion-reduce:hover:translate-y-0
    ${actionStyles[variant]}
  `;
  const content = (
    <>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </>
  );

  if (href) {
    return (
      <Link href={href} prefetch={false} className={className}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}
