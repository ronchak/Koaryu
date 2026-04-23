"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Header } from "@/components/header";
import { StatusBadge } from "@/components/students/status-badge";
import { StudentForm } from "@/components/students/student-form";
import { Button } from "@/components/ui/button";
import { useConfigStore, useStudentStore } from "@/lib/store";
import { api } from "@/lib/api";
import type { Student, StudentCreate } from "@/types";
import { AlertTriangle, ArrowLeft, Mail, Phone, User, Pencil, Trash2 } from "lucide-react";

function formatDate(d?: string) {
  if (!d) return "—";
  return new Date(`${d}T00:00:00`).toLocaleDateString("en-US", {
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

function isCurrentHold(student: Pick<Student, "status" | "hold_start_date" | "hold_end_date">) {
  const today = new Date().toISOString().split("T")[0];

  if (student.status === "paused") {
    return true;
  }

  if (!student.hold_start_date || student.hold_start_date > today) {
    return false;
  }

  if (!student.hold_end_date) {
    return true;
  }

  return student.hold_end_date >= today;
}

export default function StudentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { isPreviewMode, token } = useConfigStore();
  const { students, updateStudent, deleteStudents } = useStudentStore();
  const id = params.id as string;
  const [showEdit, setShowEdit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hydratedStudent, setHydratedStudent] = useState<Student | null>(null);
  const [isLoadingStudent, setIsLoadingStudent] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const listStudent = useMemo(
    () => students.find((s) => s.id === id),
    [students, id]
  );

  useEffect(() => {
    let mounted = true;

    async function loadStudent() {
      if (isPreviewMode || !token) {
        if (mounted) {
          setHydratedStudent(null);
          setLoadError(null);
        }
        return;
      }

      if (listStudent && listStudent.guardians.length > 0) {
        if (mounted) {
          setHydratedStudent(null);
          setLoadError(null);
        }
        return;
      }

      setIsLoadingStudent(true);
      setLoadError(null);

      try {
        const result = await api.get<Student>(`/students/${id}`, token);
        if (mounted) {
          setHydratedStudent(result);
        }
      } catch (error) {
        if (mounted) {
          setLoadError(error instanceof Error ? error.message : "Failed to load student");
        }
      } finally {
        if (mounted) {
          setIsLoadingStudent(false);
        }
      }
    }

    void loadStudent();

    return () => {
      mounted = false;
    };
  }, [id, isPreviewMode, listStudent, token]);

  const student = hydratedStudent ?? listStudent;

  if (!student && isLoadingStudent) {
    return (
      <>
        <Header title="Loading student" />
        <div className="flex-1 flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      </>
    );
  }

  if (!student) {
    return (
      <>
        <Header title="Student not found">
          <Button variant="ghost" size="sm" onClick={() => router.push("/students")}>
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </Button>
        </Header>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-sm text-text-secondary">
              {loadError || "This student doesn&apos;t exist or has been deleted."}
            </p>
          </div>
        </div>
      </>
    );
  }

  const fullName = `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`;
  const primaryGuardian = student.guardians.find((g) => g.is_primary_contact) ?? student.guardians[0];

  async function handleEdit(data: StudentCreate) {
    if (!student) return;
    setIsSaving(true);
    try {
      await updateStudent(id, {
        legal_first_name: data.legal_first_name,
        legal_last_name: data.legal_last_name,
        preferred_name: data.preferred_name,
        date_of_birth: data.date_of_birth,
        hold_start_date: data.hold_start_date ?? null,
        hold_end_date: data.hold_end_date ?? null,
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

      if (!isPreviewMode && token) {
        const freshStudent = await api.get<Student>(`/students/${id}`, token);
        setHydratedStudent(freshStudent);
      }

      setShowEdit(false);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeleteStudent() {
    setIsDeleting(true);
    setDeleteError(null);

    try {
      await deleteStudents([id]);
      router.push("/students");
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Failed to delete student.");
      setIsDeleting(false);
    }
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
        <Button variant="danger" size="sm" onClick={() => setShowDeleteConfirm(true)}>
          <Trash2 className="w-3.5 h-3.5" />
          Delete
        </Button>
      </Header>

      <div className="flex-1 p-8">
        <div className="max-w-3xl grid grid-cols-3 gap-6">
          {(showDeleteConfirm || deleteError) && (
            <div className="col-span-3 rounded-[6px] border border-danger/20 bg-danger/5 px-4 py-3">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0" />
                    <p className="text-sm font-medium text-text-primary">Delete this student?</p>
                  </div>
                  <p className="text-xs text-muted mt-1">
                    This removes {fullName} from the active roster and cannot be undone from the UI.
                  </p>
                  {deleteError ? (
                    <p className="text-xs text-danger mt-2">{deleteError}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowDeleteConfirm(false);
                      setDeleteError(null);
                    }}
                    disabled={isDeleting}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    isLoading={isDeleting}
                    onClick={handleDeleteStudent}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          )}

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
              {isCurrentHold(student) && (
                <p className="text-xs text-warning mt-2">Currently on hold</p>
              )}
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
              {(student.hold_start_date || student.hold_end_date) && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted text-xs">Hold window</span>
                  <span className="text-text-primary font-mono text-xs">
                    {student.hold_start_date ? formatDate(student.hold_start_date) : "—"} to {student.hold_end_date ? formatDate(student.hold_end_date) : "Open"}
                  </span>
                </div>
              )}
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

            {(student.hold_start_date || student.hold_end_date || student.status === "paused") && (
              <section className="bg-surface border border-border rounded-[6px] p-5">
                <h3 className="text-sm font-medium text-text-primary mb-4">Hold / Vacation</h3>
                <InfoRow
                  label="Status"
                  value={isCurrentHold(student) ? "Currently on hold" : "Hold scheduled / ended"}
                />
                <InfoRow label="Hold start" value={student.hold_start_date ? formatDate(student.hold_start_date) : undefined} />
                <InfoRow label="Hold end" value={student.hold_end_date ? formatDate(student.hold_end_date) : "Open-ended"} />
              </section>
            )}

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
          isLoading={isSaving}
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
            hold_start_date: student.hold_start_date,
            hold_end_date: student.hold_end_date,
            notes: student.notes,
            tags: student.tags,
            guardians: student.guardians.map((guardian) => ({
              first_name: guardian.first_name,
              last_name: guardian.last_name,
              email: guardian.email,
              phone: guardian.phone,
              relation: guardian.relation,
              is_primary_contact: guardian.is_primary_contact,
            })),
          }}
        />
      )}
    </>
  );
}
