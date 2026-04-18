"use client";

import { useState } from "react";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { MOCK_BELT_LADDER, MOCK_ELIGIBILITY } from "@/lib/mock-data";
import type { BeltLadder, EligibilityEntry } from "@/types";
import {
  Award,
  Check,
  X,
  Clock,
  AlertTriangle,
  Settings,
  ChevronUp,
} from "lucide-react";

type Tab = "eligibility" | "ladder";

function ProgressBar({ current, required, met }: { current: number; required: number; met: boolean }) {
  const pct = required === 0 ? 100 : Math.min(100, Math.round((current / required) * 100));
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-1.5 bg-surface-raised rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${met ? "bg-success" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs font-mono w-14 text-right ${met ? "text-success" : "text-text-secondary"}`}>
        {current}/{required}
      </span>
    </div>
  );
}

function RankBadge({ name, color }: { name: string; color: string }) {
  const textColor = color === "#FFFFFF" || color === "#ffffff"
    ? "text-text-primary"
    : "text-white";
  const borderStyle = color === "#FFFFFF" || color === "#ffffff"
    ? "border border-border"
    : "";
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] text-xs font-medium ${textColor} ${borderStyle}`}
      style={{ backgroundColor: color === "#FFFFFF" ? "transparent" : color }}
    >
      <span
        className="w-2 h-2 rounded-full border border-white/30"
        style={{ backgroundColor: color }}
      />
      {name}
    </span>
  );
}

