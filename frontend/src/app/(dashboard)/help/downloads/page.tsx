"use client";

import { AppWindow, MonitorDown, Smartphone } from "lucide-react";
import { AccountNotice, AccountPageShell, AccountSection } from "@/components/account-page-shell";

export default function DownloadsPage() {
  return (
    <AccountPageShell
      title="Download apps"
      description="Install Koaryu from the browser for faster access on front-desk and instructor devices."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <AccountSection title="Desktop">
          <div className="space-y-3 text-sm text-text-secondary">
            <MonitorDown className="h-5 w-5 text-accent" />
            <p>Open Koaryu in Chrome, Edge, or Safari and use the browser install option when available.</p>
            <p>Chrome and Edge usually show an install icon in the address bar or under the browser menu.</p>
          </div>
        </AccountSection>
        <AccountSection title="Phone or tablet">
          <div className="space-y-3 text-sm text-text-secondary">
            <Smartphone className="h-5 w-5 text-accent" />
            <p>On iPhone or iPad, open Koaryu in Safari, tap Share, then choose Add to Home Screen.</p>
            <p>On Android, open Koaryu in Chrome and use Install app or Add to Home screen.</p>
          </div>
        </AccountSection>
      </div>

      <AccountSection title="Native app status">
        <div className="flex gap-3">
          <AppWindow className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent" />
          <p className="text-sm leading-relaxed text-text-secondary">
            Koaryu is currently a responsive web app. There are no separate App Store or Play Store downloads yet.
          </p>
        </div>
        <div className="mt-4">
          <AccountNotice>
            For dojo demos, pin Koaryu to the device home screen and open it once before the meeting so the session,
            assets, and backend warmup are ready.
          </AccountNotice>
        </div>
      </AccountSection>
    </AccountPageShell>
  );
}
