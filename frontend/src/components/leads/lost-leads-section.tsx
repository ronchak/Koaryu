"use client";

import { fullName } from "@/lib/leads-page-model";
import type { Lead } from "@/types";
import { X } from "lucide-react";
import styles from "./leads-ledger.module.css";

interface LostLeadsSectionProps {
  lostLeads: Lead[];
  onClose: () => void;
  onSelectLead: (leadId: string) => void;
}

export function LostLeadsSection({ lostLeads, onClose, onSelectLead }: LostLeadsSectionProps) {
  if (lostLeads.length === 0) {
    return null;
  }

  return (
    <section className={styles.lostPanel} aria-labelledby="lost-leads-title">
      <div className={styles.lostHead}>
        <h2 id="lost-leads-title">Closed Lost · {lostLeads.length}</h2>
        <button type="button" aria-label="Hide closed lost leads" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      <div className={styles.lostGrid}>
        {lostLeads.map((lead) => (
          <button
            type="button"
            key={lead.id}
            aria-label={`${fullName(lead)} lost lead card`}
            onClick={() => onSelectLead(lead.id)}
            className={styles.lostCard}
          >
            <strong>{fullName(lead)}</strong>
            <span>{lead.lost_reason?.replace(/_/g, " ") || "Unknown"}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
