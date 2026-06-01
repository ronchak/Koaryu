import Link from "next/link";
import { Header } from "@/components/header";
import { Badge } from "@/components/ui/badge";
import { crmLinkPrefetch } from "@/lib/constants";
import type { LucideIcon } from "lucide-react";

interface AccountPageShellProps {
  title: string;
  description: string;
  badge?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
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
}: AccountPageShellProps) {
  return (
    <>
      <Header title={title} description={description}>
        {badge && <Badge variant="accent">{badge}</Badge>}
        {actions}
      </Header>
      <div className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <div className="max-w-5xl space-y-6">{children}</div>
      </div>
    </>
  );
}

export function AccountSection({
  title,
  description,
  children,
  className = "",
}: AccountSectionProps) {
  return (
    <section className={`rounded-[6px] border border-border bg-surface p-5 ${className}`}>
      <div className="mb-4">
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
      className="group flex h-full min-h-28 flex-col justify-between rounded-[6px] border border-border bg-surface p-4 transition-[background-color,border-color,box-shadow,transform] duration-[220ms] ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:bg-surface-raised hover:shadow-lg hover:shadow-black/10 motion-reduce:transition-none"
    >
      <span className="flex items-start justify-between gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-[6px] bg-accent/10 text-accent transition-transform duration-200 ease-out group-hover:-translate-y-0.5 motion-reduce:transition-none">
          <Icon className="h-4 w-4" />
        </span>
        {badge && <Badge>{badge}</Badge>}
      </span>
      <span className="mt-4 block">
        <span className="block text-sm font-medium text-text-primary">{title}</span>
        <span className="mt-1 block text-sm leading-relaxed text-text-secondary">{description}</span>
      </span>
    </Link>
  );
}

export function AccountInfoRow({ label, value, detail }: AccountInfoRowProps) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div>
        <p className="text-sm font-medium text-text-primary">{label}</p>
        {detail && <p className="text-xs text-muted">{detail}</p>}
      </div>
      <div className="text-sm text-text-secondary sm:text-right">{value}</div>
    </div>
  );
}

export function AccountNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[6px] border border-accent/20 bg-accent/10 p-4 text-sm leading-relaxed text-text-secondary">
      {children}
    </div>
  );
}
