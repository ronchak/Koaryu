"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Header } from "@/components/header";
import { StatusBadge } from "@/components/students/status-badge";
import { StudentAvatar } from "@/components/students/student-avatar";
import { StudentForm } from "@/components/students/student-form";
import { ProgramBadge } from "@/components/programs/program-picker";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { useBeltStore, useConfigStore, useProgramStore, useStudentStore } from "@/lib/store";
import { api } from "@/lib/api";
import type { BeltLadder, BeltRank, Promotion, Student, StudentCreate } from "@/types";
import { AlertTriangle, ArrowLeft, Award, Camera, Mail, Phone, User, Pencil, Trash2, X } from "lucide-react";

const STUDENT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const STUDENT_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function formatDate(d?: string) {
  if (!d) return "—";
  return new Date(`${d}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(d?: string) {
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

function validateStudentPhotoFile(file: File): string | null {
  if (!STUDENT_PHOTO_TYPES.has(file.type)) {
    return "Choose a JPG, PNG, or WebP image.";
  }

  if (file.size > STUDENT_PHOTO_MAX_BYTES) {
    return "Choose an image under 5 MB.";
  }

  return null;
}

function InfoRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-start gap-4 py-2.5 border-b border-border last:border-0">
      <span className="text-xs text-muted w-36 flex-shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-text-primary font-mono">{value || "—"}</span>
    </div>
  );
}

function RankBadge({
  name,
  colorHex,
  isTip,
  tipColorHex,
}: {
  name: string;
  colorHex?: string;
  isTip?: boolean;
  tipColorHex?: string;
}) {
  const normalized = colorHex?.toLowerCase();
  const isWhite = !normalized || normalized === "#ffffff" || normalized === "#f5f5f5";
  const background = colorHex || "#FFFFFF";

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] text-xs font-medium ${
        isWhite ? "text-text-primary border border-border" : "text-white"
      }`}
      style={{ backgroundColor: isWhite ? "transparent" : background }}
    >
      <span
        className="w-2 h-2 rounded-full border border-white/30"
        style={{ backgroundColor: background }}
      />
      {name}
      {isTip && tipColorHex ? (
        <span
          className="w-1.5 h-3 rounded-sm flex-shrink-0"
          style={{ backgroundColor: tipColorHex }}
        />
      ) : null}
    </span>
  );
}

