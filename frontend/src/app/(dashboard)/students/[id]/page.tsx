"use client";

import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Header } from "@/components/header";
import { StatusBadge } from "@/components/students/status-badge";
import { StudentForm } from "@/components/students/student-form";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import type { StudentCreate } from "@/types";
import { ArrowLeft, Mail, Phone, User, Pencil } from "lucide-react";

function formatDate(d?: string) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function calculateAge(dob?: string): string {
  if (!dob) return "—";
  const diff = Date.now() - new Date(dob).getTime();
  return `${Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25))} yrs`;
}

function InfoRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-start gap-4 py-2.5 border-b border-border last:border-0">
      <span className="text-xs text-muted w-36 flex-shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-text-primary font-mono">{value || "—"}</span>
    </div>
  );
}

export default function StudentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const store = useStore();
  const id = params.id as string;
  const [showEdit, setShowEdit] = useState(false);

  const student = useMemo(
    () => store.students.find((s) => s.id === id),
    [store.students, id]
  );

  if (!student) {
    return (
      <>
        <Header title="Student not found">
          <Button variant="ghost" size="sm" onClick={() => router.push("/students")}>
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </Button>
        </Header>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-text-secondary">
            This student doesn&apos;t exist or has been deleted.
          </p>
        </div>
      </>
    );
  }

  const fullName = `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`;
  const primaryGuardian = student.guardians.find((g) => g.is_primary_contact) ?? student.guardians[0];

  function handleEdit(data: StudentCreate) {
    if (!student) return;
    store.updateStudent(id, {
      legal_first_name: data.legal_first_name,
      legal_last_name: data.legal_last_name,
      preferred_name: data.preferred_name,
      date_of_birth: data.date_of_birth,
      email: data.email,
      phone: data.phone,
      address_line1: data.address_line1,
      address_city: data.address_city,
      address_state: data.address_state,
      address_zip: data.address_zip,
      emergency_contact_name: data.emergency_contact_name,
      emergency_contact_phone: data.emergency_contact_phone,
      emergency_contact_relation: data.emergency_contact_relation,
      status: data.status || student.status,
      membership_start_date: data.membership_start_date,
      notes: data.notes,
      tags: data.tags,
    });
    setShowEdit(false);
  }

  return (
    <>
      <Header title={fullName} description="Student profile">
        <Button variant="ghost" size="sm" onClick={() => router.push("/students")}>
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to students
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setShowEdit(true)}>
          <Pencil className="w-3.5 h-3.5" />
          Edit
        </Button>
      </Header>

      <div className="flex-1 p-8">
        <div className="max-w-3xl grid grid-cols-3 gap-6">

          {/* Left col — summary card */}
          <div className="col-span-1 space-y-4">
            <div className="bg-surface border border-border rounded-[6px] p-5 text-center">
              <div className="w-16 h-16 rounded-full bg-surface-raised border border-border flex items-center justify-center mx-auto mb-3">
                <span className="text-2xl font-semibold text-text-secondary">
                  {student.legal_first_name[0]}{student.legal_last_name[0]}
                </span>
              </div>
              <p className="font-semibold text-text-primary text-base">{fullName}</p>
              {student.legal_first_name !== student.preferred_name && student.preferred_name && (
                <p className="text-xs text-muted mt-0.5">
                  Legal: {student.legal_first_name} {student.legal_last_name}
                </p>
              )}
              <div className="mt-3">
                <StatusBadge status={student.status} />
              </div>
              {student.is_minor && (
                <p className="text-xs text-warning mt-2">Minor</p>
              )}
            </div>

            <div className="bg-surface border border-border rounded-[6px] p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted text-xs">Age</span>
                <span className="text-text-primary font-mono text-xs">{calculateAge(student.date_of_birth)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted text-xs">Member since</span>
                <span className="text-text-primary font-mono text-xs">{formatDate(student.membership_start_date)}</span>
              </div>
            </div>

            {student.tags.length > 0 && (
              <div className="bg-surface border border-border rounded-[6px] p-4">
                <p className="text-xs font-medium text-text-secondary mb-2">Tags</p>
                <div className="flex flex-wrap gap-1.5">
                  {student.tags.map((tag) => (
                    <span key={tag} className="px-2 py-0.5 text-xs bg-surface-raised border border-border rounded-[4px] text-text-secondary">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right col — detail sections */}
          <div className="col-span-2 space-y-4">
            <section className="bg-surface border border-border rounded-[6px] p-5">
              <h3 className="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
                <Mail className="w-3.5 h-3.5 text-muted" />
                Contact Information
              </h3>
              <InfoRow label="Email" value={student.email} />
              <InfoRow label="Phone" value={student.phone} />
              <InfoRow
                label="Address"
                value={
                  [student.address_line1, student.address_city, student.address_state]
                    .filter(Boolean)
                    .join(", ") || undefined
                }
              />
            </section>

            <section className="bg-surface border border-border rounded-[6px] p-5">
              <h3 className="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
                <Phone className="w-3.5 h-3.5 text-muted" />
                Emergency Contact
              </h3>
              <InfoRow label="Name" value={student.emergency_contact_name} />
              <InfoRow label="Phone" value={student.emergency_contact_phone} />
              <InfoRow label="Relation" value={student.emergency_contact_relation} />
            </section>

            {student.is_minor && primaryGuardian && (
              <section className="bg-surface border border-border rounded-[6px] p-5">
                <h3 className="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
                  <User className="w-3.5 h-3.5 text-muted" />
                  Primary Guardian
                </h3>
                <InfoRow label="Name" value={`${primaryGuardian.first_name} ${primaryGuardian.last_name}`} />
                <InfoRow label="Email" value={primaryGuardian.email} />
                <InfoRow label="Phone" value={primaryGuardian.phone} />
                <InfoRow label="Relation" value={primaryGuardian.relation} />
              </section>
            )}

            {student.notes && (
              <section className="bg-surface border border-border rounded-[6px] p-5">
                <h3 className="text-sm font-medium text-text-primary mb-3">Notes</h3>
                <p className="text-sm text-text-secondary leading-relaxed">{student.notes}</p>
              </section>
            )}
          </div>
        </div>
      </div>

      {/* Edit modal */}
      {showEdit && (
        <StudentForm
          onSubmit={handleEdit}
          onClose={() => setShowEdit(false)}
          isLoading={false}
          initialData={{
            legal_first_name: student.legal_first_name,
            legal_last_name: student.legal_last_name,
            preferred_name: student.preferred_name,
            date_of_birth: student.date_of_birth,
            email: student.email,
            phone: student.phone,
            address_line1: student.address_line1,
            address_city: student.address_city,
            address_state: student.address_state,
            address_zip: student.address_zip,
            emergency_contact_name: student.emergency_contact_name,
            emergency_contact_phone: student.emergency_contact_phone,
            emergency_contact_relation: student.emergency_contact_relation,
            status: student.status,
            membership_start_date: student.membership_start_date,
            notes: student.notes,
            tags: student.tags,
          }}
        />
      )}
    </>
  );
}
