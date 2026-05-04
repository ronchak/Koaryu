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

const actionStyles: Record<ActionVariant, string> = {
  primary: "bg-accent text-accent-contrast hover:bg-accent-hover",
  secondary:
    "border border-border bg-surface-raised text-text-primary hover:bg-surface-hover",
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
    inline-flex min-h-10 items-center justify-center gap-2 rounded-[6px]
    px-3.5 py-2 text-sm font-medium
    transition-[background-color,border-color,color] duration-150 ease-out motion-reduce:transition-none
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
      <Link href={href} className={className}>
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
