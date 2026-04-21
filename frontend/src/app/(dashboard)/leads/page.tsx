"use client";

import { useState, useMemo } from "react";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import type { Lead, LeadStage, LeadSource } from "@/types";
import {
  UserPlus,
  Phone,
  Mail,
  Calendar,
  X,
  GripVertical,
  Globe,
  Users,
  Search,
  Megaphone,
  MapPin,
  ExternalLink,
} from "lucide-react";

const PIPELINE_STAGES: { id: LeadStage; label: string; color: string }[] = [
  { id: "inquiry", label: "Inquiry", color: "border-t-accent" },
  { id: "trial_scheduled", label: "Trial Scheduled", color: "border-t-warning" },
  { id: "trial_completed", label: "Trial Completed", color: "border-t-[#1E90FF]" },
  { id: "offer_sent", label: "Offer Sent", color: "border-t-[#8B5CF6]" },
  { id: "enrolled", label: "Enrolled", color: "border-t-success" },
];

const SOURCE_ICONS: Record<LeadSource, React.ReactNode> = {
  walk_in: <MapPin className="w-3 h-3" />,
  referral: <Users className="w-3 h-3" />,
  social: <Megaphone className="w-3 h-3" />,
  search: <Search className="w-3 h-3" />,
  website: <Globe className="w-3 h-3" />,
  other: <ExternalLink className="w-3 h-3" />,
};

const SOURCE_LABELS: Record<LeadSource, string> = {
  walk_in: "Walk-in",
  referral: "Referral",
  social: "Social",
  search: "Search",
  website: "Website",
  other: "Other",
};

function formatDate(d?: string) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

