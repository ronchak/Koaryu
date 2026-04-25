"use client";

import { useState } from "react";
import type { StudentCreate } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProgramPicker } from "@/components/programs/program-picker";
import { useProgramStore } from "@/lib/store";
import { X } from "lucide-react";

interface StudentFormProps {
  onSubmit: (data: StudentCreate) => Promise<void> | void;
  onClose: () => void;
  isLoading?: boolean;
  initialData?: Partial<StudentCreate>;
}

type FormTab = "info" | "contact" | "guardian";

export function StudentForm({ onSubmit, onClose, isLoading, initialData }: StudentFormProps) {
  const { programs } = useProgramStore();
  const isEdit = !!initialData;
  const [tab, setTab] = useState<FormTab>("info");
  const [error, setError] = useState("");

  // Basic info
  const [legalFirst, setLegalFirst] = useState(initialData?.legal_first_name || "");
  const [legalLast, setLegalLast] = useState(initialData?.legal_last_name || "");
  const [preferredName, setPreferredName] = useState(initialData?.preferred_name || "");
  const [dob, setDob] = useState(initialData?.date_of_birth || "");
  const [holdStart, setHoldStart] = useState(initialData?.hold_start_date || "");
  const [holdEnd, setHoldEnd] = useState(initialData?.hold_end_date || "");
  const [status, setStatus] = useState<string>(initialData?.status || "active");
  const [membershipStart, setMembershipStart] = useState(initialData?.membership_start_date || "");
  const [programIds, setProgramIds] = useState<string[]>(
    initialData?.program_ids?.length
      ? initialData.program_ids
      : initialData?.program_id
        ? [initialData.program_id]
        : []
  );
  const [notes, setNotes] = useState(initialData?.notes || "");
  const [tags, setTags] = useState(initialData?.tags?.join(", ") || "");

  // Contact
  const [email, setEmail] = useState(initialData?.email || "");
  const [phone, setPhone] = useState(initialData?.phone || "");
  const [addressLine1, setAddressLine1] = useState(initialData?.address_line1 || "");
  const [city, setCity] = useState(initialData?.address_city || "");
  const [state, setState] = useState(initialData?.address_state || "");
  const [zip, setZip] = useState(initialData?.address_zip || "");
  const [emergencyName, setEmergencyName] = useState(initialData?.emergency_contact_name || "");
  const [emergencyPhone, setEmergencyPhone] = useState(initialData?.emergency_contact_phone || "");
  const [emergencyRelation, setEmergencyRelation] = useState(initialData?.emergency_contact_relation || "");

  // Guardian
  const g0 = initialData?.guardians?.[0];
  const [guardianFirst, setGuardianFirst] = useState(g0?.first_name || "");
  const [guardianLast, setGuardianLast] = useState(g0?.last_name || "");
  const [guardianEmail, setGuardianEmail] = useState(g0?.email || "");
  const [guardianPhone, setGuardianPhone] = useState(g0?.phone || "");
  const [guardianRelation, setGuardianRelation] = useState(g0?.relation || "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!legalFirst.trim() || !legalLast.trim()) {
      setError("First name and last name are required.");
      setTab("info");
      return;
    }

    if (holdEnd && !holdStart) {
      setError("Add a hold start date before setting a hold end date.");
      setTab("info");
      return;
    }

    if (holdStart && holdEnd && holdEnd < holdStart) {
      setError("Hold end date cannot be before the hold start date.");
      setTab("info");
      return;
    }

    const data: StudentCreate = {
      legal_first_name: legalFirst.trim(),
      legal_last_name: legalLast.trim(),
      preferred_name: preferredName.trim() || undefined,
      date_of_birth: dob || undefined,
      hold_start_date: holdStart || undefined,
      hold_end_date: holdEnd || undefined,
	      status: status as StudentCreate["status"],
      membership_start_date: membershipStart || undefined,
      program_id: programIds[0],
      program_ids: programIds,
      current_belt_rank_id: initialData?.current_belt_rank_id,
      notes: notes.trim() || undefined,
      tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      address_line1: addressLine1.trim() || undefined,
      address_city: city.trim() || undefined,
      address_state: state.trim() || undefined,
      address_zip: zip.trim() || undefined,
      emergency_contact_name: emergencyName.trim() || undefined,
      emergency_contact_phone: emergencyPhone.trim() || undefined,
      emergency_contact_relation: emergencyRelation.trim() || undefined,
      guardians:
        guardianFirst.trim()
          ? [
              {
                first_name: guardianFirst.trim(),
                last_name: guardianLast.trim(),
                email: guardianEmail.trim() || undefined,
                phone: guardianPhone.trim() || undefined,
                relation: guardianRelation.trim() || undefined,
                is_primary_contact: true,
              },
            ]
          : [],
    };

    try {
      await onSubmit(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to add student");
    }
  }

  const tabs: { id: FormTab; label: string }[] = [
    { id: "info", label: "Basic Info" },
    { id: "contact", label: "Contact" },
    { id: "guardian", label: "Guardian" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-[560px] bg-surface border border-border rounded-[6px] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary">{isEdit ? "Edit student" : "Add student"}</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-text-secondary transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab nav */}
        <div className="flex border-b border-border">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-5 py-2.5 text-sm cursor-pointer transition-all duration-150 border-b-2 -mb-px ${
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
                    value={legalFirst}
                    onChange={(e) => setLegalFirst(e.target.value)}
                    placeholder="Aiko"
                    required
                  />
                  <Input
                    label="Legal last name *"
                    value={legalLast}
                    onChange={(e) => setLegalLast(e.target.value)}
                    placeholder="Tanaka"
                    required
                  />
                </div>
                <Input
                  label="Preferred name"
                  value={preferredName}
                  onChange={(e) => setPreferredName(e.target.value)}
                  placeholder="Goes by..."
                />
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Date of birth"
                    type="date"
                    value={dob}
                    onChange={(e) => setDob(e.target.value)}
                  />
                  <Input
                    label="Membership start"
                    type="date"
                    value={membershipStart}
                    onChange={(e) => setMembershipStart(e.target.value)}
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
                      value={holdStart}
                      onChange={(e) => setHoldStart(e.target.value)}
                    />
                    <Input
                      label="Hold end"
                      type="date"
                      value={holdEnd}
                      onChange={(e) => setHoldEnd(e.target.value)}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    Students on an active hold are excluded from inactivity alerts until the hold ends.
                  </p>
                </div>
	                <div className="flex flex-col gap-1.5">
	                  <label className="text-sm text-text-secondary font-medium">Status</label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
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
	                  values={programIds}
	                  onChange={() => undefined}
	                  onChangeMany={setProgramIds}
	                />
	                <Input
                  label="Tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="youth, competition, beginner (comma-separated)"
                  hint="Separate multiple tags with commas"
                />
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-text-secondary font-medium">Notes</label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
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
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="student@email.com"
                  />
                  <Input
                    label="Phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="(555) 000-0000"
                  />
                </div>
                <Input
                  label="Address"
                  value={addressLine1}
                  onChange={(e) => setAddressLine1(e.target.value)}
                  placeholder="123 Main St"
                />
                <div className="grid grid-cols-3 gap-3">
                  <Input
                    label="City"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="San Diego"
                  />
                  <Input
                    label="State"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    placeholder="CA"
                  />
                  <Input
                    label="ZIP"
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
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
                      value={emergencyName}
                      onChange={(e) => setEmergencyName(e.target.value)}
                      placeholder="Full name"
                    />
                    <Input
                      label="Relation"
                      value={emergencyRelation}
                      onChange={(e) => setEmergencyRelation(e.target.value)}
                      placeholder="Mother, Coach..."
                    />
                  </div>
                  <div className="mt-3">
                    <Input
                      label="Emergency phone"
                      type="tel"
                      value={emergencyPhone}
                      onChange={(e) => setEmergencyPhone(e.target.value)}
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
                    value={guardianFirst}
                    onChange={(e) => setGuardianFirst(e.target.value)}
                    placeholder="Kenji"
                    disabled={isEdit}
                  />
                  <Input
                    label="Guardian last name"
                    value={guardianLast}
                    onChange={(e) => setGuardianLast(e.target.value)}
                    placeholder="Tanaka"
                    disabled={isEdit}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Email"
                    type="email"
                    value={guardianEmail}
                    onChange={(e) => setGuardianEmail(e.target.value)}
                    placeholder="guardian@email.com"
                    disabled={isEdit}
                  />
                  <Input
                    label="Phone"
                    type="tel"
                    value={guardianPhone}
                    onChange={(e) => setGuardianPhone(e.target.value)}
                    placeholder="(555) 000-0000"
                    disabled={isEdit}
                  />
                </div>
                <Input
                  label="Relation"
                  value={guardianRelation}
                  onChange={(e) => setGuardianRelation(e.target.value)}
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
      </div>
    </div>
  );
}
