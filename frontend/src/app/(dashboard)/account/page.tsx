"use client";

import {
  Bell,
  CreditCard,
  Database,
  HelpCircle,
  Palette,
  Settings,
  ShieldCheck,
  UserCircle,
} from "lucide-react";
import { AccountLinkTile, AccountPageShell } from "@/components/account-page-shell";
import { HorizonPanel, ToneTag } from "@/components/settings/horizon-parts";
import { useStudioStore } from "@/lib/store";
import { formatRoleLabel } from "@/lib/role-label";
import styles from "@/components/account/account.module.css";

export default function AccountPage() {
  const { currentRole, studioName, userEmail, userName } = useStudioStore();
  const initial = (userName || userEmail || "?").trim().charAt(0).toUpperCase() || "?";

  return (
    <AccountPageShell
      title="My account"
      description="Manage your Koaryu identity, preferences, subscription, and support options."
    >
      <HorizonPanel title="Account summary" titleId="account-summary-title">
        <div className={styles.identity}>
          <span className={styles.avatar} aria-hidden="true">
            {initial}
          </span>
          <div className={styles.identityText}>
            <p className={styles.identityName}>{userName || "Name not set"}</p>
            <p className={styles.identityMeta}>{userEmail || "Email not available"}</p>
            <p className={styles.identityMeta}>
              {studioName || "No studio selected"}
              {" · "}
              <ToneTag dot={false}>{formatRoleLabel(currentRole)}</ToneTag>
            </p>
          </div>
        </div>
        <p className="mt-4 text-sm text-text-secondary">
          Your role controls access to staff, billing, and data tools.
        </p>
      </HorizonPanel>

      <h2 className={styles.groupTitle}>You</h2>
      <div className={styles.tileGrid}>
        <AccountLinkTile
          href="/account/profile"
          icon={UserCircle}
          title="Profile"
          description="Change your display name and review the email used for login."
        />
        <AccountLinkTile
          href="/account/settings"
          icon={Settings}
          title="Account settings"
          description="Review account security, sessions, and links to studio-level settings."
        />
        <AccountLinkTile
          href="/account/personalization"
          icon={Palette}
          title="Personalization"
          description="Choose theme now and preview planned language and density controls."
        />
        <AccountLinkTile
          href="/account/notifications"
          icon={Bell}
          title="Notifications"
          description="Review planned operational, billing, staff, and security notification categories."
        />
      </div>

      <h2 className={styles.groupTitle}>Studio, data and support</h2>
      <div className={styles.tileGrid}>
        <AccountLinkTile
          href="/account/data"
          icon={Database}
          title="Data and export"
          description="Find export options and data-handling guidance for your account."
        />
        <AccountLinkTile
          href="/billing"
          icon={CreditCard}
          title="Plan and billing"
          description="Manage Koaryu Core and student billing readiness from the billing workspace."
        />
        <AccountLinkTile
          href="/help"
          icon={HelpCircle}
          title="Help center"
          description="Get workflow guidance, release notes, shortcuts, and support contacts."
        />
        <AccountLinkTile
          href="/privacy"
          icon={ShieldCheck}
          title="Privacy"
          description="Review how Koaryu handles studio, student, and payment data."
        />
      </div>
    </AccountPageShell>
  );
}
