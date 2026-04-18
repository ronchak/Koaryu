"use client";

import { useParams, useRouter } from "next/navigation";
import { useMemo } from "react";
import { Header } from "@/components/header";
import { StatusBadge } from "@/components/students/status-badge";
import { Button } from "@/components/ui/button";
import { MOCK_STUDENTS } from "@/lib/mock-data";
import { ArrowLeft, Mail, Phone, MapPin, User } from "lucide-react";

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
  const id = params.id as string;

  // In preview mode, look up from mock data
  const student = useMemo(
    () => MOCK_STUDENTS.find((s) => s.id === id),
    [id]
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

  return (
    <>
      <Header title={fullName} description={`Student profile`}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/students")}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to students
        </Button>
        <Button variant="secondary" size="sm">
          Edit
        </Button>
      </Header>

      <div className="flex-1 p-8">
        <div className="max-w-3xl grid grid-cols-3 gap-6">

          {/* Left col — summary card */}
          <div className="col-span-1 space-y-4">
            {/* Avatar + name */}
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

            {/* Quick stats */}
            <div className="bg-surface border border-border rounded-[6px] p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted text-xs">Age</span>
                <span className="text-text-primary font-mono text-xs">{calculateAge(student.date_of_birth)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted text-xs">Member since</span>
                <span className="text-text-primary font-mono text-xs">{formatDate(student.membership_start_date)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted text-xs">Belt rank</span>
                <span className="text-text-primary font-mono text-xs">—</span>
              </div>
            </div>

            {/* Tags */}
            {student.tags.length > 0 && (
              <div className="bg-surface border border-border rounded-[6px] p-4">
                <p className="text-xs font-medium text-text-secondary mb-2">Tags</p>
                <div className="flex flex-wrap gap-1.5">
                  {student.tags.map((tag) => (
                    <span
                      key={tag}
                      className="px-2 py-0.5 text-xs bg-surface-raised border border-border rounded-[4px] text-text-secondary"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right col — detail sections */}
          <div className="col-span-2 space-y-4">

            {/* Contact Info */}
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

            {/* Emergency Contact */}
            <section className="bg-surface border border-border rounded-[6px] p-5">
              <h3 className="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
                <Phone className="w-3.5 h-3.5 text-muted" />
                Emergency Contact
              </h3>
              <InfoRow label="Name" value={student.emergency_contact_name} />
              <InfoRow label="Phone" value={student.emergency_contact_phone} />
              <InfoRow label="Relation" value={student.emergency_contact_relation} />
            </section>

            {/* Guardian (minors only) */}
            {student.is_minor && primaryGuardian && (
              <section className="bg-surface border border-border rounded-[6px] p-5">
                <h3 className="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
                  <User className="w-3.5 h-3.5 text-muted" />
                  Primary Guardian
                </h3>
                <InfoRow
                  label="Name"
                  value={`${primaryGuardian.first_name} ${primaryGuardian.last_name}`}
                />
                <InfoRow label="Email" value={primaryGuardian.email} />
                <InfoRow label="Phone" value={primaryGuardian.phone} />
                <InfoRow label="Relation" value={primaryGuardian.relation} />
              </section>
            )}

            {/* Notes */}
            {student.notes && (
              <section className="bg-surface border border-border rounded-[6px] p-5">
                <h3 className="text-sm font-medium text-text-primary mb-3">Notes</h3>
                <p className="text-sm text-text-secondary leading-relaxed">{student.notes}</p>
              </section>
            )}

            {/* Placeholder tabs for future phases */}
            <section className="bg-surface border border-border rounded-[6px] p-5">
              <div className="flex gap-4 border-b border-border -mt-1 mb-4">
                {["Attendance", "Billing", "Promotions"].map((tab) => (
                  <button
                    key={tab}
                    className="text-xs text-muted pb-3 border-b-2 border-transparent cursor-not-allowed"
                  >
                    {tab} <span className="opacity-50">(Phase {tab === "Attendance" ? "3" : tab === "Billing" ? "6" : "4"})</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted text-center py-4">
                Available in a future phase.
              </p>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
