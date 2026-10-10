type BadgeVariant = "default" | "success" | "warning" | "danger" | "accent";

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

// Horizon tone tags: a tinted pill whose words carry the state.
const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-[var(--hz-tile)] text-text-secondary border-transparent",
  success: "bg-[var(--hz-affirm-wash)] text-success border-transparent",
  warning: "bg-[var(--hz-warn-wash)] text-warning border-transparent",
  danger: "bg-[var(--hz-alert-wash)] text-danger border-transparent",
  accent: "bg-[var(--hz-warn-wash)] text-accent border-transparent",
};

export function Badge({ children, variant = "default", className = "" }: BadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center
        px-2 py-0.5 text-xs font-semibold
        rounded-full border
        ${variantStyles[variant]}
        ${className}
      `}
    >
      {children}
    </span>
  );
}
