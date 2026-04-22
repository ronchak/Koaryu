"use client";

import { useState, useRef, useCallback } from "react";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import type { BeltRank, EligibilityEntry } from "@/types";
import {
  Award,
  Check,
  Clock,
  AlertTriangle,
  Settings,
  ChevronUp,
  GripVertical,
  Plus,
  Pencil,
  Trash2,
  Tag,
  X,
  Save,
  ChevronDown,
  ChevronRight,
  Layers,
} from "lucide-react";

type Tab = "eligibility" | "ladder";

// ── Belt group: one full belt + the tips that follow it ──────────────────────
type BeltGroup = {
  belt: BeltRank;
  tips: BeltRank[];
  collapsed: boolean;
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function localId() {
  return "local-" + Math.random().toString(36).slice(2, 9);
}

function groupRanks(ranks: BeltRank[]): BeltGroup[] {
  const groups: BeltGroup[] = [];
  for (const rank of ranks) {
    if (!rank.is_tip) {
      groups.push({ belt: rank, tips: [], collapsed: false });
    } else if (groups.length > 0) {
      groups[groups.length - 1].tips.push(rank);
    }
  }
  return groups;
}

function flattenGroups(groups: BeltGroup[]): BeltRank[] {
  const flat: BeltRank[] = [];
  let order = 0;
  for (const g of groups) {
    flat.push({ ...g.belt, display_order: order++ });
    for (const t of g.tips) {
      flat.push({ ...t, display_order: order++ });
    }
  }
  return flat;
}

// ── Preset colors ────────────────────────────────────────────────────────────
const BELT_COLOR_PRESETS = [
  { label: "White",  hex: "#FFFFFF" },
  { label: "Yellow", hex: "#EAB308" },
  { label: "Orange", hex: "#F97316" },
  { label: "Red",    hex: "#EF4444" },
  { label: "Purple", hex: "#8B5CF6" },
  { label: "Blue",   hex: "#3B82F6" },
  { label: "Green",  hex: "#22C55E" },
  { label: "Brown",  hex: "#92400E" },
  { label: "Black",  hex: "#111111" },
  { label: "Pink",   hex: "#EC4899" },
  { label: "Grey",   hex: "#6B7280" },
  { label: "Gold",   hex: "#D6B25E" },
];

// ── ProgressBar ──────────────────────────────────────────────────────────────
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

// ── RankBadge ────────────────────────────────────────────────────────────────
function RankBadge({ name, color, isTip, tipColor }: {
  name: string; color: string; isTip?: boolean; tipColor?: string;
}) {
  const isWhite = color === "#FFFFFF" || color === "#ffffff";
  const textColor = isWhite ? "text-text-primary" : "text-white";
  const border = isWhite ? "border border-border" : "";
  const bg = isWhite ? "transparent" : color;

  if (isTip && tipColor) {
    return (
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] text-xs font-medium ${textColor} ${border}`}
        style={{ backgroundColor: bg }}
      >
        <span className="w-2 h-2 rounded-full border border-white/20 flex-shrink-0"
          style={{ backgroundColor: isWhite ? "#d0d0d0" : color }} />
        {name}
        <span className="ml-0.5 w-1.5 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: tipColor }} />
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] text-xs font-medium ${textColor} ${border}`}
      style={{ backgroundColor: bg }}
    >
      <span className="w-2 h-2 rounded-full border border-white/30" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}

// ── BeltVisual ───────────────────────────────────────────────────────────────
function BeltVisual({ rank, size = "md" }: { rank: BeltRank; size?: "sm" | "md" }) {
  const isWhite = rank.color_hex === "#FFFFFF" || rank.color_hex === "#ffffff";
  const dims = size === "sm" ? "w-7 h-3" : "w-10 h-4";
  return (
    <div
      className={`relative ${dims} rounded-[2px] overflow-hidden flex-shrink-0`}
      style={{
        backgroundColor: rank.color_hex,
        border: isWhite ? "1px solid var(--border)" : "none",
        boxShadow: "inset 0 1px 2px rgba(0,0,0,0.25)",
      }}
    >
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[3px] bg-black/20" />
      {rank.is_tip && rank.tip_color_hex && (
        <div className="absolute right-0 inset-y-0 w-2.5" style={{ backgroundColor: rank.tip_color_hex }} />
      )}
    </div>
  );
}

// ── ColorPicker ──────────────────────────────────────────────────────────────
function ColorPicker({ label, value, onChange }: {
  label: string; value: string; onChange: (hex: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs text-text-secondary font-medium mb-2">{label}</label>
      <div className="grid grid-cols-6 gap-1.5 mb-2">
        {BELT_COLOR_PRESETS.map((c) => (
          <button key={c.hex} type="button" title={c.label}
            onClick={() => onChange(c.hex)}
            className="w-7 h-7 rounded-[4px] transition-transform hover:scale-110 flex-shrink-0"
            style={{
              backgroundColor: c.hex,
              border: value === c.hex ? "2px solid var(--accent)" : "1px solid var(--border)",
              outline: value === c.hex ? "2px solid var(--accent)" : "none",
              outlineOffset: 1,
            }}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-[3px] border border-border flex-shrink-0" style={{ backgroundColor: value }} />
        <input type="text" value={value}
          onChange={(e) => { const v = e.target.value; if (/^#[0-9A-Fa-f]{0,6}$/.test(v)) onChange(v); }}
          maxLength={7} placeholder="#FFFFFF"
          className="flex-1 px-2 py-1 text-xs bg-surface-raised border border-border rounded-[4px] text-text-primary font-mono focus:border-accent focus:outline-none"
        />
      </div>
    </div>
  );
}

// ── RankFormModal ─────────────────────────────────────────────────────────────
type RankFormData = {
  name: string; is_tip: boolean; color_hex: string;
  tip_color_hex: string; min_classes: number; min_months: number; requires_approval: boolean;
};

function RankFormModal({ initial, onSave, onClose, title, subRankTerm, forceTip, lockType }: {
  initial?: Partial<RankFormData>;
  onSave: (data: RankFormData) => void;
  onClose: () => void;
  title: string;
  subRankTerm: string;
  forceTip?: boolean;
  lockType?: boolean;
}) {
  const [form, setForm] = useState<RankFormData>({
    name: initial?.name ?? "",
    is_tip: forceTip ?? initial?.is_tip ?? false,
    color_hex: initial?.color_hex ?? "#FFFFFF",
    tip_color_hex: initial?.tip_color_hex ?? "#EF4444",
    min_classes: initial?.min_classes ?? 0,
    min_months: initial?.min_months ?? 0,
    requires_approval: initial?.requires_approval ?? false,
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    onSave(form);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-bg border border-border rounded-[6px] w-full max-w-sm p-6 overflow-y-auto max-h-[90vh]">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-text-primary">{title}</h2>
          <button onClick={onClose} className="text-muted hover:text-text-secondary cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-text-secondary font-medium mb-1.5">Rank name</label>
            <input type="text" value={form.name}
              onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder={form.is_tip ? `e.g. 1 ${subRankTerm}, 2 ${subRankTerm}s` : "e.g. Blue Belt"}
              required
              className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>

          {/* Type toggle — hidden when forceTip is set (adding a sub-rank from the belt's row) */}
          {forceTip === undefined && !lockType && (
            <div>
              <label className="block text-xs text-text-secondary font-medium mb-1.5">Rank type</label>
              <div className="flex gap-2">
                {([false, true] as const).map((val) => (
                  <button key={String(val)} type="button"
                    onClick={() => setForm(f => ({ ...f, is_tip: val }))}
                    className={`flex-1 py-1.5 text-xs rounded-[6px] border transition-colors cursor-pointer ${
                      form.is_tip === val
                        ? "border-accent text-accent bg-accent/10 font-medium"
                        : "border-border text-text-secondary hover:border-text-secondary"
                    }`}
                  >
                    {val ? subRankTerm : "Full Belt"}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted mt-1">
                {form.is_tip
                  ? `An intermediary step within a belt (e.g. 2 ${subRankTerm}s).`
                  : "A major rank milestone (e.g. Blue Belt)."}
              </p>
            </div>
          )}

          {lockType && (
            <p className="text-xs text-muted">
              Rank type is locked after creation. Add a new belt or {subRankTerm.toLowerCase()} instead of converting this one in place.
            </p>
          )}

          <ColorPicker
            label={form.is_tip ? "Belt background color" : "Belt color"}
            value={form.color_hex}
            onChange={(hex) => setForm(f => ({ ...f, color_hex: hex }))}
          />

          {form.is_tip && (
            <ColorPicker
              label={`${subRankTerm} color`}
              value={form.tip_color_hex}
              onChange={(hex) => setForm(f => ({ ...f, tip_color_hex: hex }))}
            />
          )}

          {/* Live preview */}
          <div className="flex items-center gap-3 p-3 bg-surface-raised rounded-[6px] border border-border">
            <BeltVisual rank={{
              ...form, id: "preview", ladder_id: "", studio_id: "", display_order: 0, created_at: "",
              tip_color_hex: form.is_tip ? form.tip_color_hex : undefined,
            }} />
            <RankBadge name={form.name || "Preview"} color={form.color_hex}
              isTip={form.is_tip} tipColor={form.is_tip ? form.tip_color_hex : undefined} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-secondary font-medium mb-1.5">Min classes</label>
              <input type="number" min={0} value={form.min_classes}
                onChange={(e) => setForm(f => ({ ...f, min_classes: Number(e.target.value) }))}
                className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary font-medium mb-1.5">Min months</label>
              <input type="number" min={0} value={form.min_months}
                onChange={(e) => setForm(f => ({ ...f, min_months: Number(e.target.value) }))}
                className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer">
            <input type="checkbox" checked={form.requires_approval}
              onChange={(e) => setForm(f => ({ ...f, requires_approval: e.target.checked }))}
              className="w-3.5 h-3.5 accent-[var(--accent)]"
            />
            <span className="text-sm text-text-secondary">Requires instructor approval</span>
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" size="sm">
              <Save className="w-3.5 h-3.5" /> Save rank
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── DeleteConfirm ─────────────────────────────────────────────────────────────
function DeleteConfirm({ name, onConfirm, onCancel }: {
  name: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative bg-bg border border-border rounded-[6px] w-full max-w-xs p-6">
        <h2 className="text-base font-semibold text-text-primary mb-2">Delete rank?</h2>
        <p className="text-sm text-text-secondary mb-4">
          <strong className="text-text-primary">{name}</strong> will be permanently removed.
          Students at this rank may need reassignment.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={onConfirm}
            className="!bg-danger hover:!bg-danger/80">
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Page
// ══════════════════════════════════════════════════════════════════════════════
export default function BeltTrackerPage() {
  const store = useStore();
  const [tab, setTab] = useState<Tab>("eligibility");

  // Draft state is only used once the user starts editing.
  const [draftRanks, setDraftRanks] = useState<BeltRank[]>([]);
  const eligibility = store.eligibility;
  const ladderName = store.ladderName;

  // Per-studio configurable sub-rank terminology
  const [draftSubRankTerm, setDraftSubRankTerm] = useState(store.subRankTerm);
  const [editingTerm, setEditingTerm] = useState(false);
  const [termDraft, setTermDraft] = useState(store.subRankTerm);

  // Collapsed groups state (by belt id)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Drag state — belt group level
  const dragGroupIdx = useRef<number | null>(null);
  const [draggingGroupIdx, setDraggingGroupIdx] = useState<number | null>(null);
  const [dragOverGroupIdx, setDragOverGroupIdx] = useState<number | null>(null);

  // Drag state — tip level (within a group)
  const dragTip = useRef<{ gIdx: number; tIdx: number } | null>(null);
  const [draggingTip, setDraggingTip] = useState<{ gIdx: number; tIdx: number } | null>(null);
  const [dragOverTip, setDragOverTip] = useState<{ gIdx: number; tIdx: number } | null>(null);

  // Dirty tracking
  const [dirty, setDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Modal states
  const [addBeltModal, setAddBeltModal] = useState(false);
  const [addTipForGroup, setAddTipForGroup] = useState<number | null>(null); // group index
  const [editRankId, setEditRankId] = useState<string | null>(null);
  const [deleteRankId, setDeleteRankId] = useState<string | null>(null);

  // Promote modal
  const [promoteEntry, setPromoteEntry] = useState<EligibilityEntry | null>(null);
  const [promotionNotes, setPromotionNotes] = useState("");
  const [promotionError, setPromotionError] = useState<string | null>(null);
  const [isPromoting, setIsPromoting] = useState(false);

  // ── Derived state ──────────────────────────────────────────────────────────
  const ranks = dirty ? draftRanks : store.beltRanks;
  const subRankTerm = dirty ? draftSubRankTerm : store.subRankTerm;
  const groups = groupRanks(ranks);
  const editRank = editRankId ? ranks.find(r => r.id === editRankId) : null;
  const deleteRank = deleteRankId ? ranks.find(r => r.id === deleteRankId) : null;

  const updateRanks = useCallback((updater: (current: BeltRank[]) => BeltRank[]) => {
    setSaveError(null);
    setDraftRanks((currentDraft) => updater(dirty ? currentDraft : ranks));
    setDirty(true);
  }, [dirty, ranks]);

  // ── Belt group DnD ──────────────────────────────────────────────────────────
  const onBeltDragStart = useCallback((gIdx: number, e: React.DragEvent) => {
    dragGroupIdx.current = gIdx;
    setDraggingGroupIdx(gIdx);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const onBeltDragOver = useCallback((gIdx: number, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverGroupIdx(gIdx);
  }, []);

  const onBeltDrop = useCallback((dropGIdx: number) => {
    const from = dragGroupIdx.current;
    if (from === null || from === dropGIdx) {
      dragGroupIdx.current = null;
      setDraggingGroupIdx(null);
      setDragOverGroupIdx(null);
      return;
    }
    const newGroups = [...groups];
    const [moved] = newGroups.splice(from, 1);
    newGroups.splice(dropGIdx, 0, moved);
    updateRanks(() => flattenGroups(newGroups.map(g => ({ ...g, collapsed: false }))));
    dragGroupIdx.current = null;
    setDraggingGroupIdx(null);
    setDragOverGroupIdx(null);
  }, [groups, updateRanks]);

  const onBeltDragEnd = useCallback(() => {
    dragGroupIdx.current = null;
    setDraggingGroupIdx(null);
    setDragOverGroupIdx(null);
  }, []);

  // ── Tip DnD (within a group) ────────────────────────────────────────────────
  const onTipDragStart = useCallback((gIdx: number, tIdx: number, e: React.DragEvent) => {
    e.stopPropagation(); // don't trigger belt drag
    dragTip.current = { gIdx, tIdx };
    setDraggingTip({ gIdx, tIdx });
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const onTipDragOver = useCallback((gIdx: number, tIdx: number, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverTip({ gIdx, tIdx });
  }, []);

  const onTipDrop = useCallback((dropGIdx: number, dropTIdx: number) => {
    const from = dragTip.current;
    if (!from || (from.gIdx === dropGIdx && from.tIdx === dropTIdx)) {
      dragTip.current = null;
      setDraggingTip(null);
      setDragOverTip(null);
      return;
    }
    const newGroups = groups.map(g => ({ ...g, tips: [...g.tips] }));
    if (from.gIdx === dropGIdx) {
      // Same group — reorder within
      const tips = newGroups[dropGIdx].tips;
      const [moved] = tips.splice(from.tIdx, 1);
      tips.splice(dropTIdx, 0, moved);
    }
    // Cross-group tip moves not supported (tips belong to their belt)
    updateRanks(() => flattenGroups(newGroups));
    dragTip.current = null;
    setDraggingTip(null);
    setDragOverTip(null);
  }, [groups, updateRanks]);

  const onTipDragEnd = useCallback(() => {
    dragTip.current = null;
    setDraggingTip(null);
    setDragOverTip(null);
  }, []);

  // ── CRUD ────────────────────────────────────────────────────────────────────
  function handleAddBelt(data: RankFormData) {
    const newRank: BeltRank = {
      id: localId(), ladder_id: "ladder-1", studio_id: "studio-1",
      name: data.name, color_hex: data.color_hex, is_tip: false,
      tip_color_hex: undefined, min_classes: data.min_classes,
      min_months: data.min_months, requires_approval: data.requires_approval,
      display_order: ranks.length, created_at: new Date().toISOString(),
    };
    updateRanks((currentRanks) => [...currentRanks, newRank]);
    setAddBeltModal(false);
  }

  function handleAddTip(gIdx: number, data: RankFormData) {
    // Insert the new tip after the last tip in this group
    const newGroups = groups.map(g => ({ ...g, tips: [...g.tips] }));
    const newTip: BeltRank = {
      id: localId(), ladder_id: "ladder-1", studio_id: "studio-1",
      name: data.name, color_hex: newGroups[gIdx].belt.color_hex,
      is_tip: true, tip_color_hex: data.tip_color_hex,
      min_classes: data.min_classes, min_months: data.min_months,
      requires_approval: data.requires_approval,
      display_order: 0, created_at: new Date().toISOString(),
    };
    newGroups[gIdx].tips.push(newTip);
    updateRanks(() => flattenGroups(newGroups));
    setAddTipForGroup(null);
  }

  function handleEdit(data: RankFormData) {
    if (!editRankId) return;
    updateRanks((currentRanks) => currentRanks.map(r =>
      r.id === editRankId
        ? { ...r, name: data.name, color_hex: data.color_hex,
            tip_color_hex: r.is_tip ? data.tip_color_hex : undefined,
            min_classes: data.min_classes, min_months: data.min_months,
            requires_approval: data.requires_approval }
        : r
    ));
    setEditRankId(null);
  }

  function handleDelete() {
    if (!deleteRankId) return;
    updateRanks((currentRanks) => {
      const targetIndex = currentRanks.findIndex((rank) => rank.id === deleteRankId);
      if (targetIndex === -1) {
        return currentRanks;
      }

      const targetRank = currentRanks[targetIndex];
      const idsToDelete = new Set<string>([deleteRankId]);
      if (!targetRank.is_tip) {
        let nextIndex = targetIndex + 1;
        while (nextIndex < currentRanks.length && currentRanks[nextIndex].is_tip) {
          idsToDelete.add(currentRanks[nextIndex].id);
          nextIndex += 1;
        }
      }

      return currentRanks
        .filter((rank) => !idsToDelete.has(rank.id))
        .map((rank, index) => ({ ...rank, display_order: index }));
    });
    setDeleteRankId(null);
  }

  function toggleCollapse(id: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleSaveRanks() {
    setSaveError(null);
    setIsSaving(true);
    try {
      await store.setBeltRanks(ranks, { subRankTerm });
      setDirty(false);
    } catch (error) {
      console.error("Failed to save belt ranks", error);
      setSaveError("Could not save ladder changes. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleConfirmPromotion() {
    if (!promoteEntry) return;

    const targetRankId = promoteEntry.next_rank_id;
    if (!targetRankId) {
      setPromotionError("Could not determine the next rank for this promotion.");
      return;
    }

    setIsPromoting(true);
    setPromotionError(null);
    try {
      await store.promoteStudent(
        promoteEntry.student_id,
        targetRankId,
        promotionNotes.trim() || undefined
      );
      setPromoteEntry(null);
      setPromotionNotes("");
    } catch (error) {
      console.error("Failed to promote student", error);
      setPromotionError("Could not record the promotion. Please try again.");
    } finally {
      setIsPromoting(false);
    }
  }

  // ── Eligibility list ────────────────────────────────────────────────────────
  const sorted = [...eligibility].sort((a, b) => {
    const aR = a.classes_met && a.time_met ? 1 : 0;
    const bR = b.classes_met && b.time_met ? 1 : 0;
    if (aR !== bR) return bR - aR;
    const aP = a.classes_required ? a.classes_since_promo / a.classes_required : 0;
    const bP = b.classes_required ? b.classes_since_promo / b.classes_required : 0;
    return bP - aP;
  });

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <Header
        title="Belt Tracker"
        description="Track rank progression and promotion readiness."
      >
        {tab === "eligibility" ? (
          <Button variant="secondary" size="sm" onClick={() => setTab("ladder")}>
            <Settings className="w-3.5 h-3.5" />
            Configure ladder
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setTab("eligibility")}>
            <Award className="w-3.5 h-3.5" />
            View eligibility
          </Button>
        )}
      </Header>

      <div className="flex-1 flex flex-col">
        {/* Tabs */}
        <div className="flex items-center gap-4 px-8 py-3 border-b border-border">
          {([
            { id: "eligibility" as Tab, label: "Eligibility" },
            { id: "ladder" as Tab, label: "Ladder Config" },
          ]).map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`text-sm pb-2 border-b-2 cursor-pointer transition-colors ${
                tab === t.id
                  ? "text-text-primary border-accent font-medium"
                  : "text-text-secondary border-transparent hover:text-text-primary"
              }`}
            >
              {t.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted">{ladderName}</span>
        </div>

        {/* ── Eligibility Tab ──────────────────────────────────────────── */}
        {tab === "eligibility" && (
          <div className="flex-1 overflow-x-auto">
            {sorted.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <Award className="w-8 h-8 text-muted mb-3" />
                <p className="text-sm text-text-secondary">No active students to evaluate.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary">Student</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary">Current Rank</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary">Next Rank</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary w-44">Classes</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary w-44">Time at Rank</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary">Status</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((entry) => {
                    const allMet = entry.classes_met && entry.time_met;
                    const cRank = ranks.find(r => r.name === entry.current_rank_name);
                    const nRank = ranks.find(r => r.name === entry.next_rank_name);
                    return (
                      <tr key={entry.student_id} className="border-b border-border hover:bg-surface-raised/50 transition-colors">
                        <td className="px-6 py-3">
                          <p className="font-medium text-text-primary">{entry.student_name}</p>
                        </td>
                        <td className="px-4 py-3">
                          {entry.current_rank_name && entry.current_rank_color
                            ? <RankBadge name={entry.current_rank_name} color={entry.current_rank_color} isTip={cRank?.is_tip} tipColor={cRank?.tip_color_hex} />
                            : <span className="text-xs text-muted">Unranked</span>}
                        </td>
                        <td className="px-4 py-3">
                          {entry.next_rank_name && entry.next_rank_color
                            ? <RankBadge name={entry.next_rank_name} color={entry.next_rank_color} isTip={nRank?.is_tip} tipColor={nRank?.tip_color_hex} />
                            : <span className="text-xs text-muted">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <ProgressBar current={entry.classes_since_promo} required={entry.classes_required} met={entry.classes_met} />
                        </td>
                        <td className="px-4 py-3">
                          <ProgressBar current={entry.days_at_rank} required={entry.days_required} met={entry.time_met} />
                        </td>
                        <td className="px-4 py-3">
                          {allMet
                            ? entry.needs_approval
                              ? <span className="flex items-center gap-1 text-xs text-warning"><AlertTriangle className="w-3 h-3" />Needs approval</span>
                              : <span className="flex items-center gap-1 text-xs text-success"><Check className="w-3 h-3" />Eligible</span>
                            : <span className="flex items-center gap-1 text-xs text-muted"><Clock className="w-3 h-3" />In progress</span>}
                        </td>
                        <td className="px-4 py-3">
                          {allMet && (
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => {
                                setPromotionError(null);
                                setPromotionNotes("");
                                setPromoteEntry(entry);
                              }}
                            >
                              <ChevronUp className="w-3 h-3" />Promote
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

        {/* ── Ladder Config Tab ─────────────────────────────────────────── */}
        {tab === "ladder" && (
          <div className="flex-1 p-8 overflow-y-auto">
            <div className="max-w-xl">

              {/* Config header */}
              <div className="flex items-start justify-between mb-5">
                <div>
                  <h2 className="text-sm font-semibold text-text-primary">{ladderName}</h2>
                  <p className="text-xs text-muted mt-0.5">
                    {groups.length} belts · {ranks.filter(r => r.is_tip).length} {subRankTerm.toLowerCase()}s total
                  </p>

                  {/* Editable sub-rank term */}
                  <div className="flex items-center gap-1.5 mt-2">
                    <Layers className="w-3 h-3 text-muted" />
                    <span className="text-xs text-muted">Sub-rank term:</span>
                    {editingTerm ? (
                      <form onSubmit={(e) => {
                        e.preventDefault();
                        const nextTerm = termDraft.trim() || "Stripe";
                        setSaveError(null);
                        setDraftSubRankTerm(nextTerm);
                        setTermDraft(nextTerm);
                        setDirty(nextTerm !== store.subRankTerm || dirty);
                        setEditingTerm(false);
                      }} className="flex items-center gap-1">
                        <input
                          type="text"
                          value={termDraft}
                          onChange={e => setTermDraft(e.target.value)}
                          autoFocus
                          className="px-1.5 py-0.5 text-xs bg-surface-raised border border-accent rounded-[4px] text-text-primary focus:outline-none w-20"
                        />
                        <button type="submit" className="text-xs text-accent hover:text-accent/80 cursor-pointer font-medium">Save</button>
                        <button type="button" onClick={() => setEditingTerm(false)} className="text-xs text-muted hover:text-text-secondary cursor-pointer">✕</button>
                      </form>
                    ) : (
                      <button
                        onClick={() => { setTermDraft(subRankTerm); setEditingTerm(true); }}
                        className="text-xs text-accent font-medium hover:underline cursor-pointer flex items-center gap-1"
                      >
                        {subRankTerm}
                        <Pencil className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {dirty && (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={isSaving}
                      onClick={handleSaveRanks}
                    >
                      <Save className="w-3.5 h-3.5" />{isSaving ? "Saving..." : "Save order"}
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => setAddBeltModal(true)}>
                    <Plus className="w-3.5 h-3.5" />Add belt
                  </Button>
                </div>
              </div>

              {saveError && (
                <div className="mb-4 rounded-[6px] border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
                  {saveError}
                </div>
              )}

              <p className="text-xs text-muted mb-4 flex items-center gap-1.5">
                <GripVertical className="w-3 h-3" />
                Drag belts to reorder. Drag {subRankTerm.toLowerCase()}s within a belt to reorder them.
              </p>

              {/* ── Belt groups ─────────────────────────────────────────── */}
              <div className="space-y-2">
                {groups.map((group, gIdx) => {
                  const isCollapsed = collapsed.has(group.belt.id);
                  const isDraggingThisGroup = draggingGroupIdx === gIdx;
                  const isDropTarget = dragOverGroupIdx === gIdx && draggingGroupIdx !== gIdx;

                  return (
                    <div
                      key={group.belt.id}
                      className={`rounded-[6px] border transition-all ${
                        isDropTarget
                          ? "border-accent bg-accent/5"
                          : "border-border bg-surface"
                      } ${isDraggingThisGroup ? "opacity-40" : "opacity-100"}`}
                    >
                      {/* ── Belt header row ──────────────────────────── */}
                      <div
                        draggable
                        onDragStart={(e) => onBeltDragStart(gIdx, e)}
                        onDragOver={(e) => onBeltDragOver(gIdx, e)}
                        onDrop={() => onBeltDrop(gIdx)}
                        onDragEnd={onBeltDragEnd}
                        className="flex items-center gap-3 px-4 py-3 cursor-default select-none"
                      >
                        {/* Drag handle */}
                        <GripVertical className="w-3.5 h-3.5 text-muted cursor-grab active:cursor-grabbing flex-shrink-0" />

                        {/* Collapse toggle */}
                        <button
                          type="button"
                          onClick={() => toggleCollapse(group.belt.id)}
                          className="text-muted hover:text-text-secondary transition-colors cursor-pointer flex-shrink-0"
                        >
                          {isCollapsed
                            ? <ChevronRight className="w-3.5 h-3.5" />
                            : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>

                        {/* Belt visual */}
                        <BeltVisual rank={group.belt} />

                        {/* Belt name + meta */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-text-primary truncate">
                            {group.belt.name}
                          </p>
                          <p className="text-xs text-muted mt-0.5">
                            {group.belt.min_classes > 0 ? `${group.belt.min_classes} classes` : ""}
                            {group.belt.min_classes > 0 && group.belt.min_months > 0 ? " · " : ""}
                            {group.belt.min_months > 0 ? `${group.belt.min_months} months` : ""}
                            {group.belt.requires_approval ? " · Approval" : ""}
                            {!group.belt.min_classes && !group.belt.min_months && !group.belt.requires_approval
                              ? gIdx === 0 ? "Starting belt" : "No requirements"
                              : ""}
                            {group.tips.length > 0
                              ? ` · ${group.tips.length} ${subRankTerm.toLowerCase()}${group.tips.length !== 1 ? "s" : ""}`
                              : ""}
                          </p>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button type="button" onClick={() => setEditRankId(group.belt.id)}
                            className="p-1.5 rounded-[4px] text-muted hover:text-text-primary hover:bg-surface-raised transition-colors cursor-pointer"
                            title="Edit belt">
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button type="button" onClick={() => setDeleteRankId(group.belt.id)}
                            className="p-1.5 rounded-[4px] text-muted hover:text-danger hover:bg-danger/10 transition-colors cursor-pointer"
                            title="Delete belt">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      {/* ── Tips sub-list ─────────────────────────────── */}
                      {!isCollapsed && (
                        <div className="ml-10 mr-4 mb-3 border-l-2 border-border pl-4">
                          {group.tips.length === 0 && (
                            <p className="text-xs text-muted italic py-1 mb-1">
                              No {subRankTerm.toLowerCase()}s configured.
                            </p>
                          )}

                          {group.tips.map((tip, tIdx) => {
                            const isTipDragging = draggingTip?.gIdx === gIdx && draggingTip?.tIdx === tIdx;
                            const isTipOver = dragOverTip?.gIdx === gIdx && dragOverTip?.tIdx === tIdx
                              && !(draggingTip?.gIdx === gIdx && draggingTip?.tIdx === tIdx);

                            return (
                              <div
                                key={tip.id}
                                draggable
                                onDragStart={(e) => onTipDragStart(gIdx, tIdx, e)}
                                onDragOver={(e) => onTipDragOver(gIdx, tIdx, e)}
                                onDrop={() => onTipDrop(gIdx, tIdx)}
                                onDragEnd={onTipDragEnd}
                                className={`flex items-center gap-2.5 py-2 px-2 rounded-[4px] mb-0.5 transition-all select-none ${
                                  isTipDragging ? "opacity-30" : "opacity-100"
                                } ${isTipOver ? "bg-accent/10" : "hover:bg-surface-raised/60"}`}
                              >
                                <GripVertical className="w-3 h-3 text-muted/50 cursor-grab active:cursor-grabbing flex-shrink-0" />
                                <BeltVisual rank={tip} size="sm" />
                                <span className="text-xs text-text-secondary flex-1 truncate font-medium">
                                  {tip.name}
                                </span>
                                <span className="text-xs text-muted">
                                  {tip.min_classes > 0 ? `${tip.min_classes} cl` : ""}
                                  {tip.min_classes > 0 && tip.min_months > 0 ? " · " : ""}
                                  {tip.min_months > 0 ? `${tip.min_months} mo` : ""}
                                  {tip.requires_approval ? " · ✓" : ""}
                                </span>
                                <div className="flex items-center gap-0.5 flex-shrink-0">
                                  <button type="button" onClick={() => setEditRankId(tip.id)}
                                    className="p-1 rounded-[4px] text-muted hover:text-text-primary hover:bg-surface-raised transition-colors cursor-pointer">
                                    <Pencil className="w-2.5 h-2.5" />
                                  </button>
                                  <button type="button" onClick={() => setDeleteRankId(tip.id)}
                                    className="p-1 rounded-[4px] text-muted hover:text-danger hover:bg-danger/10 transition-colors cursor-pointer">
                                    <Trash2 className="w-2.5 h-2.5" />
                                  </button>
                                </div>
                              </div>
                            );
                          })}

                          {/* Add tip button */}
                          <button
                            type="button"
                            onClick={() => setAddTipForGroup(gIdx)}
                            className="flex items-center gap-1.5 text-xs text-muted hover:text-accent transition-colors cursor-pointer mt-1 py-1 px-2 rounded-[4px] hover:bg-surface-raised/60"
                          >
                            <Plus className="w-3 h-3" />
                            Add {subRankTerm.toLowerCase()}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}

                {groups.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-10 text-center text-muted border border-dashed border-border rounded-[6px]">
                    <Tag className="w-6 h-6 mb-2" />
                    <p className="text-sm">No belts yet. Add your first belt to get started.</p>
                  </div>
                )}
              </div>

              {dirty && (
                <p className="text-xs text-warning mt-3 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
                  Unsaved changes to rank order.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Modals ──────────────────────────────────────────────── */}

      {addBeltModal && (
        <RankFormModal title="Add belt" subRankTerm={subRankTerm}
          onSave={handleAddBelt} onClose={() => setAddBeltModal(false)} />
      )}

      {addTipForGroup !== null && (
        <RankFormModal
          title={`Add ${subRankTerm} to ${groups[addTipForGroup]?.belt.name ?? ""}`}
          subRankTerm={subRankTerm}
          forceTip
          initial={{
            color_hex: groups[addTipForGroup]?.belt.color_hex ?? "#FFFFFF",
            tip_color_hex: "#EF4444",
          }}
          onSave={(data) => handleAddTip(addTipForGroup, data)}
          onClose={() => setAddTipForGroup(null)}
        />
      )}

      {editRank && (
        <RankFormModal
          title={`Edit — ${editRank.name}`}
          subRankTerm={subRankTerm}
          initial={{
            name: editRank.name, is_tip: editRank.is_tip, color_hex: editRank.color_hex,
            tip_color_hex: editRank.tip_color_hex ?? "#EF4444",
            min_classes: editRank.min_classes, min_months: editRank.min_months,
            requires_approval: editRank.requires_approval,
          }}
          lockType
          onSave={handleEdit}
          onClose={() => setEditRankId(null)}
        />
      )}

      {deleteRank && (
        <DeleteConfirm name={deleteRank.name} onConfirm={handleDelete} onCancel={() => setDeleteRankId(null)} />
      )}

      {/* ── Promote modal ──────────────────────────────────────── */}
      {promoteEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setPromoteEntry(null)} />
          <div className="relative bg-bg border border-border rounded-[6px] w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-text-primary mb-4">Confirm Promotion</h2>
            <div className="bg-surface border border-border rounded-[6px] p-4 mb-4">
              <p className="text-sm text-text-primary font-medium">{promoteEntry.student_name}</p>
              <div className="flex items-center gap-2 mt-2">
                {promoteEntry.current_rank_name && promoteEntry.current_rank_color && (() => {
                  const r = ranks.find((rank) => rank.id === promoteEntry.current_rank_id);
                  return <RankBadge name={promoteEntry.current_rank_name} color={promoteEntry.current_rank_color} isTip={r?.is_tip} tipColor={r?.tip_color_hex} />;
                })()}
                <span className="text-muted">→</span>
                {promoteEntry.next_rank_name && promoteEntry.next_rank_color && (() => {
                  const r = ranks.find((rank) => rank.id === promoteEntry.next_rank_id);
                  return <RankBadge name={promoteEntry.next_rank_name} color={promoteEntry.next_rank_color} isTip={r?.is_tip} tipColor={r?.tip_color_hex} />;
                })()}
              </div>
            </div>
            <div className="flex flex-col gap-1.5 mb-4">
              <label className="text-sm text-text-secondary font-medium">Notes (optional)</label>
              <textarea
                rows={2}
                value={promotionNotes}
                onChange={(event) => setPromotionNotes(event.target.value)}
                placeholder="e.g. Excellent guard work"
                className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none resize-none" />
            </div>
            {promotionError && (
              <p className="mb-4 rounded-[6px] border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
                {promotionError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPromoteEntry(null);
                  setPromotionError(null);
                  setPromotionNotes("");
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" size="sm" disabled={isPromoting} onClick={handleConfirmPromotion}>
                <Award className="w-3.5 h-3.5" />{isPromoting ? "Promoting..." : "Confirm promotion"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
