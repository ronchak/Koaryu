"use client";

import { useState, type FormEvent } from "react";
import { BeltVisual, RankBadge } from "@/components/belt-tracker/rank-visuals";
import { Button } from "@/components/ui/button";
import { ModalFrame } from "@/components/ui/modal-frame";
import { Save, X } from "lucide-react";

const BELT_COLOR_PRESETS = [
  { label: "White", hex: "#FFFFFF" },
  { label: "Yellow", hex: "#EAB308" },
  { label: "Orange", hex: "#F97316" },
  { label: "Red", hex: "#EF4444" },
  { label: "Purple", hex: "#8B5CF6" },
  { label: "Blue", hex: "#3B82F6" },
  { label: "Green", hex: "#22C55E" },
  { label: "Brown", hex: "#92400E" },
  { label: "Black", hex: "#111111" },
  { label: "Pink", hex: "#EC4899" },
  { label: "Grey", hex: "#6B7280" },
  { label: "Gold", hex: "#D6B25E" },
];

export type RankFormData = {
  name: string;
  is_tip: boolean;
  color_hex: string;
  tip_color_hex: string;
  min_classes: number;
  min_months: number;
  requires_approval: boolean;
};

function ColorPicker({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs text-text-secondary font-medium mb-2">{label}</label>
      <div className="grid grid-cols-6 gap-1.5 mb-2">
        {BELT_COLOR_PRESETS.map((c) => (
          <button
            key={c.hex}
            type="button"
            title={c.label}
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
        <input
          type="text"
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            if (/^#[0-9A-Fa-f]{0,6}$/.test(next)) {
              onChange(next);
            }
          }}
          maxLength={7}
          placeholder="#FFFFFF"
          className="flex-1 px-2 py-1 text-xs bg-surface-raised border border-border rounded-[4px] text-text-primary font-mono focus:border-accent focus:outline-none"
        />
      </div>
    </div>
  );
}

export function RankFormModal({ initial, onSave, onClose, title, subRankTerm, forceTip, lockType }: {
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

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    onSave(form);
  }

  return (
    <ModalFrame
      rootClassName="p-4"
      panelClassName="bg-bg border border-border rounded-[6px] w-full max-w-sm p-6 overflow-y-auto max-h-[90vh]"
      ariaLabelledBy="rank-form-title"
      onBackdropClick={onClose}
    >
      <div className="flex items-center justify-between mb-5">
        <h2 id="rank-form-title" className="text-base font-semibold text-text-primary">{title}</h2>
        <button onClick={onClose} className="text-muted hover:text-text-secondary cursor-pointer">
          <X className="w-4 h-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs text-text-secondary font-medium mb-1.5">Rank name</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder={form.is_tip ? `e.g. 1 ${subRankTerm}, 2 ${subRankTerm}s` : "e.g. Blue Belt"}
            required
            className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </div>

        {forceTip === undefined && !lockType && (
          <div>
            <label className="block text-xs text-text-secondary font-medium mb-1.5">Rank type</label>
            <div className="flex gap-2">
              {([false, true] as const).map((val) => (
                <button
                  key={String(val)}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, is_tip: val }))}
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
          onChange={(hex) => setForm((f) => ({ ...f, color_hex: hex }))}
        />

        {form.is_tip && (
          <ColorPicker
            label={`${subRankTerm} color`}
            value={form.tip_color_hex}
            onChange={(hex) => setForm((f) => ({ ...f, tip_color_hex: hex }))}
          />
        )}

        <div className="flex items-center gap-3 p-3 bg-surface-raised rounded-[6px] border border-border">
          <BeltVisual
            rank={{
              ...form,
              id: "preview",
              ladder_id: "",
              studio_id: "",
              display_order: 0,
              created_at: "",
              tip_color_hex: form.is_tip ? form.tip_color_hex : undefined,
            }}
          />
          <RankBadge
            name={form.name || "Preview"}
            color={form.color_hex}
            isTip={form.is_tip}
            tipColor={form.is_tip ? form.tip_color_hex : undefined}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-text-secondary font-medium mb-1.5">Min classes</label>
            <input
              type="number"
              min={0}
              value={form.min_classes}
              onChange={(e) => setForm((f) => ({ ...f, min_classes: Number(e.target.value) }))}
              className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary font-medium mb-1.5">Min months</label>
            <input
              type="number"
              min={0}
              value={form.min_months}
              onChange={(e) => setForm((f) => ({ ...f, min_months: Number(e.target.value) }))}
              className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={form.requires_approval}
            onChange={(e) => setForm((f) => ({ ...f, requires_approval: e.target.checked }))}
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
    </ModalFrame>
  );
}
