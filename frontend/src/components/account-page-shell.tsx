import { IntentPrefetchLink as Link } from "@/components/intent-prefetch-link";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { HorizonPage, HorizonPanel, ToneChip } from "@/components/settings/horizon-parts";
import { Badge } from "@/components/ui/badge";
import { crmLinkPrefetch } from "@/lib/constants";
import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";
import styles from "@/components/account/account.module.css";

interface AccountPageShellProps {
  title: string;
  description: string;
  badge?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  family?: "account" | "help";
  /** A short label above the title; defaults to the page family. */
  eyebrow?: string;
}

interface AccountSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  /** `danger` sets apart a section whose actions cannot be undone. */
  tone?: "danger";
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
  eyebrow,
}: AccountPageShellProps) {
  return (
    <OperationsSurface page={family}>
      <Header
        eyebrow={eyebrow ?? (family === "help" ? "Help" : "Account")}
        title={title}
        description={description}
      >
        {badge && <Badge variant="accent">{badge}</Badge>}
        {actions}
      </Header>
      <HorizonPage width="medium">
        <div className={styles.stack}>{children}</div>
      </HorizonPage>
    </OperationsSurface>
  );
}

export function AccountSection({
  title,
  description,
  children,
  className = "",
  tone,
}: AccountSectionProps) {
  return (
    <HorizonPanel
      title={title}
      description={description}
      className={[tone === "danger" ? styles.danger : "", className].filter(Boolean).join(" ")}
    >
      {children}
    </HorizonPanel>
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
    <Link href={href} prefetch={crmLinkPrefetch(href)} className={styles.tile}>
      <ToneChip>
        <Icon aria-hidden="true" />
      </ToneChip>
      <span className="block min-w-0">
        <span className={styles.tileTitle}>{title}</span>
        <span className={styles.tileText}>{description}</span>
      </span>
      {badge ? (
        <Badge>{badge}</Badge>
      ) : (
        <ArrowRight aria-hidden="true" className={`h-4 w-4 ${styles.tileArrow}`} />
      )}
    </Link>
  );
}

export function AccountInfoRow({ label, value, detail }: AccountInfoRowProps) {
  return (
    <div className={styles.row}>
      <div>
        <p className={styles.rowLabel}>{label}</p>
        {detail && <p className={styles.rowDetail}>{detail}</p>}
      </div>
      <div className={styles.rowValue}>{value}</div>
    </div>
  );
}

export function AccountNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.notice}>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
