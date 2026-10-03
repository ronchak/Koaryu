"use client";

import { PanelHeader } from "@/components/dashboard/dashboard-page-sections";

export function DashboardLoadingPanel() {
  return (
    <div className="overflow-hidden rounded-[14px] bg-surface p-4 shadow-[var(--product-shadow-card)] sm:p-5">
      <PanelHeader
        title="Loading Dashboard"
        subtitle="Preparing the first roster, lead, program, and belt snapshot."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {["Students", "Leads", "Classes", "Belts"].map((label) => (
          <div key={label} className="rounded-[10px] bg-surface-raised px-4 py-4">
            <div className="h-3 w-20 rounded-[6px] bg-border" />
            <div className="mt-4 h-8 w-14 rounded-[6px] bg-border" />
            <div className="mt-3 h-3 w-28 max-w-full rounded-[6px] bg-border" />
          </div>
        ))}
      </div>
    </div>
  );
}
