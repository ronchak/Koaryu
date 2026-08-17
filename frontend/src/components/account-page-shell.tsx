import Link from "next/link";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { Badge } from "@/components/ui/badge";
import { crmLinkPrefetch } from "@/lib/constants";
import type { LucideIcon } from "lucide-react";

interface AccountPageShellProps {
  title: string;
  description: string;
  badge?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  family?: "account" | "help";
}

interface AccountSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

interface AccountLinkTileProps {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  badge?: string;
}

interface AccountInfoRowProps {
  label: string;
  value: React.ReactNode;
  detail?: string;
}

export function AccountPageShell({
  title,
  description,
  badge,
  children,
  actions,
  family = "account",
}: AccountPageShellProps) {
  return (
    <OperationsSurface page={family}>
      <Header title={title} description={description}>
        {badge && <Badge variant="accent">{badge}</Badge>}
        {actions}
      </Header>
      <div className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
        <div className="mx-auto max-w-5xl space-y-8">{children}</div>
      </div>
    </OperationsSurface>
  );
}

export function AccountSection({
  title,
  description,
  children,
  className = "",
}: AccountSectionProps) {
  return (
    <section className={`border-y border-border bg-surface px-4 py-5 sm:px-5 ${className}`}>
      <div className="mb-5 grid gap-1 sm:grid-cols-[minmax(10rem,0.32fr)_1fr] sm:gap-6">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function AccountLinkTile({
  href,
  title,
  description,
  icon: Icon,
  badge,
}: AccountLinkTileProps) {
  return (
    <Link
      href={href}
      prefetch={crmLinkPrefetch(href)}
      className="group grid min-h-20 grid-cols-[2.25rem_1fr_auto] items-center gap-3 border-b border-border bg-surface px-3 py-4 last:border-b-0 hover:bg-surface-raised motion-reduce:transition-none"
    >
      <span className="flex h-9 w-9 items-center justify-center border-r border-border text-accent">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="block min-w-0">
        <span className="block text-sm font-medium text-text-primary">{title}</span>
        <span className="mt-1 block text-sm leading-relaxed text-text-secondary">{description}</span>
      </span>
      {badge ? <Badge>{badge}</Badge> : <span aria-hidden="true" className="text-accent">→</span>}
    </Link>
  );
}

export function AccountInfoRow({ label, value, detail }: AccountInfoRowProps) {
  return (
    <div className="grid gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[minmax(10rem,0.32fr)_1fr] sm:items-start sm:gap-6">
      <div>
        <p className="text-sm font-medium text-text-primary">{label}</p>
        {detail && <p className="text-xs text-muted">{detail}</p>}
      </div>
      <div className="text-sm text-text-secondary">{value}</div>
    </div>
  );
}

export function AccountNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-l-2 border-accent bg-surface-raised p-4 text-sm leading-relaxed text-text-secondary">
      {children}
    </div>
  );
}
