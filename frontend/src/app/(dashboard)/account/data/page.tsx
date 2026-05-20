"use client";

import Link from "next/link";
import { Database, Download, FileText, ShieldCheck, Trash2 } from "lucide-react";
import {
  AccountInfoRow,
  AccountNotice,
  AccountPageShell,
  AccountSection,
} from "@/components/account-page-shell";
import { Button } from "@/components/ui/button";
import { useStudioStore } from "@/lib/store";

export default function AccountDataPage() {
  const { currentRole } = useStudioStore();
  const isAdmin = currentRole === "admin";

  return (
    <AccountPageShell
      title="Data and export"
      description="Understand where to export data, what account data exists, and which destructive tools require care."
    >
      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <AccountSection title="Studio exports">
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-text-secondary">
              Operational exports live in Reports because they are studio-level records, not just personal account
              records. Use Reports for student, billing, attendance, staff, and audit CSVs.
            </p>
            <Button asChild variant="secondary" size="sm">
              <Link href="/reports">
                <Download className="h-3.5 w-3.5" />
                Open reports
              </Link>
            </Button>
          </div>
        </AccountSection>

        <AccountSection title="Account data">
          <AccountInfoRow label="Profile metadata" value="Name and email" />
          <AccountInfoRow label="Preferences" value="Stored in browser" />
          <AccountInfoRow label="Studio role" value={currentRole || "member"} />
        </AccountSection>
      </div>

      <AccountSection title="Data controls">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-[6px] border border-border bg-surface-raised p-4">
            <Database className="mb-3 h-4 w-4 text-accent" />
            <p className="text-sm font-medium text-text-primary">Export records</p>
            <p className="mt-1 text-sm text-text-secondary">Use CSV reports for portable studio records.</p>
          </div>
          <div className="rounded-[6px] border border-border bg-surface-raised p-4">
            <ShieldCheck className="mb-3 h-4 w-4 text-accent" />
            <p className="text-sm font-medium text-text-primary">Preserve billing access</p>
            <p className="mt-1 text-sm text-text-secondary">Platform access rows are preserved by demo cleanup tools.</p>
          </div>
          <div className="rounded-[6px] border border-danger/25 bg-danger/5 p-4">
            <Trash2 className="mb-3 h-4 w-4 text-danger" />
            <p className="text-sm font-medium text-danger">Clear studio data</p>
            <p className="mt-1 text-sm text-text-secondary">Only admins should use destructive cleanup from Settings.</p>
          </div>
        </div>
        <div className="mt-4">
          {isAdmin ? (
            <Button asChild variant="danger" size="sm">
              <Link href="/settings">
                <Trash2 className="h-3.5 w-3.5" />
                Open data controls
              </Link>
            </Button>
          ) : (
            <AccountNotice>
              Your role can review exports and privacy information, but only studio admins can clear or replace studio
              data.
            </AccountNotice>
          )}
        </div>
      </AccountSection>

      <AccountSection title="Policies">
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/privacy">
              <ShieldCheck className="h-3.5 w-3.5" />
              Privacy policy
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/terms">
              <FileText className="h-3.5 w-3.5" />
              Terms of Service
            </Link>
          </Button>
        </div>
      </AccountSection>
    </AccountPageShell>
  );
}
