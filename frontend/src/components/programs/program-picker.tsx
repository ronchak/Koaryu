"use client";

import type { Program } from "@/types";

interface ProgramPickerProps {
  programs: Program[];
  value?: string | null;
  values?: string[];
  onChange: (programId: string | null) => void;
  onChangeMany?: (programIds: string[]) => void;
  label?: string;
  allowEmpty?: boolean;
  multiple?: boolean;
  disabled?: boolean;
}

export function ProgramPicker({
  programs,
  value,
  values,
  onChange,
  onChangeMany,
  label = "Program",
  allowEmpty = false,
  multiple = false,
  disabled = false,
}: ProgramPickerProps) {
  const activePrograms = programs.filter((program) => !program.archived_at);
  const selectedValues = values || (value ? [value] : []);

  if (multiple) {
    return (
      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-text-secondary font-medium">{label}</label>
        <div className="min-h-10 rounded-[6px] border border-border bg-surface-raised p-2">
          {activePrograms.length === 0 ? (
            <p className="px-1 py-1 text-sm text-muted">No programs available</p>
          ) : (
            <div className="grid gap-1.5">
              {activePrograms.map((program) => {
                const checked = selectedValues.includes(program.id);
                return (
                  <label key={program.id} className="flex items-center gap-2 rounded-[4px] px-1 py-1 text-sm text-text-primary">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...selectedValues, program.id]
                          : selectedValues.filter((id) => id !== program.id);
                        onChangeMany?.(Array.from(new Set(next)));
                      }}
                    />
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: program.color_hex }} />
                    <span>{program.name}</span>
                    {program.is_system ? <span className="text-xs text-muted">Protected</span> : null}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm text-text-secondary font-medium">{label}</label>
      <select
        value={value || ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
        className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        {allowEmpty ? <option value="">No program</option> : null}
        {activePrograms.map((program) => (
          <option key={program.id} value={program.id}>
            {program.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ProgramBadge({
  program,
  fallback = "Unassigned",
}: {
  program?: Program | null;
  fallback?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 border border-border bg-surface-raised px-2 py-0.5 text-xs text-text-secondary">
      <span
        className="h-2 w-2"
        style={{ backgroundColor: program?.color_hex || "#94A3B8" }}
      />
      {program?.name || fallback}
    </span>
  );
}
