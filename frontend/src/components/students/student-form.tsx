"use client";

import type { StudentCreate, StudentUpdate } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModalFrame } from "@/components/ui/modal-frame";
import { ProgramPicker } from "@/components/programs/program-picker";
import {
  formatPhoneInput,
  getEditableGuardian,
  studentFormTabs,
  useStudentFormState,
  type StudentFormInitialData,
} from "@/components/students/student-form-state";
import { useProgramStore, useConfigStore } from "@/lib/store";
import { studentBirthDateError } from "@/lib/student-birth-date";
import { X } from "lucide-react";

interface StudentFormBaseProps {
  onClose: () => void;
  isLoading?: boolean;
  canManageLifecycle?: boolean;
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
  const { onClose, isLoading, initialData, canManageLifecycle = true } = props;
  const { programs } = useProgramStore();
  const { businessDate } = useConfigStore();
  const isEdit = !!initialData;
  const submitFormPayload = (data: StudentCreate | StudentUpdate) => {
    if (initialData) {
      return (props.onSubmit as (data: StudentUpdate) => Promise<void> | void)(
        data as StudentUpdate,
      );
    }
    return (props.onSubmit as (data: StudentCreate) => Promise<void> | void)(data as StudentCreate);
  };
  const { error, outcomeUnknown, fields, handleSubmit, isSubmitting, setField, setTab, tab } =
    useStudentFormState({
      initialData,
      businessDate,
      includeLifecycleFields: canManageLifecycle,
      onSubmit: submitFormPayload,
    });
  const isLocked = Boolean(isLoading || isSubmitting);
  const handleClose = () => {
    if (!isLocked) onClose();
  };
  const statusSelectId = "student-form-status";
  const notesId = "student-form-notes";

