import type { StudentStatus } from "@/types";

const statusConfig: Record<
  StudentStatus,
  { label: string; variant: string; dot: string }
> = {
  active: {
    label: "Active",
    variant: "bg-success/10 text-success border-success/20",
    dot: "bg-success",
  },
  trialing: {
    label: "Trial",
    variant: "bg-accent/10 text-accent border-accent/20",
    dot: "bg-accent",
  },
  inactive: {
    label: "Inactive",
    variant: "bg-surface-raised text-text-secondary border-border",
    dot: "bg-muted",
  },
  paused: {
    label: "Paused",
    variant: "bg-warning/10 text-warning border-warning/20",
    dot: "bg-warning",
  },
  canceled: {
    label: "Canceled",
    variant: "bg-danger/10 text-danger border-danger/20",
    dot: "bg-danger",
  },
};

interface StatusBadgeProps {
  status: StudentStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.inactive;
  return (
    <span
      className={`
        inline-flex items-center gap-1.5
        px-2 py-0.5 text-xs font-medium font-mono
        rounded-[4px] border
        ${config.variant}
      `}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot}`} />
      {config.label}
    </span>
  );
}
