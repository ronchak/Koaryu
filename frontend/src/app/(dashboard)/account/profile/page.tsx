"use client";

import {
  AccountInfoRow,
  AccountNotice,
  AccountPageShell,
  AccountSection,
} from "@/components/account-page-shell";
import { AccountNameSection } from "@/components/account/account-name-section";
import { useStudioStore } from "@/lib/store";

export default function ProfilePage() {
  const { currentRole, studioName } = useStudioStore();

  return (
    <AccountPageShell
      title="Profile"
      description="Your personal Koaryu identity for staff records, exports, and audit history."
    >
      <AccountNameSection
        title="Personal details"
        description="Your name is stored on your login account. Your email comes from Supabase Auth."
      />

      <AccountSection title="Workspace context">
        <AccountInfoRow label="Studio" value={studioName || "Not selected"} />
        <AccountInfoRow label="Role" value={currentRole || "member"} />
        <div className="pt-4">
          <AccountNotice>
            Email changes are intentionally handled through the authentication provider so login and verification stay
            consistent. Name changes update your Koaryu staff identity immediately.
          </AccountNotice>
        </div>
      </AccountSection>
    </AccountPageShell>
  );
}
