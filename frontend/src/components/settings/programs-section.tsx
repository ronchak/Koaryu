"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { Input } from "@/components/ui/input";
import { useProgramStore, useStudioStore } from "@/lib/store";
import type { Program } from "@/types";
import { Archive, Check, Plus, RefreshCw, RotateCcw, Save, Settings2 } from "lucide-react";

const COLOR_SWATCHES = ["#38BDF8", "#F59E0B", "#EF4444", "#22C55E", "#A855F7", "#94A3B8"];

function usageLabel(program: Program) {
  const usage = program.usage;
  const beltSetup = program.is_system
    ? "no belt plan"
    : usage.belt_ladder_count > 0
      ? "belt plan ready"
      : "belt plan pending";
  return `${usage.active_student_count} active students · ${usage.active_class_count} active classes · ${beltSetup}`;
}

export function ProgramsSection() {
  const { currentRole } = useStudioStore();
  const {
    programs,
    programsLoaded,
    programsLoadError,
    refreshPrograms,
    createProgram,
    updateProgram,
    archiveProgram,
    restoreProgram,
  } = useProgramStore();
  const canManage = currentRole === "admin" || currentRole === "front_desk";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(COLOR_SWATCHES[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [dismissedProgramsLoadError, setDismissedProgramsLoadError] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!programsLoaded && !programsLoadError) {
      void refreshPrograms({ includeArchived: true }).catch(() => undefined);
    }
  }, [programsLoadError, programsLoaded, refreshPrograms]);

  const sortedPrograms = useMemo(
    () => [...programs].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [programs]
  );
  const editingProgram = programs.find((program) => program.id === editingId);

  function resetForm() {
    setEditingId(null);
    setName("");
    setDescription("");
    setColor(COLOR_SWATCHES[0]);
  }

  function startEdit(program: Program) {
    setEditingId(program.id);
    setName(program.name);
    setDescription(program.description || "");
    setColor(program.color_hex || COLOR_SWATCHES[0]);
    setMessage("");
    setError("");
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Program name is required.");
      return;
    }
    setIsSaving(true);
    try {
      if (editingProgram) {
        await updateProgram(editingProgram.id, {
          name: trimmedName,
          description: description.trim() || null,
          color_hex: color,
        });
        setMessage("Program updated.");
      } else {
        await createProgram({
          name: trimmedName,
          description: description.trim() || undefined,
          color_hex: color,
          sort_order: sortedPrograms.length * 10,
        });
        setMessage("Program created.");
      }
      resetForm();
      await refreshPrograms({ includeArchived: true }).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Program could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleArchive(program: Program) {
    setError("");
    setMessage("");
    try {
      await archiveProgram(program.id);
      setMessage(`${program.name} archived.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Program could not be archived.");
    }
  }

  async function handleRestore(program: Program) {
    setError("");
    setMessage("");
    try {
      await restoreProgram(program.id);
      setMessage(`${program.name} restored.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Program could not be restored.");
    }
  }

  return (
    <section className="bg-surface p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-medium text-text-primary">Programs</h3>
            <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-muted">{programs.length}</span>
          </div>
          <p className="mt-1 text-xs text-muted">Manage the programs that appear in Belt Tracker. Each program has one rank plan.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refreshPrograms({ includeArchived: true })}>
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {canManage ? (
        <form
          onSubmit={handleSubmit}
          className="mb-4 grid min-w-0 gap-3 border-b border-border pb-4 md:grid-cols-[1fr_1fr_auto]"
          data-program-form="true"
        >
          <Input data-program-input="name" label="Program name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Brazilian Jiu-Jitsu Core" />
          <Input data-program-input="description" label="Description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional notes" />
          <div className="flex min-w-0 flex-col gap-1.5" data-program-color-field="true">
            <span className="text-sm text-text-secondary font-medium">Color</span>
            <div className="flex min-w-0 items-center gap-2" data-program-color-actions="true">
              {COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => setColor(swatch)}
                  aria-label={`Use ${swatch}`}
                  aria-pressed={color === swatch}
                  data-program-swatch={swatch}
                  title={color === swatch ? `${swatch} selected` : `Use ${swatch}`}
                  className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border transition-[border-color,box-shadow] ${
                    color === swatch
                      ? "border-accent outline outline-2 outline-offset-2 outline-[var(--operations-cobalt)]"
                      : "border-border hover:border-text-secondary"
                  }`}
                  style={{ backgroundColor: swatch }}
                >
                  {color === swatch ? (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-bg/85 text-text-primary">
                      <Check aria-hidden="true" className="h-3 w-3" strokeWidth={3} />
                    </span>
                  ) : null}
                </button>
              ))}
              <Button type="submit" size="sm" variant="primary" isLoading={isSaving} data-program-submit="true">
                {editingProgram ? <Save className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                {editingProgram ? "Save" : "Create"}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <p className="mb-4 rounded-[10px] bg-surface-raised px-3 py-2 text-xs text-muted">
          Program editing on this Admin-only settings page is available to studio admins.
        </p>
      )}

      {message ? (
        <DismissibleNotice
          tone="success"
          onDismiss={() => setMessage("")}
          className="mb-3 text-xs"
        >
          {message}
        </DismissibleNotice>
      ) : null}
      {error ? (
        <DismissibleNotice
          tone="danger"
          onDismiss={() => setError("")}
          className="mb-3 text-xs"
        >
          {error}
        </DismissibleNotice>
      ) : null}
      {programsLoadError && dismissedProgramsLoadError !== programsLoadError ? (
        <DismissibleNotice
          tone="danger"
          onDismiss={() => setDismissedProgramsLoadError(programsLoadError)}
          className="mb-3 text-xs"
        >
          {programsLoadError}
        </DismissibleNotice>
      ) : null}

      <div className="divide-y divide-border overflow-hidden rounded-[10px] bg-surface-raised/30">
        {!programsLoaded ? (
          <p className="p-4 text-sm text-muted">Loading programs...</p>
        ) : sortedPrograms.length === 0 ? (
          <p className="p-4 text-sm text-muted">No programs created yet.</p>
        ) : (
          sortedPrograms.map((program) => (
            <div key={program.id} className="flex flex-col gap-3 px-4 py-3 md:min-h-14 md:flex-row md:items-center md:justify-between md:py-1">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: program.color_hex }} />
                  <p className="font-medium text-text-primary">{program.name}</p>
                  {program.is_system ? <span className="rounded-full bg-surface-raised px-1.5 py-0.5 text-xs text-muted">Protected</span> : null}
                  {program.archived_at ? <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-xs text-warning">Archived</span> : null}
                </div>
                <div className="mt-1 grid min-w-0 gap-0.5 text-xs text-muted md:flex md:items-center md:gap-1">
                  {program.description ? (
                    <p className="min-w-0 break-words md:truncate" title={program.description}>
                      {program.description}
                    </p>
                  ) : null}
                  {program.description ? <span className="hidden shrink-0 md:inline">·</span> : null}
                  <p className="min-w-0 break-words md:truncate" title={usageLabel(program)}>
                    {usageLabel(program)}
                  </p>
                </div>
              </div>
              {canManage ? (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => startEdit(program)}>
                    Edit
                  </Button>
                  {program.archived_at ? (
                    <Button variant="secondary" size="sm" onClick={() => void handleRestore(program)}>
                      <RotateCcw className="h-3.5 w-3.5" />
                      Restore
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" disabled={program.is_system} onClick={() => void handleArchive(program)}>
                      <Archive className="h-3.5 w-3.5" />
                      Archive
                    </Button>
                  )}
                  {editingId === program.id ? <Check className="h-4 w-4 text-success" /> : null}
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