  return (
    <ModalFrame
      rootClassName="p-4"
      panelClassName="w-full max-w-[600px] overflow-hidden rounded-[18px] border border-[var(--product-rule-soft,var(--border))] bg-[var(--product-lifted,var(--surface))] shadow-[var(--product-shadow-lifted)]"
      ariaLabelledBy="student-form-title"
      onBackdropClick={isLocked ? undefined : onClose}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
        <div className="min-w-0">
          <h2
            id="student-form-title"
            className="text-xl font-extrabold tracking-[-0.03em] text-text-primary"
          >
            {isEdit ? "Edit student" : "Add student"}
          </h2>
          <p className="mt-1 text-[0.8125rem] text-text-secondary">
            {isEdit
              ? "Changes save to this student's record."
              : "A name is enough to start; add contact and family details now or later."}
          </p>
        </div>
        <button
          type="button"
          aria-label={isEdit ? "Close edit student dialog" : "Close add student dialog"}
          onClick={handleClose}
          disabled={isLocked}
          className="-mr-2 inline-flex h-10 w-10 flex-none items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-[var(--hz-tile)] hover:text-text-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tab nav */}
      <div className="border-b border-[var(--product-rule-soft,var(--border))] px-5 pb-4">
        <div className="inline-flex max-w-full gap-1 overflow-x-auto rounded-[12px] bg-[var(--hz-tile,var(--surface-raised))] p-1">
          {studentFormTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              disabled={isLocked}
              aria-pressed={tab === t.id}
              className={`min-h-10 whitespace-nowrap rounded-[9px] px-4 py-2 text-sm font-semibold cursor-pointer transition-[color,background-color,box-shadow] duration-150 ${
                tab === t.id
                  ? "bg-surface text-text-primary shadow-[0_2px_8px_rgb(45_34_18/10%)]"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <fieldset disabled={isLocked} className="px-5 py-5 space-y-4 max-h-[62vh] overflow-y-auto">
          {/* ---- Basic Info Tab ---- */}
          {tab === "info" && (
            <>
              <div className={`grid gap-3 ${canManageLifecycle ? "grid-cols-2" : "grid-cols-1"}`}>
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
                  max={businessDate}
                  error={studentBirthDateError(fields.dob, businessDate)}
                  onChange={(e) => setField("dob", e.target.value)}
                />
                {canManageLifecycle ? (
                  <Input
                    label="Membership start"
                    type="date"
                    value={fields.membershipStart}
                    onChange={(e) => setField("membershipStart", e.target.value)}
                  />
                ) : null}
              </div>
              {canManageLifecycle ? (
                <div className="rounded-[12px] bg-[var(--hz-tile,var(--surface-raised))] p-4">
                  <p className="text-sm font-semibold text-text-primary mb-3">Hold or vacation</p>
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
                  <p className="mt-2 text-[0.8125rem] text-text-secondary">
                    Students on an active hold are excluded from inactivity alerts until the hold
                    ends.
                  </p>
                </div>
              ) : null}
              {canManageLifecycle ? (
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor={statusSelectId}
                    className="text-sm text-text-primary font-semibold"
                  >
                    Status
                  </label>
                  <select
                    id={statusSelectId}
                    value={fields.status}
                    onChange={(e) => setField("status", e.target.value as typeof fields.status)}
                    className="w-full min-h-10 px-3 py-2 text-sm bg-surface border border-[var(--product-rule,var(--border))] rounded-[10px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--hz-warn-wash)]"
                  >
                    <option value="active">Active</option>
                    <option value="trialing">Trial</option>
                    <option value="paused">On hold</option>
                    <option value="inactive">Inactive</option>
                    <option value="canceled">Canceled</option>
                  </select>
                </div>
              ) : null}
              {canManageLifecycle ? (
                <ProgramPicker
                  programs={programs}
                  label="Programs"
                  multiple
                  values={fields.programIds}
                  onChange={() => undefined}
                  onChangeMany={(programIds) => setField("programIds", programIds)}
                />
              ) : null}
              <Input
                label="Tags"
                value={fields.tags}
                onChange={(e) => setField("tags", e.target.value)}
                placeholder="youth, competition, beginner (comma-separated)"
                hint="Separate multiple tags with commas"
              />
              <div className="flex flex-col gap-1.5">
                <label htmlFor={notesId} className="text-sm text-text-primary font-semibold">
                  Notes
                </label>
                <textarea
                  id={notesId}
                  value={fields.notes}
                  onChange={(e) => setField("notes", e.target.value)}
                  placeholder="Any additional notes about this student..."
                  rows={3}
                  className="w-full min-h-10 px-3 py-2 text-sm bg-surface border border-[var(--product-rule,var(--border))] rounded-[10px] text-text-primary placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--hz-warn-wash)] resize-none"
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
                  onChange={(e) => setField("phone", formatPhoneInput(e.target.value))}
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
              <div className="rounded-[12px] bg-[var(--hz-tile,var(--surface-raised))] p-4">
                <p className="text-sm font-semibold text-text-primary">Emergency contact</p>
                <p className="mt-0.5 mb-3 text-[0.8125rem] text-text-secondary">
                  Who to call if something happens on the mat.
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
                    onChange={(e) => setField("emergencyPhone", formatPhoneInput(e.target.value))}
                    placeholder="(555) 000-0000"
                  />
                </div>
              </div>
            </>
          )}

          {/* ---- Guardian Tab ---- */}
          {tab === "guardian" && (
            <>
              <div className="rounded-[12px] bg-[var(--hz-tile,var(--surface-raised))] px-4 py-3">
                <p className="text-[0.8125rem] text-text-secondary">
                  {isEdit && getEditableGuardian(initialData)
                    ? "Edit this guardian's details. Changes also appear for other students linked to this guardian. Other guardian links are kept."
                    : "Add one parent or guardian for this student."}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Guardian first name"
                  value={fields.guardianFirst}
                  onChange={(e) => setField("guardianFirst", e.target.value)}
                  placeholder="Kenji"
                />
                <Input
                  label="Guardian last name"
                  value={fields.guardianLast}
                  onChange={(e) => setField("guardianLast", e.target.value)}
                  placeholder="Tanaka"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Email"
                  type="email"
                  value={fields.guardianEmail}
                  onChange={(e) => setField("guardianEmail", e.target.value)}
                  placeholder="guardian@email.com"
                />
                <Input
                  label="Phone"
                  type="tel"
                  value={fields.guardianPhone}
                  onChange={(e) => setField("guardianPhone", formatPhoneInput(e.target.value))}
                  placeholder="(555) 000-0000"
                />
              </div>
              <Input
                label="Relation"
                value={fields.guardianRelation}
                onChange={(e) => setField("guardianRelation", e.target.value)}
                placeholder="Mother, Father, Grandparent..."
              />
            </>
          )}
        </fieldset>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--product-rule-soft,var(--border))] px-5 py-4">
          {error && <p className="text-[0.8125rem] text-danger">{error}</p>}
          <div className={`flex gap-2 ${error ? "" : "ml-auto"}`}>
            <Button type="button" variant="ghost" onClick={handleClose} disabled={isLocked}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" isLoading={isLocked} disabled={outcomeUnknown}>
              {isEdit ? "Save changes" : "Add student"}
            </Button>
          </div>
        </div>
      </form>
    </ModalFrame>
  );
}