export default function BeltTrackerPage() {
  const [tab, setTab] = useState<Tab>("eligibility");
  const [ladder] = useState<BeltLadder>(MOCK_BELT_LADDER);
  const [eligibility] = useState<EligibilityEntry[]>(MOCK_ELIGIBILITY);
  const [showPromoteModal, setShowPromoteModal] = useState<EligibilityEntry | null>(null);

  // Sort eligibility: most ready first
  const sorted = [...eligibility].sort((a, b) => {
    // Both criteria met first
    const aReady = a.classes_met && a.time_met ? 1 : 0;
    const bReady = b.classes_met && b.time_met ? 1 : 0;
    if (aReady !== bReady) return bReady - aReady;
    // Then by classes completion pct
    const aPct = a.classes_required ? a.classes_since_promo / a.classes_required : 0;
    const bPct = b.classes_required ? b.classes_since_promo / b.classes_required : 0;
    return bPct - aPct;
  });

  return (
    <>
      <Header title="Belt Tracker" description="Track rank progression and promotion readiness.">
        <Button variant="secondary" size="sm" onClick={() => setTab("ladder")}>
          <Settings className="w-3.5 h-3.5" />
          Configure ladder
        </Button>
      </Header>

      <div className="flex-1 flex flex-col">
        {/* Tabs */}
        <div className="flex items-center gap-4 px-8 py-3 border-b border-border">
          {([
            { id: "eligibility" as Tab, label: "Eligibility" },
            { id: "ladder" as Tab, label: "Ladder Config" },
          ]).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`text-sm pb-2 border-b-2 cursor-pointer transition-colors ${
                tab === t.id
                  ? "text-text-primary border-accent font-medium"
                  : "text-text-secondary border-transparent hover:text-text-primary"
              }`}
            >
              {t.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted">
            Ladder: {ladder.name}
          </span>
        </div>

        {/* Eligibility tab */}
        {tab === "eligibility" && (
          <div className="flex-1 overflow-x-auto">
            {sorted.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <Award className="w-8 h-8 text-muted mb-3" />
                <p className="text-sm text-text-secondary">
                  No active students to evaluate. Add students and configure your belt ladder first.
                </p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary">Student</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary">Current Rank</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary">Next Rank</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary w-48">Classes</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary w-48">Time at Rank</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary">Status</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((entry) => {
                    const allMet = entry.classes_met && entry.time_met;
                    return (
                      <tr key={entry.student_id} className="border-b border-border hover:bg-surface-raised/50 transition-colors">
                        <td className="px-6 py-3">
                          <p className="font-medium text-text-primary">{entry.student_name}</p>
                        </td>
                        <td className="px-4 py-3">
                          {entry.current_rank_name && entry.current_rank_color ? (
                            <RankBadge name={entry.current_rank_name} color={entry.current_rank_color} />
                          ) : (
                            <span className="text-xs text-muted">Unranked</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {entry.next_rank_name && entry.next_rank_color ? (
                            <RankBadge name={entry.next_rank_name} color={entry.next_rank_color} />
                          ) : (
                            <span className="text-xs text-muted">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <ProgressBar
                            current={entry.classes_since_promo}
                            required={entry.classes_required}
                            met={entry.classes_met}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <ProgressBar
                            current={entry.days_at_rank}
                            required={entry.days_required}
                            met={entry.time_met}
                          />
                        </td>
                        <td className="px-4 py-3">
                          {allMet ? (
                            entry.needs_approval ? (
                              <span className="flex items-center gap-1 text-xs text-warning">
                                <AlertTriangle className="w-3 h-3" />
                                Needs approval
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-xs text-success">
                                <Check className="w-3 h-3" />
                                Eligible
                              </span>
                            )
                          ) : (
                            <span className="flex items-center gap-1 text-xs text-muted">
                              <Clock className="w-3 h-3" />
                              In progress
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {allMet && (
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => setShowPromoteModal(entry)}
                            >
                              <ChevronUp className="w-3 h-3" />
                              Promote
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Ladder config tab */}
        {tab === "ladder" && (
          <div className="flex-1 p-8">
            <div className="max-w-lg">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-medium text-text-primary">{ladder.name}</h2>
                <Button variant="secondary" size="sm">
                  Add rank
                </Button>
              </div>

              <div className="bg-surface border border-border rounded-[6px] overflow-hidden">
                {ladder.ranks.map((rank, i) => (
                  <div
                    key={rank.id}
                    className="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0"
                  >
                    <span className="text-xs text-muted font-mono w-6">{i + 1}</span>
                    <span
                      className="w-5 h-5 rounded-full border border-border flex-shrink-0"
                      style={{ backgroundColor: rank.color_hex }}
                    />
                    <div className="flex-1">
                      <p className="text-sm text-text-primary font-medium">{rank.name}</p>
                      <p className="text-xs text-muted mt-0.5">
                        {rank.min_classes > 0 && `${rank.min_classes} classes`}
                        {rank.min_classes > 0 && rank.min_months > 0 && " · "}
                        {rank.min_months > 0 && `${rank.min_months} months`}
                        {rank.requires_approval && " · Approval required"}
                        {!rank.min_classes && !rank.min_months && !rank.requires_approval && "No requirements"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Promote confirmation modal */}
      {showPromoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowPromoteModal(null)} />
          <div className="relative bg-bg border border-border rounded-[6px] w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-text-primary mb-4">
              Confirm Promotion
            </h2>
            <div className="bg-surface border border-border rounded-[6px] p-4 mb-4">
              <p className="text-sm text-text-primary font-medium">{showPromoteModal.student_name}</p>
              <div className="flex items-center gap-2 mt-2">
                {showPromoteModal.current_rank_name && showPromoteModal.current_rank_color && (
                  <RankBadge name={showPromoteModal.current_rank_name} color={showPromoteModal.current_rank_color} />
                )}
                <span className="text-muted">→</span>
                {showPromoteModal.next_rank_name && showPromoteModal.next_rank_color && (
                  <RankBadge name={showPromoteModal.next_rank_name} color={showPromoteModal.next_rank_color} />
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1.5 mb-4">
              <label className="text-sm text-text-secondary font-medium">Notes (optional)</label>
              <textarea
                rows={2}
                placeholder="e.g. Excellent guard work"
                className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none resize-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowPromoteModal(null)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={() => setShowPromoteModal(null)}>
                <Award className="w-3.5 h-3.5" />
                Confirm promotion
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
