"use client";

import { fullName } from "@/lib/leads-page-model";
import type { Lead } from "@/types";
import { X } from "lucide-react";

interface LostLeadsSectionProps {
  lostLeads: Lead[];
  onClose: () => void;
  onSelectLead: (leadId: string) => void;
}

export function LostLeadsSection({
  lostLeads,
  onClose,
  onSelectLead,
}: LostLeadsSectionProps) {
  if (lostLeads.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-border px-4 py-4 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
          Closed Lost
        </h3>
        <button
          type="button"
          aria-label="Hide closed lost leads"
          onClick={onClose}
          className="text-muted hover:text-text-primary cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {lostLeads.map((lead) => (
          <button
            type="button"
            key={lead.id}
            aria-label={`${fullName(lead)} lost lead card`}
            onClick={() => onSelectLead(lead.id)}
            className="min-w-0 border border-border bg-surface p-3 text-left opacity-60 transition-opacity cursor-pointer hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background"
          >
            <p className="break-words text-sm font-medium text-text-primary">
              {fullName(lead)}
            </p>
            <p className="text-xs text-danger mt-1 capitalize">
              {lead.lost_reason?.replace(/_/g, " ") || "Unknown"}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
