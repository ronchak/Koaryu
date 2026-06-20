import { Inbox } from "lucide-react";
import { ActionEmptyState } from "@/components/ui/overview";

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
    <ActionEmptyState
      icon={Inbox}
      title="Nothing here yet"
      description={message}
      actionLabel={actionLabel}
      actionHref={actionHref}
      onAction={onAction}
      actionVariant="secondary"
      className="mx-auto my-12 max-w-xl"
    />
  );
}
