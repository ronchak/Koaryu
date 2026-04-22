"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { Lead, LeadSource, LeadStage } from "@/types";
import {
  Calendar,
  ExternalLink,
  Globe,
  GripVertical,
  Mail,
  MapPin,
  Megaphone,
  Phone,
  Search,
  Users,
  UserPlus,
  X,
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

function formatDate(value?: string | null, withYear = false) {
  if (!value) return "";

  return new Date(`${value}T00:00:00`).toLocaleDateString(
    "en-US",
    withYear
      ? { month: "short", day: "numeric", year: "numeric" }
      : { month: "short", day: "numeric" }
  );
}

function timeAgo(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

function todayDateString() {
  return new Date().toISOString().split("T")[0];
}

function fullName(lead: Pick<Lead, "first_name" | "last_name">) {
  return `${lead.first_name} ${lead.last_name}`;
}

function getNextStage(stage: LeadStage): LeadStage | null {
  const currentIndex = PIPELINE_STAGES.findIndex((candidate) => candidate.id === stage);
  if (currentIndex === -1 || currentIndex === PIPELINE_STAGES.length - 1) {
    return null;
  }

  return PIPELINE_STAGES[currentIndex + 1].id;
}

function getStageLabel(stage: LeadStage) {
  return PIPELINE_STAGES.find((candidate) => candidate.id === stage)?.label ?? stage;
}

function getFollowUpStatusLabel(date: string, today: string) {
  if (date === today) {
    return "Due today";
  }

  const diffMs =
    new Date(`${today}T00:00:00`).getTime() -
    new Date(`${date}T00:00:00`).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays > 0) {
    return `${diffDays}d overdue`;
  }

  return `Due ${formatDate(date)}`;
}

export default function LeadsPage() {
  const store = useStore();
  const router = useRouter();
  const leads = store.leads;
  const today = todayDateString();

  const [showAddLead, setShowAddLead] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [showLost, setShowLost] = useState(false);
  const [draggedLead, setDraggedLead] = useState<string | null>(null);
  const [isAddingLead, setIsAddingLead] = useState(false);
  const [addLeadError, setAddLeadError] = useState<string | null>(null);
  const [pendingLeadId, setPendingLeadId] = useState<string | null>(null);
  const [leadActionError, setLeadActionError] = useState<string | null>(null);
  const [followUpDrafts, setFollowUpDrafts] = useState<Record<string, string>>({});

  const selectedLead = useMemo(
    () => leads.find((lead) => lead.id === selectedLeadId) ?? null,
    [leads, selectedLeadId]
  );

  const leadsByStage = useMemo(() => {
    const map: Record<string, Lead[]> = {};
    PIPELINE_STAGES.forEach((stage) => {
      map[stage.id] = [];
    });

    leads
      .filter((lead) => lead.stage !== "closed_lost")
      .forEach((lead) => {
        if (map[lead.stage]) {
          map[lead.stage].push(lead);
        }
      });

    return map;
  }, [leads]);

  const lostLeads = useMemo(
    () => leads.filter((lead) => lead.stage === "closed_lost"),
    [leads]
  );

  const followUpQueue = useMemo(
    () =>
      leads
        .filter(
          (lead) =>
            lead.stage !== "closed_lost" &&
            lead.stage !== "enrolled" &&
            !!lead.follow_up_date &&
            lead.follow_up_date <= today
        )
        .sort((a, b) => (a.follow_up_date ?? "").localeCompare(b.follow_up_date ?? "")),
    [leads, today]
  );

  const dueTodayCount = useMemo(
    () => followUpQueue.filter((lead) => lead.follow_up_date === today).length,
    [followUpQueue, today]
  );

  const overdueCount = followUpQueue.length - dueTodayCount;
  const upcomingFollowUps = useMemo(
    () =>
      leads.filter(
        (lead) =>
          lead.stage !== "closed_lost" &&
          lead.stage !== "enrolled" &&
          !!lead.follow_up_date &&
          lead.follow_up_date > today
      ).length,
    [leads, today]
  );

  function getFollowUpInputValue(lead: Lead) {
    return followUpDrafts[lead.id] ?? lead.follow_up_date ?? today;
  }

  function setFollowUpInputValue(leadId: string, value: string) {
    setFollowUpDrafts((current) => ({ ...current, [leadId]: value }));
  }

  function clearSelectedLead() {
    if (!pendingLeadId) {
      setSelectedLeadId(null);
    }
  }

  async function handleConvertLead(lead: Lead) {
    setLeadActionError(null);
    setPendingLeadId(lead.id);

    try {
      const { studentId } = await store.convertLeadToStudent(lead.id);
      setSelectedLeadId(null);

      if (studentId) {
        router.push(`/students/${studentId}`);
      }
    } catch (error) {
      console.error("Failed to convert lead", error);
      setLeadActionError(
        error instanceof Error
          ? error.message
          : "Could not convert this lead into a student."
      );
    } finally {
      setPendingLeadId(null);
      setDraggedLead(null);
    }
  }

  async function handleAddLead(data: Partial<Lead>) {
    setAddLeadError(null);
    setIsAddingLead(true);

    try {
      await store.addLead(data);
      setShowAddLead(false);
    } catch (error) {
      console.error("Failed to add lead", error);
      setAddLeadError("Could not add this lead. Please try again.");
    } finally {
      setIsAddingLead(false);
    }
  }

  async function handleLeadUpdate(
    lead: Lead,
    updates: Partial<Lead>,
    options?: { closeAfterSuccess?: boolean }
  ) {
    setLeadActionError(null);
    setPendingLeadId(lead.id);

    try {
      await store.updateLead(lead.id, updates);
      if (options?.closeAfterSuccess) {
        setSelectedLeadId(null);
      }
    } catch (error) {
      console.error("Failed to update lead", error);
      setLeadActionError(
        error instanceof Error
          ? error.message
          : "Could not save lead changes. Please try again."
      );
    } finally {
      setPendingLeadId(null);
    }
  }

  async function handleStageSelection(lead: Lead, nextStage: LeadStage) {
    if (nextStage === "enrolled") {
      await handleConvertLead(lead);
      return;
    }

    await handleLeadUpdate(lead, {
      stage: nextStage,
      lost_reason: nextStage === "closed_lost" ? lead.lost_reason ?? "other" : lead.lost_reason,
    });
  }

  async function handleDrop(stage: LeadStage) {
    if (!draggedLead) return;

    const lead = leads.find((candidate) => candidate.id === draggedLead);
    if (!lead || lead.stage === stage) {
      setDraggedLead(null);
      return;
    }

    if (stage === "enrolled") {
      await handleConvertLead(lead);
      return;
    }

    await handleLeadUpdate(lead, { stage });
    setDraggedLead(null);
  }

  async function logFollowUpActivity(leadId: string, description: string) {
    if (store.isPreviewMode || !store.token) {
      return;
    }

    await api.post(
      `/leads/${leadId}/activities`,
      {
        activity_type: "follow_up",
        description,
      },
      store.token
    );
  }

  async function handleRescheduleLead(lead: Lead) {
    const nextDate = getFollowUpInputValue(lead);
    if (!nextDate) {
      setLeadActionError("Choose a follow-up date before rescheduling.");
      return;
    }

    await handleLeadUpdate(lead, { follow_up_date: nextDate });
  }

  async function handleMarkContacted(lead: Lead, advanceStage: boolean) {
    setLeadActionError(null);
    setPendingLeadId(lead.id);

    try {
      const nextStage = advanceStage ? getNextStage(lead.stage) : null;

      await logFollowUpActivity(
        lead.id,
        advanceStage && nextStage
          ? `Lead contacted and moved to ${getStageLabel(nextStage)}.`
          : "Lead contacted."
      );

      if (advanceStage && nextStage === "enrolled") {
        const { studentId } = await store.convertLeadToStudent(lead.id);
        setSelectedLeadId(null);
        if (studentId) {
          router.push(`/students/${studentId}`);
        }
        return;
      }

      await store.updateLead(lead.id, {
        stage: nextStage ?? lead.stage,
        follow_up_date: null,
      });

      if (selectedLeadId === lead.id && !advanceStage) {
        setSelectedLeadId(lead.id);
      }
    } catch (error) {
      console.error("Failed to update follow-up", error);
      setLeadActionError(
        error instanceof Error
          ? error.message
          : "Could not complete that follow-up action."
      );
    } finally {
      setPendingLeadId(null);
    }
  }

  const totalActive = leads.filter((lead) => lead.stage !== "closed_lost").length;
  const enrolledCount = leads.filter((lead) => lead.stage === "enrolled").length;

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
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setAddLeadError(null);
            setShowAddLead(true);
          }}
        >
          <UserPlus className="w-3.5 h-3.5" />
          Add lead
        </Button>
      </Header>

      {leadActionError && !selectedLead && (
        <div className="px-8 pt-4">
          <div className="rounded-[6px] border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
            {leadActionError}
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col">
        <div className="px-8 pt-6">
          <div className="rounded-[6px] border border-border bg-surface p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h3 className="text-sm font-medium text-text-primary">Follow-Up Today</h3>
                <p className="text-sm text-text-secondary mt-1">
                  Keep due leads moving with one-click contact, reschedule, and stage actions.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded-[4px] border border-warning/20 bg-warning/10 px-2 py-1 text-warning">
                  {dueTodayCount} due today
                </span>
                <span className="rounded-[4px] border border-danger/20 bg-danger/10 px-2 py-1 text-danger">
                  {overdueCount} overdue
                </span>
                <span className="rounded-[4px] border border-border bg-surface-raised px-2 py-1 text-text-secondary">
                  {upcomingFollowUps} upcoming
                </span>
              </div>
            </div>

            {followUpQueue.length === 0 ? (
              <div className="mt-4 rounded-[6px] border border-border bg-surface-raised/60 px-4 py-5 text-sm text-text-secondary">
                No leads are due for follow-up today. Upcoming follow-ups will continue to show on each lead card.
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {followUpQueue.map((lead) => {
                  const nextStage = getNextStage(lead.stage);
                  const isPending = pendingLeadId === lead.id;

                  return (
                    <div
                      key={lead.id}
                      className="rounded-[6px] border border-border bg-surface-raised/60 p-4"
                    >
                      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                        <div className="min-w-0">
                          <button
                            onClick={() => {
                              setLeadActionError(null);
                              setSelectedLeadId(lead.id);
                            }}
                            className="text-left cursor-pointer"
                          >
                            <p className="text-sm font-medium text-text-primary">
                              {fullName(lead)}
                            </p>
                            {lead.program_interest && (
                              <p className="text-xs text-muted mt-1">{lead.program_interest}</p>
                            )}
                          </button>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
                            <span className="rounded-[4px] border border-border bg-surface px-2 py-0.5">
                              {getStageLabel(lead.stage)}
                            </span>
                            <span className="inline-flex items-center gap-1 rounded-[4px] border border-border bg-surface px-2 py-0.5">
                              {SOURCE_ICONS[lead.source]}
                              {SOURCE_LABELS[lead.source]}
                            </span>
                            {lead.follow_up_date && (
                              <span
                                className={`rounded-[4px] px-2 py-0.5 ${
                                  lead.follow_up_date < today
                                    ? "bg-danger/10 text-danger"
                                    : "bg-warning/10 text-warning"
                                }`}
                              >
                                {getFollowUpStatusLabel(lead.follow_up_date, today)}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-end gap-2">
                          <div>
                            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                              Next follow-up
                            </label>
                            <input
                              type="date"
                              value={getFollowUpInputValue(lead)}
                              disabled={isPending}
                              onChange={(event) =>
                                setFollowUpInputValue(lead.id, event.target.value)
                              }
                              className="rounded-[6px] border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                            />
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={isPending}
                            onClick={() => {
                              void handleRescheduleLead(lead);
                            }}
                          >
                            Reschedule
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isPending}
                            onClick={() => {
                              void handleMarkContacted(lead, false);
                            }}
                          >
                            Mark contacted
                          </Button>
                          {nextStage && (
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={isPending}
                              onClick={() => {
                                void handleMarkContacted(lead, true);
                              }}
                            >
                              {nextStage === "enrolled"
                                ? "Convert now"
                                : `Move to ${getStageLabel(nextStage)}`}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-x-auto p-6">
          <div className="flex gap-4 min-w-max h-full">
            {PIPELINE_STAGES.map((stage) => {
              const stageLeads = leadsByStage[stage.id] || [];

              return (
                <div
                  key={stage.id}
                  className="w-72 flex flex-col"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    void handleDrop(stage.id);
                  }}
                >
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

                  <div
                    className={`flex-1 space-y-2 p-2 rounded-[6px] border-t-2 ${stage.color} bg-surface/50 min-h-[200px]`}
                  >
                    {stageLeads.map((lead) => (
                      <div
                        key={lead.id}
                        draggable
                        onDragStart={() => setDraggedLead(lead.id)}
                        onClick={() => {
                          setLeadActionError(null);
                          setSelectedLeadId(lead.id);
                        }}
                        className={`bg-surface border border-border rounded-[6px] p-3 cursor-pointer hover:border-accent/30 transition-colors ${
                          draggedLead === lead.id || pendingLeadId === lead.id ? "opacity-50" : ""
                        }`}
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <p className="text-sm font-medium text-text-primary">
                              {fullName(lead)}
                            </p>
                            {lead.program_interest && (
                              <p className="text-xs text-muted mt-0.5">
                                {lead.program_interest}
                              </p>
                            )}
                          </div>
                          <GripVertical className="w-3.5 h-3.5 text-border flex-shrink-0 cursor-grab" />
                        </div>

                        <div className="flex items-center gap-2 mb-2">
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-surface-raised border border-border rounded-[4px] text-text-secondary">
                            {SOURCE_ICONS[lead.source]}
                            {SOURCE_LABELS[lead.source]}
                          </span>
                          {lead.is_minor && (
                            <span className="text-[10px] text-warning">Minor</span>
                          )}
                          {lead.follow_up_date && lead.follow_up_date <= today && (
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded-[4px] ${
                                lead.follow_up_date < today
                                  ? "bg-danger/10 text-danger"
                                  : "bg-warning/10 text-warning"
                              }`}
                            >
                              {getFollowUpStatusLabel(lead.follow_up_date, today)}
                            </span>
                          )}
                        </div>

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

        {showLost && lostLeads.length > 0 && (
          <div className="border-t border-border px-8 py-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                Closed Lost
              </h3>
              <button
                onClick={() => setShowLost(false)}
                className="text-muted hover:text-text-primary cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2">
              {lostLeads.map((lead) => (
                <div
                  key={lead.id}
                  onClick={() => {
                    setLeadActionError(null);
                    setSelectedLeadId(lead.id);
                  }}
                  className="flex-shrink-0 w-56 bg-surface border border-border rounded-[6px] p-3 opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <p className="text-sm text-text-primary font-medium">{fullName(lead)}</p>
                  <p className="text-xs text-danger mt-1 capitalize">
                    {lead.lost_reason?.replace(/_/g, " ") || "Unknown"}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {selectedLead && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={clearSelectedLead}
          />
          <div className="relative bg-bg border border-border rounded-[6px] w-full max-w-md max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="text-base font-semibold text-text-primary">
                {fullName(selectedLead)}
              </h2>
              <button
                onClick={clearSelectedLead}
                disabled={pendingLeadId === selectedLead.id}
                className="text-muted hover:text-text-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {leadActionError && (
                <div className="rounded-[6px] border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
                  {leadActionError}
                </div>
              )}

              <div>
                <p className="text-xs text-muted mb-1.5">Stage</p>
                <select
                  value={selectedLead.stage}
                  disabled={pendingLeadId === selectedLead.id}
                  onChange={(event) => {
                    void handleStageSelection(
                      selectedLead,
                      event.target.value as LeadStage
                    );
                  }}
                  className="w-full px-3 py-1.5 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
                >
                  {[...PIPELINE_STAGES, { id: "closed_lost" as LeadStage, label: "Closed Lost" }].map(
                    (stage) => (
                      <option key={stage.id} value={stage.id}>
                        {stage.label}
                      </option>
                    )
                  )}
                </select>
              </div>

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
                    <p className="text-sm text-text-primary">
                      {selectedLead.program_interest}
                    </p>
                  </div>
                )}
              </div>

              {selectedLead.is_minor && selectedLead.guardian_name && (
                <div className="bg-surface border border-border rounded-[6px] p-3">
                  <p className="text-xs text-muted mb-2">Guardian</p>
                  <p className="text-sm text-text-primary">{selectedLead.guardian_name}</p>
                  {selectedLead.guardian_email && (
                    <p className="text-xs text-text-secondary font-mono mt-1">
                      {selectedLead.guardian_email}
                    </p>
                  )}
                  {selectedLead.guardian_phone && (
                    <p className="text-xs text-text-secondary font-mono mt-0.5">
                      {selectedLead.guardian_phone}
                    </p>
                  )}
                </div>
              )}

              <div className="bg-surface border border-border rounded-[6px] p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs text-muted">Follow-up date</p>
                    <p className="text-sm text-text-primary mt-1">
                      {selectedLead.follow_up_date
                        ? formatDate(selectedLead.follow_up_date, true)
                        : "No follow-up scheduled"}
                    </p>
                  </div>
                  {selectedLead.follow_up_date && selectedLead.follow_up_date <= today && (
                    <span
                      className={`rounded-[4px] px-2 py-1 text-xs ${
                        selectedLead.follow_up_date < today
                          ? "bg-danger/10 text-danger"
                          : "bg-warning/10 text-warning"
                      }`}
                    >
                      {getFollowUpStatusLabel(selectedLead.follow_up_date, today)}
                    </span>
                  )}
                </div>

                <div className="flex gap-2">
                  <input
                    type="date"
                    value={getFollowUpInputValue(selectedLead)}
                    disabled={pendingLeadId === selectedLead.id}
                    onChange={(event) =>
                      setFollowUpInputValue(selectedLead.id, event.target.value)
                    }
                    className="flex-1 rounded-[6px] border border-border bg-surface-raised px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={pendingLeadId === selectedLead.id}
                    onClick={() => {
                      void handleRescheduleLead(selectedLead);
                    }}
                  >
                    Reschedule
                  </Button>
                </div>

                {selectedLead.stage !== "closed_lost" && selectedLead.stage !== "enrolled" && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pendingLeadId === selectedLead.id}
                      onClick={() => {
                        void handleMarkContacted(selectedLead, false);
                      }}
                    >
                      Mark contacted
                    </Button>
                    {getNextStage(selectedLead.stage) && (
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={pendingLeadId === selectedLead.id}
                        onClick={() => {
                          void handleMarkContacted(selectedLead, true);
                        }}
                      >
                        {getNextStage(selectedLead.stage) === "enrolled"
                          ? "Convert now"
                          : `Move to ${getStageLabel(getNextStage(selectedLead.stage) as LeadStage)}`}
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {selectedLead.notes && (
                <div>
                  <p className="text-xs text-muted mb-1">Notes</p>
                  <p className="text-sm text-text-secondary leading-relaxed">
                    {selectedLead.notes}
                  </p>
                </div>
              )}

              {selectedLead.stage === "closed_lost" && selectedLead.lost_reason && (
                <div className="bg-danger/5 border border-danger/20 rounded-[6px] p-3">
                  <p className="text-xs text-danger mb-1">Lost reason</p>
                  <p className="text-sm text-text-primary capitalize">
                    {selectedLead.lost_reason.replace(/_/g, " ")}
                  </p>
                </div>
              )}

              <div className="flex gap-2 pt-2 border-t border-border">
                {selectedLead.stage !== "enrolled" && selectedLead.stage !== "closed_lost" && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={pendingLeadId === selectedLead.id}
                    onClick={() => {
                      void handleConvertLead(selectedLead);
                    }}
                  >
                    Convert to student
                  </Button>
                )}
                {selectedLead.stage !== "closed_lost" && selectedLead.stage !== "enrolled" && (
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={pendingLeadId === selectedLead.id}
                    onClick={() => {
                      void handleLeadUpdate(
                        selectedLead,
                        { stage: "closed_lost", lost_reason: "other" },
                        { closeAfterSuccess: true }
                      );
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

      {showAddLead && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => {
              if (!isAddingLead) {
                setShowAddLead(false);
              }
            }}
          />
          <div className="relative bg-bg border border-border rounded-[6px] w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-base font-semibold text-text-primary">Add new lead</h2>
              <button
                onClick={() => {
                  if (!isAddingLead) {
                    setShowAddLead(false);
                  }
                }}
                disabled={isAddingLead}
                className="text-muted hover:text-text-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const formData = new FormData(event.currentTarget);
                void handleAddLead({
                  first_name: formData.get("first_name") as string,
                  last_name: formData.get("last_name") as string,
                  email: (formData.get("email") as string) || undefined,
                  phone: (formData.get("phone") as string) || undefined,
                  source: formData.get("source") as LeadSource,
                  program_interest:
                    (formData.get("program_interest") as string) || undefined,
                  notes: (formData.get("notes") as string) || undefined,
                });
              }}
              className="space-y-4"
            >
              {addLeadError && (
                <div className="rounded-[6px] border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
                  {addLeadError}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary font-medium">
                    First name *
                  </label>
                  <input
                    name="first_name"
                    required
                    disabled={isAddingLead}
                    className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary font-medium">
                    Last name *
                  </label>
                  <input
                    name="last_name"
                    required
                    disabled={isAddingLead}
                    className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-text-secondary font-medium">Email</label>
                <input
                  name="email"
                  type="email"
                  disabled={isAddingLead}
                  className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary font-medium">Phone</label>
                  <input
                    name="phone"
                    type="tel"
                    disabled={isAddingLead}
                    className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary font-medium">Source</label>
                  <select
                    name="source"
                    defaultValue="walk_in"
                    disabled={isAddingLead}
                    className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
                  >
                    {Object.entries(SOURCE_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-text-secondary font-medium">
                  Program interest
                </label>
                <input
                  name="program_interest"
                  placeholder="e.g. Adult BJJ, Kids Martial Arts"
                  disabled={isAddingLead}
                  className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-text-secondary font-medium">Notes</label>
                <textarea
                  name="notes"
                  rows={2}
                  disabled={isAddingLead}
                  className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none resize-none"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={isAddingLead}
                  onClick={() => setShowAddLead(false)}
                >
                  Cancel
                </Button>
                <Button variant="primary" size="sm" type="submit" disabled={isAddingLead}>
                  {isAddingLead ? "Saving..." : "Add lead"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