type RankWithContext = BeltRank & { ladderName: string };

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
  const {
    students,
    studentsLoaded,
    updateStudent,
    deleteStudents,
    uploadStudentPhoto,
    deleteStudentPhoto,
  } = useStudentStore();
  const { programs } = useProgramStore();
  const {
    beltLadders: storeBeltLadders,
    promotionHistoryByStudent,
    loadPromotionHistory: loadPromotionHistoryForStudent,
  } = useBeltStore();
  const id = params.id as string;
  const [showEdit, setShowEdit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hydratedStudent, setHydratedStudent] = useState<Student | null>(null);
  const [isLoadingStudent, setIsLoadingStudent] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fallbackBeltLadders, setFallbackBeltLadders] = useState<BeltLadder[]>([]);
  const [promotionHistoryState, setPromotionHistoryState] = useState<{
    studentId: string;
    items: Promotion[];
  } | null>(null);
  const [isLoadingFallbackBeltLadders, setIsLoadingFallbackBeltLadders] = useState(false);
  const [isLoadingPromotionHistory, setIsLoadingPromotionHistory] = useState(false);
  const [beltLoadError, setBeltLoadError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [isPhotoSaving, setIsPhotoSaving] = useState(false);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  const listStudent = useMemo(
    () => students.find((s) => s.id === id),
    [students, id]
  );
  const cachedPromotionHistory = promotionHistoryByStudent[id];

  useEffect(() => {
    return () => {
      if (photoPreviewUrl) {
        URL.revokeObjectURL(photoPreviewUrl);
      }
    };
  }, [photoPreviewUrl]);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    async function loadStudent() {
      if (isPreviewMode || !token) {
        if (mounted) {
          setHydratedStudent(null);
          setLoadError(null);
          setIsLoadingStudent(false);
        }
        return;
      }

      if (listStudent) {
        if (mounted) {
          setHydratedStudent(null);
          setLoadError(null);
          setIsLoadingStudent(false);
        }
        return;
      }

      if (!studentsLoaded) {
        if (mounted) {
          setHydratedStudent(null);
          setLoadError(null);
          setIsLoadingStudent(false);
        }
        return;
      }

      setIsLoadingStudent(true);
      setLoadError(null);

      try {
        const result = await api.get<Student>(`/students/${id}`, token, {
          signal: controller.signal,
        });
        if (mounted) {
          setHydratedStudent(result);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
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
      controller.abort();
    };
  }, [id, isPreviewMode, listStudent, studentsLoaded, token]);

  useEffect(() => {
    let mounted = true;

    async function loadFallbackBeltLadders() {
      if (isPreviewMode || !token || storeBeltLadders.length > 0) {
        if (mounted) {
          setIsLoadingFallbackBeltLadders(false);
        }
        return;
      }

      setIsLoadingFallbackBeltLadders(true);
      setBeltLoadError(null);

      try {
        const laddersResult = await api.get<BeltLadder[]>("/belts/ladders", token);
        if (!mounted) return;
        setFallbackBeltLadders(laddersResult);
      } catch (error) {
        if (mounted) {
          setBeltLoadError(
            error instanceof Error ? error.message : "Failed to load belt ladder"
          );
        }
      } finally {
        if (mounted) {
          setIsLoadingFallbackBeltLadders(false);
        }
      }
    }

    void loadFallbackBeltLadders();

    return () => {
      mounted = false;
    };
  }, [isPreviewMode, storeBeltLadders.length, token]);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    async function loadStudentPromotionHistory() {
      const cachedHistory = cachedPromotionHistory;
      setPromotionHistoryState({ studentId: id, items: cachedHistory ?? [] });

      if (isPreviewMode || !token) {
        if (mounted) {
          setBeltLoadError(null);
          setIsLoadingPromotionHistory(false);
        }
        return;
      }

      setIsLoadingPromotionHistory(!cachedHistory);
      setBeltLoadError(null);

      try {
        const promotionsResult = await loadPromotionHistoryForStudent(id, {
          signal: controller.signal,
        });

        if (mounted) {
          setPromotionHistoryState({ studentId: id, items: promotionsResult });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (mounted) {
          setBeltLoadError(
            error instanceof Error ? error.message : "Failed to load belt history"
          );
        }
      } finally {
        if (mounted) {
          setIsLoadingPromotionHistory(false);
        }
      }
    }

    void loadStudentPromotionHistory();

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [cachedPromotionHistory, id, isPreviewMode, loadPromotionHistoryForStudent, token]);

  const student = hydratedStudent?.id === id ? hydratedStudent : listStudent;
  const promotionHistory = promotionHistoryState?.studentId === id
    ? promotionHistoryState.items
    : [];
  const beltLadders = storeBeltLadders.length > 0 ? storeBeltLadders : fallbackBeltLadders;
  const isLoadingBeltData = isLoadingPromotionHistory || (
    beltLadders.length === 0 && isLoadingFallbackBeltLadders
  );
  const rankById = useMemo(() => {
    const entries = beltLadders.flatMap((ladder) =>
      ladder.ranks.map((rank) => [
        rank.id,
        { ...rank, ladderName: ladder.name } satisfies RankWithContext,
      ] as const)
    );
    return new Map<string, RankWithContext>(entries);
  }, [beltLadders]);

  if (!student && (!studentsLoaded || isLoadingStudent)) {
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
  const currentRank = student.current_belt_rank_id
    ? rankById.get(student.current_belt_rank_id)
    : undefined;
  const currentLadder = currentRank
    ? beltLadders.find((ladder) => ladder.id === currentRank.ladder_id)
    : beltLadders.find((ladder) => ladder.program_id && ladder.program_id === student.program_id);
  const currentLadderRanks = currentLadder?.ranks || [];
  const activeMemberships = (student.program_memberships || []).filter(
    (membership) => membership.status !== "ended" && !membership.ended_at
  );
  const activeProgramIds = activeMemberships.length > 0
    ? activeMemberships.map((membership) => membership.program_id)
    : student.program_id
      ? [student.program_id]
      : [];
  const currentRankIndex = currentRank
    ? currentLadderRanks.findIndex((rank) => rank.id === currentRank.id)
    : -1;
  const nextRank =
    currentRankIndex >= 0 && currentRankIndex < currentLadderRanks.length - 1
      ? currentLadderRanks[currentRankIndex + 1]
      : undefined;
  const latestPromotion = promotionHistory[0];

  async function handleEdit(data: StudentCreate) {
    if (!student) return;
    setIsSaving(true);
    setActionMessage(null);
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
        program_id: data.program_id,
        program_ids: data.program_ids,
        current_belt_rank_id: data.current_belt_rank_id,
      });

      setHydratedStudent(null);

      setShowEdit(false);
      setActionMessage("Student profile updated.");
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

  async function handlePhotoSelected(file: File) {
    const validationError = validateStudentPhotoFile(file);
    if (validationError) {
      setPhotoError(validationError);
      return;
    }

    const nextPreviewUrl = URL.createObjectURL(file);
    setPhotoPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return nextPreviewUrl;
    });
    setPhotoError(null);
    setActionMessage(null);
    setIsPhotoSaving(true);

    try {
      const updated = await uploadStudentPhoto(id, file);
      setHydratedStudent(updated);
      setActionMessage("Student photo updated.");
      setPhotoPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : "Failed to update student photo.");
    } finally {
      setIsPhotoSaving(false);
      if (photoInputRef.current) {
        photoInputRef.current.value = "";
      }
    }
  }

  async function handleDeletePhoto() {
    setPhotoError(null);
    setActionMessage(null);
    setIsPhotoSaving(true);

    try {
      const updated = await deleteStudentPhoto(id);
      setHydratedStudent(updated);
      setActionMessage("Student photo removed.");
      setPhotoPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : "Failed to remove student photo.");
    } finally {
      setIsPhotoSaving(false);
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

      {actionMessage ? (
        <div className="px-8 pt-4">
          <DismissibleNotice tone="success" onDismiss={() => setActionMessage(null)}>
            {actionMessage}
          </DismissibleNotice>
        </div>
      ) : null}

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
              <StudentAvatar
                student={student}
                size="lg"
                src={photoPreviewUrl}
                className="mx-auto mb-3"
              />
              <p className="font-semibold text-text-primary text-base">{fullName}</p>
              {student.legal_first_name !== student.preferred_name && student.preferred_name && (
                <p className="text-xs text-muted mt-0.5">
                  Legal: {student.legal_first_name} {student.legal_last_name}
                </p>
              )}
              <div className="mt-3">
                <StatusBadge status={student.status} />
              </div>
              <div className="mt-3 flex items-center justify-center gap-2">
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    const selectedFile = event.target.files?.[0];
                    if (selectedFile) void handlePhotoSelected(selectedFile);
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  isLoading={isPhotoSaving}
                  onClick={() => photoInputRef.current?.click()}
                >
                  <Camera className="w-3.5 h-3.5" />
                  {student.photo_url ? "Replace" : "Upload"}
                </Button>
                {student.photo_path || student.photo_url || photoPreviewUrl ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isPhotoSaving}
                    onClick={handleDeletePhoto}
                  >
                    <X className="w-3.5 h-3.5" />
                    Remove
                  </Button>
                ) : null}
              </div>
              {photoError ? (
                <p className="text-xs text-danger mt-2">{photoError}</p>
              ) : isPhotoSaving ? (
                <p className="text-xs text-muted mt-2">Updating photo...</p>
              ) : null}
              {isCurrentHold(student) && (
                <p className="text-xs text-warning mt-2">Currently on hold</p>
              )}
              {student.is_minor && (
                <p className="text-xs text-warning mt-2">Minor</p>
              )}
              {activeProgramIds.length > 0 && (
                <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                  {activeProgramIds.map((programId) => {
                    const program = programs.find((item) => item.id === programId);
                    return program ? (
                      <ProgramBadge key={programId} program={program} />
                    ) : null;
                  })}
                </div>
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

            <div className="bg-surface border border-border rounded-[6px] p-4 space-y-3">
              <div>
                <p className="text-xs font-medium text-text-secondary mb-2">Current belt</p>
                {currentRank ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <RankBadge
                      name={currentRank.name}
                      colorHex={currentRank.color_hex}
                      isTip={currentRank.is_tip}
                      tipColorHex={currentRank.tip_color_hex}
                    />
                    <span className="text-xs text-muted">{currentRank.ladderName}</span>
                  </div>
                ) : (
                  <p className="text-sm text-text-secondary">No rank assigned</p>
                )}
              </div>

              <div className="flex justify-between text-sm">
                <span className="text-muted text-xs">Next rank</span>
                <span className="text-text-primary text-xs">
                  {nextRank ? (
                    <RankBadge
                      name={nextRank.name}
                      colorHex={nextRank.color_hex}
                      isTip={nextRank.is_tip}
                      tipColorHex={nextRank.tip_color_hex}
                    />
                  ) : currentRank ? "Top of ladder" : "—"}
                </span>
              </div>

              <div className="flex justify-between text-sm">
                <span className="text-muted text-xs">Last promotion</span>
                <span className="text-text-primary font-mono text-xs">
                  {formatDateTime(latestPromotion?.promoted_at)}
                </span>
              </div>

              <div className="flex justify-between text-sm">
                <span className="text-muted text-xs">Recorded promotions</span>
                <span className="text-text-primary font-mono text-xs">
                  {promotionHistory.length}
                </span>
              </div>

              {beltLoadError ? (
                <p className="text-xs text-warning">{beltLoadError}</p>
              ) : isLoadingBeltData ? (
                <p className="text-xs text-muted">Loading belt history…</p>
              ) : null}
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
                <Award className="w-3.5 h-3.5 text-muted" />
                Belt & Promotion History
              </h3>

              {beltLoadError ? (
                <p className="text-sm text-warning">{beltLoadError}</p>
              ) : isLoadingBeltData ? (
                <p className="text-sm text-text-secondary">Loading belt and promotion history…</p>
              ) : promotionHistory.length === 0 ? (
                <div className="space-y-2">
                  <p className="text-sm text-text-secondary">
                    No promotion history has been recorded yet.
                  </p>
                  {currentRank ? (
                    <p className="text-xs text-muted">
                      Current rank is still tracked as{" "}
                      <span className="inline-flex align-middle">
                        <RankBadge
                          name={currentRank.name}
                          colorHex={currentRank.color_hex}
                          isTip={currentRank.is_tip}
                          tipColorHex={currentRank.tip_color_hex}
                        />
                      </span>
                      {" "}on the {currentRank.ladderName} ladder.
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-4">
                  {promotionHistory.map((promotion) => {
                    const fromRank = promotion.from_rank_id
                      ? rankById.get(promotion.from_rank_id)
                      : undefined;
                    const toRank = rankById.get(promotion.to_rank_id);

                    return (
                      <div
                        key={promotion.id}
                        className="rounded-[6px] border border-border bg-surface-raised/40 px-4 py-3"
                      >
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              {fromRank ? (
                                <RankBadge
                                  name={promotion.from_rank_name || fromRank.name}
                                  colorHex={fromRank.color_hex}
                                  isTip={fromRank.is_tip}
                                  tipColorHex={fromRank.tip_color_hex}
                                />
                              ) : (
                                <span className="text-xs text-muted">Unranked</span>
                              )}
                              <span className="text-xs text-muted">→</span>
                              {toRank ? (
                                <RankBadge
                                  name={promotion.to_rank_name || toRank.name}
                                  colorHex={toRank.color_hex}
                                  isTip={toRank.is_tip}
                                  tipColorHex={toRank.tip_color_hex}
                                />
                              ) : (
                                <span className="text-xs text-text-primary">{promotion.to_rank_name || "Rank updated"}</span>
                              )}
                            </div>
                            {promotion.notes ? (
                              <p className="text-sm text-text-secondary leading-relaxed">
                                {promotion.notes}
                              </p>
                            ) : null}
                          </div>
                          <p className="text-xs text-muted font-mono">
                            {formatDateTime(promotion.promoted_at)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
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
            program_id: student.program_id,
            program_ids: activeProgramIds,
            current_belt_rank_id: student.current_belt_rank_id,
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