export default function LeadsPage() {
  const store = useStore();
  const leads = store.leads;
  const [showAddLead, setShowAddLead] = useState(false);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [showLost, setShowLost] = useState(false);
  const [draggedLead, setDraggedLead] = useState<string | null>(null);

  // Group leads by stage
  const leadsByStage = useMemo(() => {
    const map: Record<string, Lead[]> = {};
    PIPELINE_STAGES.forEach((s) => (map[s.id] = []));
    leads
      .filter((l) => l.stage !== "closed_lost")
      .forEach((l) => {
        if (map[l.stage]) map[l.stage].push(l);
      });
    return map;
  }, [leads]);

  const lostLeads = leads.filter((l) => l.stage === "closed_lost");

  function handleDragStart(leadId: string) {
    setDraggedLead(leadId);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function handleDrop(stage: LeadStage) {
    if (!draggedLead) return;
    store.updateLead(draggedLead, { stage });
    setDraggedLead(null);
  }

  function handleAddLead(data: Partial<Lead>) {
    store.addLead(data);
    setShowAddLead(false);
  }

  // Pipeline counts  
  const totalActive = leads.filter((l) => l.stage !== "closed_lost").length;
  const enrolledCount = leads.filter((l) => l.stage === "enrolled").length;

  return (
    <>
      <Header
        title="Leads"
        description={`${totalActive} active · ${enrolledCount} enrolled · ${lostLeads.length} lost`}
      >
        <Button
          variant={showLost ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setShowLost(!showLost)}
        >
          Lost ({lostLeads.length})
        </Button>
        <Button variant="primary" size="sm" onClick={() => setShowAddLead(true)}>
          <UserPlus className="w-3.5 h-3.5" />
          Add lead
        </Button>
      </Header>

      <div className="flex-1 flex flex-col">
        {/* Kanban board */}
        <div className="flex-1 overflow-x-auto p-6">
          <div className="flex gap-4 min-w-max h-full">
            {PIPELINE_STAGES.map((stage) => {
              const stageLeads = leadsByStage[stage.id] || [];
              return (
                <div
                  key={stage.id}
                  className="w-72 flex flex-col"
                  onDragOver={handleDragOver}
                  onDrop={() => handleDrop(stage.id)}
                >
                  {/* Column header */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                        {stage.label}
                      </h3>
                      <span className="text-xs text-muted font-mono bg-surface-raised px-1.5 py-0.5 rounded-[4px]">
                        {stageLeads.length}
                      </span>
                    </div>
                  </div>

                  {/* Cards */}
                  <div className={`flex-1 space-y-2 p-2 rounded-[6px] border-t-2 ${stage.color} bg-surface/50 min-h-[200px]`}>
                    {stageLeads.map((lead) => (
                      <div
                        key={lead.id}
                        draggable
                        onDragStart={() => handleDragStart(lead.id)}
                        onClick={() => setSelectedLead(lead)}
                        className={`bg-surface border border-border rounded-[6px] p-3 cursor-pointer hover:border-accent/30 transition-colors ${
                          draggedLead === lead.id ? "opacity-50" : ""
                        }`}
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <p className="text-sm font-medium text-text-primary">
                              {lead.first_name} {lead.last_name}
                            </p>
                            {lead.program_interest && (
                              <p className="text-xs text-muted mt-0.5">{lead.program_interest}</p>
                            )}
                          </div>
                          <GripVertical className="w-3.5 h-3.5 text-border flex-shrink-0 cursor-grab" />
                        </div>

                        {/* Source badge */}
                        <div className="flex items-center gap-2 mb-2">
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-surface-raised border border-border rounded-[4px] text-text-secondary">
                            {SOURCE_ICONS[lead.source]}
                            {SOURCE_LABELS[lead.source]}
                          </span>
                          {lead.is_minor && (
                            <span className="text-[10px] text-warning">Minor</span>
                          )}
                        </div>

                        {/* Meta */}
                        <div className="flex items-center gap-3 text-[10px] text-muted">
                          {lead.follow_up_date && (
                            <span className="flex items-center gap-0.5">
                              <Calendar className="w-2.5 h-2.5" />
                              {formatDate(lead.follow_up_date)}
                            </span>
                          )}
                          <span>{timeAgo(lead.created_at)}</span>
                        </div>
                      </div>
                    ))}

                    {stageLeads.length === 0 && (
                      <div className="text-center py-8">
                        <p className="text-xs text-muted">No leads</p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Lost leads drawer */}
        {showLost && lostLeads.length > 0 && (
          <div className="border-t border-border px-8 py-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                Closed Lost
              </h3>
              <button onClick={() => setShowLost(false)} className="text-muted hover:text-text-primary cursor-pointer">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2">
              {lostLeads.map((lead) => (
                <div
                  key={lead.id}
                  onClick={() => setSelectedLead(lead)}
                  className="flex-shrink-0 w-56 bg-surface border border-border rounded-[6px] p-3 opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <p className="text-sm text-text-primary font-medium">
                    {lead.first_name} {lead.last_name}
                  </p>
                  <p className="text-xs text-danger mt-1 capitalize">
                    {lead.lost_reason?.replace(/_/g, " ") || "Unknown"}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Lead detail panel */}
      {selectedLead && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSelectedLead(null)} />
          <div className="relative bg-bg border border-border rounded-[6px] w-full max-w-md max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="text-base font-semibold text-text-primary">
                {selectedLead.first_name} {selectedLead.last_name}
              </h2>
              <button onClick={() => setSelectedLead(null)} className="text-muted hover:text-text-primary cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {/* Stage */}
              <div>
                <p className="text-xs text-muted mb-1.5">Stage</p>
                <select
                  value={selectedLead.stage}
                  onChange={(e) => {
                    const newStage = e.target.value as LeadStage;
                    store.updateLead(selectedLead.id, { stage: newStage });
                    setSelectedLead({ ...selectedLead, stage: newStage });
                  }}
                  className="w-full px-3 py-1.5 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
                >
                  {[...PIPELINE_STAGES, { id: "closed_lost" as LeadStage, label: "Closed Lost" }].map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>

              {/* Contact */}
              <div className="space-y-2">
                <p className="text-xs text-muted">Contact</p>
                {selectedLead.email && (
                  <div className="flex items-center gap-2 text-sm text-text-secondary">
                    <Mail className="w-3.5 h-3.5 text-muted" />
                    <span className="font-mono">{selectedLead.email}</span>
                  </div>
                )}
                {selectedLead.phone && (
                  <div className="flex items-center gap-2 text-sm text-text-secondary">
                    <Phone className="w-3.5 h-3.5 text-muted" />
                    <span className="font-mono">{selectedLead.phone}</span>
                  </div>
                )}
              </div>

              {/* Source & Program */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted mb-1">Source</p>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-surface-raised border border-border rounded-[4px] text-text-secondary">
                    {SOURCE_ICONS[selectedLead.source]}
                    {SOURCE_LABELS[selectedLead.source]}
                  </span>
                </div>
                {selectedLead.program_interest && (
                  <div>
                    <p className="text-xs text-muted mb-1">Program interest</p>
                    <p className="text-sm text-text-primary">{selectedLead.program_interest}</p>
                  </div>
                )}
              </div>

              {/* Guardian (minors) */}
              {selectedLead.is_minor && selectedLead.guardian_name && (
                <div className="bg-surface border border-border rounded-[6px] p-3">
                  <p className="text-xs text-muted mb-2">Guardian</p>
                  <p className="text-sm text-text-primary">{selectedLead.guardian_name}</p>
                  {selectedLead.guardian_email && (
                    <p className="text-xs text-text-secondary font-mono mt-1">{selectedLead.guardian_email}</p>
                  )}
                  {selectedLead.guardian_phone && (
                    <p className="text-xs text-text-secondary font-mono mt-0.5">{selectedLead.guardian_phone}</p>
                  )}
                </div>
              )}

              {/* Follow-up */}
              {selectedLead.follow_up_date && (
                <div>
                  <p className="text-xs text-muted mb-1">Follow-up date</p>
                  <p className="text-sm text-text-primary font-mono">{formatDate(selectedLead.follow_up_date)}</p>
                </div>
              )}

              {/* Notes */}
              {selectedLead.notes && (
                <div>
                  <p className="text-xs text-muted mb-1">Notes</p>
                  <p className="text-sm text-text-secondary leading-relaxed">{selectedLead.notes}</p>
                </div>
              )}

              {/* Lost reason */}
              {selectedLead.stage === "closed_lost" && selectedLead.lost_reason && (
                <div className="bg-danger/5 border border-danger/20 rounded-[6px] p-3">
                  <p className="text-xs text-danger mb-1">Lost reason</p>
                  <p className="text-sm text-text-primary capitalize">{selectedLead.lost_reason.replace(/_/g, " ")}</p>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-2 border-t border-border">
                {selectedLead.stage !== "enrolled" && selectedLead.stage !== "closed_lost" && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      store.updateLead(selectedLead.id, { stage: "enrolled" as LeadStage });
                      setSelectedLead(null);
                    }}
                  >
                    Convert to student
                  </Button>
                )}
                {selectedLead.stage !== "closed_lost" && selectedLead.stage !== "enrolled" && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      store.updateLead(selectedLead.id, { stage: "closed_lost" as LeadStage, lost_reason: "other" });
                      setSelectedLead(null);
                    }}
                  >
                    Mark lost
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add lead modal */}
      {showAddLead && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowAddLead(false)} />
          <div className="relative bg-bg border border-border rounded-[6px] w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-base font-semibold text-text-primary">Add new lead</h2>
              <button onClick={() => setShowAddLead(false)} className="text-muted hover:text-text-primary cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                handleAddLead({
                  first_name: fd.get("first_name") as string,
                  last_name: fd.get("last_name") as string,
                  email: fd.get("email") as string || undefined,
                  phone: fd.get("phone") as string || undefined,
                  source: fd.get("source") as LeadSource,
                  program_interest: fd.get("program_interest") as string || undefined,
                  notes: fd.get("notes") as string || undefined,
                });
              }}
              className="space-y-4"
            >
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary font-medium">First name *</label>
                  <input
                    name="first_name"
                    required
                    className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary font-medium">Last name *</label>
                  <input
                    name="last_name"
                    required
                    className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-text-secondary font-medium">Email</label>
                <input
                  name="email"
                  type="email"
                  className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary font-medium">Phone</label>
                  <input
                    name="phone"
                    type="tel"
                    className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary font-medium">Source</label>
                  <select
                    name="source"
                    defaultValue="walk_in"
                    className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
                  >
                    {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-text-secondary font-medium">Program interest</label>
                <input
                  name="program_interest"
                  placeholder="e.g. Adult BJJ, Kids Martial Arts"
                  className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-text-secondary font-medium">Notes</label>
                <textarea
                  name="notes"
                  rows={2}
                  className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none resize-none"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" size="sm" type="button" onClick={() => setShowAddLead(false)}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" type="submit">
                  Add lead
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
