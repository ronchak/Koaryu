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
import {
  AccountInfoRow,
  AccountLinkTile,
  AccountPageShell,
  AccountSection,
} from "@/components/account-page-shell";
import { useStudioStore } from "@/lib/store";

function roleLabel(role?: string | null) {
  if (role === "admin") return "Admin";
  if (role === "instructor") return "Instructor";
  if (role === "front_desk") return "Front desk";
  return "Member";
}

export default function AccountPage() {
  const { currentRole, studioName, userEmail, userName } = useStudioStore();

  return (
    <AccountPageShell
      title="My account"
      description="Manage your Koaryu identity, preferences, subscription, and support options."
      badge={roleLabel(currentRole)}
    >
      <AccountSection title="Account summary">
        <AccountInfoRow label="Name" value={userName || "Not set"} />
        <AccountInfoRow label="Email" value={userEmail || "Not available"} />
        <AccountInfoRow label="Studio" value={studioName || "Not selected"} />
        <AccountInfoRow
          label="Role"
          value={roleLabel(currentRole)}
          detail="Your role controls access to staff, billing, and data tools."
        />
      </AccountSection>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AccountLinkTile
          href="/account/profile"
          icon={UserCircle}
          title="Profile"
          description="Update your display name and review the email used for login."
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
