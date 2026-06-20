"use client";

import type { StudentCreate, StudentUpdate } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModalFrame } from "@/components/ui/modal-frame";
import { ProgramPicker } from "@/components/programs/program-picker";
import {
  studentFormTabs,
  useStudentFormState,
  type StudentFormInitialData,
} from "@/components/students/student-form-state";
import { useProgramStore } from "@/lib/store";
import { X } from "lucide-react";

interface StudentFormBaseProps {
  onClose: () => void;
  isLoading?: boolean;
}

type StudentFormProps =
  | (StudentFormBaseProps & {
      initialData?: undefined;
      onSubmit: (data: StudentCreate) => Promise<void> | void;
    })
  | (StudentFormBaseProps & {
      initialData: StudentFormInitialData;
      onSubmit: (data: StudentUpdate) => Promise<void> | void;
    });

export function StudentForm(props: StudentFormProps) {
  const { onClose, isLoading, initialData } = props;
  const { programs } = useProgramStore();
  const isEdit = !!initialData;
  const submitFormPayload = (data: StudentCreate | StudentUpdate) => {
    if (initialData) {
      return (props.onSubmit as (data: StudentUpdate) => Promise<void> | void)(data as StudentUpdate);
    }
    return (props.onSubmit as (data: StudentCreate) => Promise<void> | void)(data as StudentCreate);
  };
  const { error, fields, handleSubmit, setField, setTab, tab } = useStudentFormState({
    initialData,
    onSubmit: submitFormPayload,
  });
  const statusSelectId = "student-form-status";
  const notesId = "student-form-notes";

  return (
    <ModalFrame
      rootClassName="p-4"
      panelClassName="w-full max-w-[560px] bg-surface border border-border rounded-[6px] shadow-2xl"
      ariaLabelledBy="student-form-title"
      onBackdropClick={onClose}
    >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 id="student-form-title" className="text-base font-semibold text-text-primary">
            {isEdit ? "Edit student" : "Add student"}
          </h2>
          <button
            type="button"
            aria-label={isEdit ? "Close edit student dialog" : "Close add student dialog"}
            onClick={onClose}
            className="text-muted hover:text-text-secondary transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab nav */}
        <div className="flex border-b border-border">
          {studentFormTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-5 py-2.5 text-sm cursor-pointer transition-[border-color,color,background-color] duration-150 border-b-2 -mb-px ${
                tab === t.id
                  ? "text-text-primary border-accent"
                  : "text-muted border-transparent hover:text-text-secondary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit}>
          <div className="px-6 py-5 space-y-4 max-h-[60vh] overflow-y-auto">
            {/* ---- Basic Info Tab ---- */}
            {tab === "info" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Legal first name *"
                    value={fields.legalFirst}
                    onChange={(e) => setField("legalFirst", e.target.value)}
                    placeholder="Aiko"
                    required
                  />
                  <Input
                    label="Legal last name *"
                    value={fields.legalLast}
                    onChange={(e) => setField("legalLast", e.target.value)}
                    placeholder="Tanaka"
                    required
                  />
                </div>
                <Input
                  label="Preferred name"
                  value={fields.preferredName}
                  onChange={(e) => setField("preferredName", e.target.value)}
                  placeholder="Goes by..."
                />
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Date of birth"
                    type="date"
                    value={fields.dob}
                    onChange={(e) => setField("dob", e.target.value)}
                  />
                  <Input
                    label="Membership start"
                    type="date"
                    value={fields.membershipStart}
                    onChange={(e) => setField("membershipStart", e.target.value)}
                  />
                </div>
                <div className="rounded-[6px] border border-border bg-surface-raised/50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-text-secondary mb-3">
                    Hold / Vacation
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      label="Hold start"
                      type="date"
                      value={fields.holdStart}
                      onChange={(e) => setField("holdStart", e.target.value)}
                    />
                    <Input
                      label="Hold end"
                      type="date"
                      value={fields.holdEnd}
                      onChange={(e) => setField("holdEnd", e.target.value)}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    Students on an active hold are excluded from inactivity alerts until the hold ends.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={statusSelectId} className="text-sm text-text-secondary font-medium">Status</label>
                  <select
                    id={statusSelectId}
                    value={fields.status}
                    onChange={(e) => setField("status", e.target.value as typeof fields.status)}
                    className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
                  >
                    <option value="active">Active</option>
                    <option value="trialing">Trialing</option>
                    <option value="inactive">Inactive</option>
                    <option value="paused">Paused</option>
                    <option value="canceled">Canceled</option>
                  </select>
                </div>
                <ProgramPicker
                  programs={programs}
                  label="Programs"
                  multiple
                  values={fields.programIds}
                  onChange={() => undefined}
                  onChangeMany={(programIds) => setField("programIds", programIds)}
                />
                <Input
                  label="Tags"
                  value={fields.tags}
                  onChange={(e) => setField("tags", e.target.value)}
                  placeholder="youth, competition, beginner (comma-separated)"
                  hint="Separate multiple tags with commas"
                />
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={notesId} className="text-sm text-text-secondary font-medium">Notes</label>
                  <textarea
                    id={notesId}
                    value={fields.notes}
                    onChange={(e) => setField("notes", e.target.value)}
                    placeholder="Any additional notes about this student..."
                    rows={3}
                    className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none resize-none"
                  />
                </div>
              </>
            )}

            {/* ---- Contact Tab ---- */}
            {tab === "contact" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Email"
                    type="email"
                    value={fields.email}
                    onChange={(e) => setField("email", e.target.value)}
                    placeholder="student@email.com"
                  />
                  <Input
                    label="Phone"
                    type="tel"
                    value={fields.phone}
                    onChange={(e) => setField("phone", e.target.value)}
                    placeholder="(555) 000-0000"
                  />
                </div>
                <Input
                  label="Address"
                  value={fields.addressLine1}
                  onChange={(e) => setField("addressLine1", e.target.value)}
                  placeholder="123 Main St"
                />
                <div className="grid grid-cols-3 gap-3">
                  <Input
                    label="City"
                    value={fields.city}
                    onChange={(e) => setField("city", e.target.value)}
                    placeholder="San Diego"
                  />
                  <Input
                    label="State"
                    value={fields.state}
                    onChange={(e) => setField("state", e.target.value)}
                    placeholder="CA"
                  />
                  <Input
                    label="ZIP"
                    value={fields.zip}
                    onChange={(e) => setField("zip", e.target.value)}
                    placeholder="92101"
                  />
                </div>
                <div className="pt-2">
                  <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-3">
                    Emergency Contact
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      label="Name"
                      value={fields.emergencyName}
                      onChange={(e) => setField("emergencyName", e.target.value)}
                      placeholder="Full name"
                    />
                    <Input
                      label="Relation"
                      value={fields.emergencyRelation}
                      onChange={(e) => setField("emergencyRelation", e.target.value)}
                      placeholder="Mother, Coach..."
                    />
                  </div>
                  <div className="mt-3">
                    <Input
                      label="Emergency phone"
                      type="tel"
                      value={fields.emergencyPhone}
                      onChange={(e) => setField("emergencyPhone", e.target.value)}
                      placeholder="(555) 000-0000"
                    />
                  </div>
                </div>
              </>
            )}

            {/* ---- Guardian Tab ---- */}
            {tab === "guardian" && (
              <>
                <div className="p-3 bg-surface-raised rounded-[6px] border border-border mb-4">
                  <p className="text-xs text-text-secondary">
                    {isEdit
                      ? "Guardian details are shown for reference during this edit. Student profile fields save from here."
                      : "Add a parent or guardian if this student is a minor. You can add more after saving."}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Guardian first name"
                    value={fields.guardianFirst}
                    onChange={(e) => setField("guardianFirst", e.target.value)}
                    placeholder="Kenji"
                    disabled={isEdit}
                  />
                  <Input
                    label="Guardian last name"
                    value={fields.guardianLast}
                    onChange={(e) => setField("guardianLast", e.target.value)}
                    placeholder="Tanaka"
                    disabled={isEdit}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Email"
                    type="email"
                    value={fields.guardianEmail}
                    onChange={(e) => setField("guardianEmail", e.target.value)}
                    placeholder="guardian@email.com"
                    disabled={isEdit}
                  />
                  <Input
                    label="Phone"
                    type="tel"
                    value={fields.guardianPhone}
                    onChange={(e) => setField("guardianPhone", e.target.value)}
                    placeholder="(555) 000-0000"
                    disabled={isEdit}
                  />
                </div>
                <Input
                  label="Relation"
                  value={fields.guardianRelation}
                  onChange={(e) => setField("guardianRelation", e.target.value)}
                  placeholder="Mother, Father, Grandparent..."
                  disabled={isEdit}
                />
              </>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-border flex items-center justify-between">
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className={`flex gap-2 ${error ? "" : "ml-auto"}`}>
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" isLoading={isLoading}>
                {isEdit ? "Save changes" : "Add student"}
              </Button>
            </div>
          </div>
        </form>
    </ModalFrame>
  );
}
