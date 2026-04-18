import { Button } from "./button";

interface EmptyStateProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  actionHref?: string;
}

export function EmptyState({
  message,
  actionLabel,
  onAction,
  actionHref,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-4">
      <p className="text-sm text-text-secondary mb-4">{message}</p>
      {actionLabel && (
        actionHref ? (
          <a href={actionHref}>
            <Button variant="secondary" size="sm">
              {actionLabel}
            </Button>
          </a>
        ) : (
          <Button variant="secondary" size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        )
      )}
    </div>
  );
}
