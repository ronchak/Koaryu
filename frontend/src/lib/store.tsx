"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import type {
  Student, StudentCreate, StudentStatus,
  Lead, LeadSource,
  BeltRank, BeltLadder,
  ClassSession, ClassTemplate, AttendanceRecord, AttendanceStatus,
  CsvImportResult, EligibilityEntry, Promotion,
} from "@/types";
import {
  MOCK_STUDENTS,
  MOCK_SESSIONS,
  MOCK_CLASS_TEMPLATES,
  MOCK_ATTENDANCE,
  MOCK_BELT_LADDER,
  MOCK_ELIGIBILITY,
  MOCK_LEADS,
} from "@/lib/mock-data";

interface AuthProfileResponse {
  studio_id: string | null;
}

// ── Storage keys ─────────────────────────────────────────────────────────────
const KEYS = {
  students: "koaryu:students",
  leads: "koaryu:leads",
  beltRanks: "koaryu:beltRanks",
  sessions: "koaryu:sessions",
  templates: "koaryu:templates",
  attendance: "koaryu:attendance",
  studioName: "koaryu:studioName",
  subRankTerm: "koaryu:subRankTerm",
  ladderName: "koaryu:ladderName",
};

function load<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {}
  return fallback;
}

function save<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function localId() {
  return "s-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Context shape ────────────────────────────────────────────────────────────
interface StoreContextValue {
  // Config
  isPreviewMode: boolean;
  token: string | null;

  // Students
  students: Student[];
  addStudent: (data: StudentCreate) => Promise<Student>;
  updateStudent: (id: string, data: Partial<Student>) => Promise<void>;
  deleteStudents: (ids: string[]) => Promise<void>;
  importStudents: (file: File, rows: Record<string, string>[], mapping: Record<string, string>) => Promise<CsvImportResult>;
  refreshStudents: () => Promise<Student[]>;

  // Leads
  leads: Lead[];
  addLead: (data: Partial<Lead>) => Promise<void>;
  updateLead: (id: string, data: Partial<Lead>) => Promise<void>;
  deleteLead: (id: string) => Promise<void>;
  refreshLeads: () => Promise<Lead[]>;
  convertLeadToStudent: (leadId: string) => Promise<{ lead: Lead; studentId: string | null }>;

  // Belt Tracker
  beltRanks: BeltRank[];
  setBeltRanks: (ranks: BeltRank[], options?: { subRankTerm?: string }) => Promise<void>;
  ladderName: string;
  setLadderName: (name: string) => void;
  subRankTerm: string;
  setSubRankTerm: (term: string) => Promise<void>;
  eligibility: EligibilityEntry[];
  promoteStudent: (studentId: string, toRankId: string, notes?: string) => Promise<Promotion>;

  // Schedule
  sessions: ClassSession[];
  addSession: (data: Partial<ClassSession>) => Promise<void>;
  templates: ClassTemplate[];
  attendance: AttendanceRecord[];
  toggleCheckIn: (sessionId: string, studentId: string, name: string) => Promise<void>;

  // Studio
  studioName: string;
  setStudioName: (name: string) => Promise<void>;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}

// ── Provider ─────────────────────────────────────────────────────────────────
export function StoreProvider({ children }: { children: ReactNode }) {
  const isPreviewMode = process.env.NEXT_PUBLIC_PREVIEW_MODE === "true";
  const [hydrated, setHydrated] = useState(isPreviewMode);
  const [token, setToken] = useState<string | null>(null);
  const router = useRouter();
  const [supabase] = useState(() => createClient());

  // ── State ──
  const [students, setStudents] = useState<Student[]>(() =>
    isPreviewMode ? load(KEYS.students, MOCK_STUDENTS) : []
  );
  const [leads, setLeads] = useState<Lead[]>(() =>
    isPreviewMode ? load(KEYS.leads, MOCK_LEADS) : []
  );
  const [beltRanks, setBeltRanksState] = useState<BeltRank[]>(() =>
    isPreviewMode ? load(KEYS.beltRanks, MOCK_BELT_LADDER.ranks) : []
  );
  const [sessions, setSessions] = useState<ClassSession[]>(() =>
    isPreviewMode ? load(KEYS.sessions, MOCK_SESSIONS) : []
  );
  const [templates, setTemplates] = useState<ClassTemplate[]>(() =>
    isPreviewMode ? load(KEYS.templates, MOCK_CLASS_TEMPLATES) : []
  );
  const [attendance, setAttendance] = useState<AttendanceRecord[]>(() =>
    isPreviewMode ? load(KEYS.attendance, MOCK_ATTENDANCE) : []
  );
  const [studioName, setStudioNameState] = useState(() =>
    isPreviewMode ? load(KEYS.studioName, "My Studio") : ""
  );
  const [subRankTerm, setSubRankTermState] = useState(() =>
    isPreviewMode ? load(KEYS.subRankTerm, "Stripe") : "Stripe"
  );
  const [ladderName, setLadderNameState] = useState(() =>
    isPreviewMode ? load(KEYS.ladderName, "Brazilian Jiu-Jitsu") : ""
  );
  const currentLadderIdRef = useRef<string | null>(null);
  const [eligibility, setEligibility] = useState<EligibilityEntry[]>(() =>
    isPreviewMode ? MOCK_ELIGIBILITY : []
  );

  const updateCurrentLadderId = useCallback((nextLadderId: string | null) => {
    currentLadderIdRef.current = nextLadderId;
  }, []);

  const applyPrimaryLadder = useCallback((primaryLadder?: BeltLadder | null) => {
    updateCurrentLadderId(primaryLadder?.id ?? null);
    setLadderNameState(primaryLadder?.name || "");
    setSubRankTermState(primaryLadder?.sub_rank_term || "Stripe");
    setBeltRanksState(primaryLadder?.ranks || []);
  }, [updateCurrentLadderId]);

  // Authentication and Data Fetching
  useEffect(() => {
    let mounted = true;

    async function initializeLive() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;

      if (!session) {
        setHydrated(true);
        return;
      }

      setToken(session.access_token);

      try {
        const authProfile = await api.get<AuthProfileResponse>("/auth/me", session.access_token);

        if (!authProfile.studio_id) {
          if (mounted) {
            setStudioNameState("");
            setStudents([]);
            setLeads([]);
            updateCurrentLadderId(null);
            setBeltRanksState([]);
            setSessions([]);
            setTemplates([]);
            setAttendance([]);
            setEligibility([]);
            router.replace("/onboarding");
          }
          return;
        }

        const [
          studioRes,
          studentsRes,
          leadsRes,
          beltLaddersRes,
          templatesRes,
          eligibilityRes,
        ] = await Promise.all([
          api.get<{ name: string }>("/studios/current", session.access_token),
          api.get<{ items: Student[] }>("/students?page_size=200", session.access_token),
          api.get<Lead[]>("/leads", session.access_token),
          api.get<BeltLadder[]>("/belts/ladders", session.access_token),
          api.get<ClassTemplate[]>("/schedule/templates", session.access_token).catch(() => []),
          api.get<EligibilityEntry[]>("/belts/eligibility", session.access_token).catch(() => []),
        ]);

        const start = new Date();
        start.setDate(start.getDate() - 30);
        const end = new Date();
        end.setDate(end.getDate() + 60);
        const sessionsRes = await api.get<ClassSession[]>(
          `/schedule/sessions?start_date=${start.toISOString().split("T")[0]}&end_date=${end.toISOString().split("T")[0]}`,
          session.access_token
        ).catch(() => []);

        const attendanceGroups = await Promise.all(
          sessionsRes.map((sessionItem) =>
            api
              .get<AttendanceRecord[]>(
                `/schedule/sessions/${sessionItem.id}/attendance`,
                session.access_token
              )
              .catch(() => [])
          )
        );

        if (mounted) {
          const primaryLadder = beltLaddersRes[0];
          setStudioNameState(studioRes.name);
          setStudents(studentsRes.items);
          setLeads(leadsRes);
          applyPrimaryLadder(primaryLadder);
          setSessions(sessionsRes);
          setTemplates(templatesRes);
          setAttendance(attendanceGroups.flat());
          setEligibility(eligibilityRes);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (mounted && /Complete onboarding first|No studio found/i.test(message)) {
          router.replace("/onboarding");
          return;
        }
        console.error("Failed to load initial data", error);
      } finally {
        if (mounted) setHydrated(true);
      }
    }

    if (isPreviewMode) {
      return;
    }

    initializeLive();

    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        setToken(session.access_token);
      } else {
        setToken(null);
      }
    });

    return () => {
      mounted = false;
      authListener?.subscription.unsubscribe();
    };
  }, [applyPrimaryLadder, isPreviewMode, router, supabase, updateCurrentLadderId]);

  // ── Persist helpers (for preview mode) ──
  function persistStudents(next: Student[]) {
    setStudents(next);
    if (isPreviewMode) save(KEYS.students, next);
  }
  function persistLeads(next: Lead[]) {
    setLeads(next);
    if (isPreviewMode) save(KEYS.leads, next);
  }
  function persistBeltRanks(next: BeltRank[]) {
    setBeltRanksState(next);
    if (isPreviewMode) save(KEYS.beltRanks, next);
  }
  function persistSessions(next: ClassSession[]) {
    setSessions(next);
    if (isPreviewMode) save(KEYS.sessions, next);
  }
  function persistAttendance(next: AttendanceRecord[]) {
    setAttendance(next);
    if (isPreviewMode) save(KEYS.attendance, next);
  }

  // ── Students ──
  const addStudent = useCallback(async (data: StudentCreate): Promise<Student> => {
    if (isPreviewMode) {
      const newStudent: Student = {
        id: localId(),
        studio_id: "mock-studio",
        legal_first_name: data.legal_first_name,
        legal_last_name: data.legal_last_name,
        preferred_name: data.preferred_name,
        date_of_birth: data.date_of_birth,
        is_minor: data.date_of_birth ? (Date.now() - new Date(data.date_of_birth).getTime()) < 18 * 365.25 * 24 * 60 * 60 * 1000 : false,
        hold_start_date: data.hold_start_date,
        hold_end_date: data.hold_end_date,
        email: data.email,
        phone: data.phone,
        address_line1: data.address_line1,
        address_city: data.address_city,
        address_state: data.address_state,
        address_zip: data.address_zip,
        emergency_contact_name: data.emergency_contact_name,
        emergency_contact_phone: data.emergency_contact_phone,
        emergency_contact_relation: data.emergency_contact_relation,
        status: (data.status as StudentStatus) || "active",
        membership_start_date: data.membership_start_date || new Date().toISOString().split("T")[0],
        notes: data.notes,
        tags: data.tags || [],
        guardians: (data.guardians || []).map((g, i) => ({
          id: localId(),
          first_name: g.first_name,
          last_name: g.last_name,
          email: g.email,
          phone: g.phone,
          relation: g.relation,
          is_primary_contact: g.is_primary_contact ?? i === 0,
        })),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      persistStudents([newStudent, ...students]);
      return newStudent;
    } else {
      if (!token) throw new Error("Not authenticated");
      const res = await api.post<Student>("/students", data, token);
      setStudents([res, ...students]);
      return res;
    }
  }, [students, isPreviewMode, token]);

  const updateStudent = useCallback(async (id: string, data: Partial<Student>) => {
    if (isPreviewMode) {
      const next = students.map(s => s.id === id ? { ...s, ...data, updated_at: new Date().toISOString() } : s);
      persistStudents(next);
    } else {
      if (!token) throw new Error("Not authenticated");
      const res = await api.patch<Student>(`/students/${id}`, data, token);
      setStudents(students.map(s => s.id === id ? res : s));
    }
  }, [students, isPreviewMode, token]);

  const deleteStudents = useCallback(async (ids: string[]) => {
    if (isPreviewMode) {
      const idSet = new Set(ids);
      const next = students.filter(s => !idSet.has(s.id));
      persistStudents(next);
    } else {
      if (!token) throw new Error("Not authenticated");
      for (const id of ids) {
        await api.delete(`/students/${id}`, token);
      }
      const idSet = new Set(ids);
      setStudents(students.filter(s => !idSet.has(s.id)));
    }
  }, [students, isPreviewMode, token]);

  const importStudents = useCallback(async (file: File, rows: Record<string, string>[], mapping: Record<string, string>): Promise<CsvImportResult> => {
    if (isPreviewMode) {
      const newStudents: Student[] = [];
      const errors: CsvImportResult["errors"] = [];
      let validRows = 0;

      for (const [index, row] of rows.entries()) {
        const mapped: Record<string, string> = {};
        for (const [csvCol, koaryuField] of Object.entries(mapping)) {
          if (koaryuField && row[csvCol]) mapped[koaryuField] = row[csvCol];
        }

        const validStatuses: StudentStatus[] = ["active", "trialing", "inactive", "paused", "canceled"];
        const rawStatus = (mapped.status || "").toLowerCase();
        const rowErrors: string[] = [];

        if (!mapped.legal_first_name) rowErrors.push("Missing required field: first name");
        if (!mapped.legal_last_name) rowErrors.push("Missing required field: last name");
        if (mapped.status && !validStatuses.includes(rawStatus as StudentStatus)) {
          rowErrors.push(
            `Invalid status "${mapped.status}". Must be: ${validStatuses.join(", ")}`
          );
        }

        if (rowErrors.length > 0) {
          errors.push({
            row_number: index + 2,
            data: mapped,
            errors: rowErrors,
            is_valid: false,
          });
          continue;
        }

        validRows += 1;
        const status: StudentStatus = validStatuses.includes(rawStatus as StudentStatus)
          ? (rawStatus as StudentStatus)
          : "active";

        const tags = mapped.tags ? mapped.tags.split(",").map(t => t.trim()).filter(Boolean) : [];
        const dob = mapped.date_of_birth || undefined;
        const isMinor = dob ? (Date.now() - new Date(dob).getTime()) < 18 * 365.25 * 24 * 60 * 60 * 1000 : false;

        newStudents.push({
          id: localId(),
          studio_id: "mock-studio",
          legal_first_name: mapped.legal_first_name,
          legal_last_name: mapped.legal_last_name,
          preferred_name: mapped.preferred_name || undefined,
          date_of_birth: dob,
          is_minor: isMinor,
          email: mapped.email || undefined,
          phone: mapped.phone || undefined,
          address_line1: mapped.address_line1 || undefined,
          address_city: mapped.address_city || undefined,
          address_state: mapped.address_state || undefined,
          address_zip: mapped.address_zip || undefined,
          emergency_contact_name: mapped.emergency_contact_name || undefined,
          emergency_contact_phone: mapped.emergency_contact_phone || undefined,
          emergency_contact_relation: mapped.emergency_contact_relation || undefined,
          status,
          membership_start_date: mapped.membership_start_date || new Date().toISOString().split("T")[0],
          notes: mapped.notes || undefined,
          tags,
          guardians: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      if (newStudents.length > 0) {
        persistStudents([...newStudents, ...students]);
      }
      return {
        total_rows: rows.length,
        valid_rows: validRows,
        error_rows: errors.length,
        errors,
        imported_count: newStudents.length,
      };
    } else {
      if (!token) throw new Error("Not authenticated");

      const formData = new FormData();
      formData.append("file", file);

      const result = await api.postForm<CsvImportResult>(
        `/students/import/execute?mapping=${encodeURIComponent(JSON.stringify(mapping))}`,
        formData,
        token
      );

      if (result.imported_count > 0) {
        const refreshedStudents = await api
          .get<{ items: Student[] }>("/students?page_size=200", token)
          .catch(() => null);

        if (refreshedStudents) {
          setStudents(refreshedStudents.items);
        }
      }

      return result;
    }
  }, [students, isPreviewMode, token]);

  const refreshStudents = useCallback(async (): Promise<Student[]> => {
    if (isPreviewMode) {
      return students;
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const result = await api.get<{ items: Student[] }>("/students?page_size=200", token);
    setStudents(result.items);
    return result.items;
  }, [isPreviewMode, students, token]);

  // ── Leads ──
  const addLead = useCallback(async (data: Partial<Lead>) => {
    if (isPreviewMode) {
      const newLead: Lead = {
        id: localId(),
        studio_id: "mock-studio",
        first_name: data.first_name || "",
        last_name: data.last_name || "",
        email: data.email,
        phone: data.phone,
        source: (data.source as LeadSource) || "walk_in",
        stage: "inquiry",
        program_interest: data.program_interest,
        is_minor: data.is_minor || false,
        guardian_name: data.guardian_name,
        guardian_email: data.guardian_email,
        guardian_phone: data.guardian_phone,
        notes: data.notes,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      persistLeads([newLead, ...leads]);
    } else {
      if (!token) throw new Error("Not authenticated");
      const res = await api.post<Lead>("/leads", data, token);
      setLeads([res, ...leads]);
    }
  }, [leads, isPreviewMode, token]);

  const updateLead = useCallback(async (id: string, data: Partial<Lead>) => {
    if (isPreviewMode) {
      const next = leads.map(l => l.id === id ? { ...l, ...data, updated_at: new Date().toISOString() } : l);
      persistLeads(next);
    } else {
      if (!token) throw new Error("Not authenticated");
      const res = await api.patch<Lead>(`/leads/${id}`, data, token);
      setLeads(leads.map(l => l.id === id ? res : l));
    }
  }, [leads, isPreviewMode, token]);

  const deleteLead = useCallback(async (id: string) => {
    if (isPreviewMode) {
      persistLeads(leads.filter(l => l.id !== id));
    } else {
      if (!token) throw new Error("Not authenticated");
      await api.delete(`/leads/${id}`, token);
      setLeads(leads.filter(l => l.id !== id));
    }
  }, [leads, isPreviewMode, token]);

  const refreshLeads = useCallback(async (): Promise<Lead[]> => {
    if (isPreviewMode) {
      return leads;
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const result = await api.get<Lead[]>("/leads", token);
    setLeads(result);
    return result;
  }, [isPreviewMode, leads, token]);

  const refreshBelts = useCallback(async () => {
    if (isPreviewMode) {
      return;
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const [beltLaddersRes, eligibilityRes] = await Promise.all([
      api.get<BeltLadder[]>("/belts/ladders", token),
      api.get<EligibilityEntry[]>("/belts/eligibility", token).catch(() => []),
    ]);
    const primaryLadder = beltLaddersRes[0];

    applyPrimaryLadder(primaryLadder);
    setEligibility(eligibilityRes);
  }, [applyPrimaryLadder, isPreviewMode, token]);

  const ensureCurrentLadder = useCallback(async (termOverride?: string) => {
    if (isPreviewMode) {
      return {
        id: "mock-ladder",
        sub_rank_term: termOverride || subRankTerm,
      };
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    if (currentLadderIdRef.current) {
      return {
        id: currentLadderIdRef.current,
        sub_rank_term: termOverride || subRankTerm,
      };
    }

    const existingLadders = await api.get<BeltLadder[]>("/belts/ladders", token);
    const existingPrimaryLadder = existingLadders[0];

    if (existingPrimaryLadder) {
      applyPrimaryLadder(existingPrimaryLadder);
      return {
        id: existingPrimaryLadder.id,
        sub_rank_term: existingPrimaryLadder.sub_rank_term || "Stripe",
      };
    }

    const created = await api.post<BeltLadder>(
      "/belts/ladders",
      {
        name: ladderName || "Default Belt Ladder",
        sub_rank_term: termOverride || subRankTerm,
      },
      token
    );

    applyPrimaryLadder(created);
    return {
      id: created.id,
      sub_rank_term: created.sub_rank_term || termOverride || "Stripe",
    };
  }, [applyPrimaryLadder, isPreviewMode, ladderName, subRankTerm, token]);

  const convertLeadToStudent = useCallback(async (leadId: string) => {
    const lead = leads.find((item) => item.id === leadId);
    if (!lead) {
      throw new Error("Lead not found");
    }

    if (lead.converted_student_id) {
      throw new Error("This lead has already been converted.");
    }

    if (isPreviewMode) {
      const studentId = localId();
      const now = new Date().toISOString();
      const membershipStartDate = new Date().toISOString().split("T")[0];

      const newStudent: Student = {
        id: studentId,
        studio_id: "mock-studio",
        legal_first_name: lead.first_name,
        legal_last_name: lead.last_name,
        preferred_name: undefined,
        date_of_birth: undefined,
        is_minor: lead.is_minor,
        hold_start_date: undefined,
        hold_end_date: undefined,
        email: lead.email,
        phone: lead.phone,
        address_line1: undefined,
        address_city: undefined,
        address_state: undefined,
        address_zip: undefined,
        emergency_contact_name: undefined,
        emergency_contact_phone: undefined,
        emergency_contact_relation: undefined,
        status: "active",
        membership_start_date: membershipStartDate,
        program_id: undefined,
        current_belt_rank_id: undefined,
        stripe_customer_id: undefined,
        notes: lead.notes,
        tags: ["converted-lead"],
        guardians: lead.is_minor && lead.guardian_name
          ? [
              {
                id: localId(),
                first_name: lead.guardian_name.split(" ")[0] || lead.guardian_name,
                last_name: lead.guardian_name.split(" ").slice(1).join(" "),
                email: lead.guardian_email,
                phone: lead.guardian_phone,
                relation: undefined,
                is_primary_contact: true,
              },
            ]
          : [],
        created_at: now,
        updated_at: now,
      };

      const updatedLead: Lead = {
        ...lead,
        stage: "enrolled",
        converted_student_id: studentId,
        updated_at: now,
      };

      persistStudents([newStudent, ...students]);
      persistLeads(leads.map((item) => (item.id === leadId ? updatedLead : item)));

      return {
        lead: updatedLead,
        studentId,
      };
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const membershipStartDate = new Date().toISOString().split("T")[0];
    const result = await api.post<Lead>(
      `/leads/${leadId}/convert`,
      {
        status: "active",
        membership_start_date: membershipStartDate,
      },
      token
    );

    setLeads(leads.map((item) => (item.id === leadId ? result : item)));
    try {
      await refreshStudents();
    } catch (error) {
      console.error("Failed to refresh students after lead conversion", error);
    }

    return {
      lead: result,
      studentId: result.converted_student_id ?? null,
    };
  }, [isPreviewMode, leads, persistLeads, refreshStudents, students, token]);

  // ── Belt tracker ──
  const setBeltRanks = useCallback(async (ranks: BeltRank[], options?: { subRankTerm?: string }) => {
    if (isPreviewMode) {
      persistBeltRanks(ranks);
    } else {
      const desiredSubRankTerm = options?.subRankTerm?.trim() || undefined;
      const ladder = await ensureCurrentLadder(desiredSubRankTerm);
      const nextSubRankTerm = desiredSubRankTerm || ladder.sub_rank_term || "Stripe";
      const syncPayload = {
        sub_rank_term: nextSubRankTerm,
        ranks: ranks.map((rank, index) => ({
          ...(rank.id && !rank.id.startsWith("local-") ? { id: rank.id } : {}),
          name: rank.name,
          color_hex: rank.color_hex,
          display_order: index,
          min_classes: rank.min_classes,
          min_months: rank.min_months,
          requires_approval: rank.requires_approval,
          is_tip: rank.is_tip,
          tip_color_hex: rank.is_tip ? rank.tip_color_hex ?? null : null,
        })),
      };

      const syncedLadder = await api.post<BeltLadder>(
        `/belts/ladders/${ladder.id}/sync`,
        syncPayload,
        token || undefined
      );
      applyPrimaryLadder(syncedLadder);

      const refreshedEligibility = await api
        .get<EligibilityEntry[]>("/belts/eligibility", token || undefined)
        .catch(() => eligibility);
      setEligibility(refreshedEligibility);
    }
  }, [applyPrimaryLadder, eligibility, ensureCurrentLadder, isPreviewMode, token]);

  const setLadderName = useCallback((name: string) => {
    setLadderNameState(name);
    if (isPreviewMode) save(KEYS.ladderName, name);
  }, [isPreviewMode]);

  const setSubRankTerm = useCallback(async (term: string) => {
    const nextTerm = term.trim() || "Stripe";

    if (isPreviewMode) {
      setSubRankTermState(nextTerm);
      save(KEYS.subRankTerm, nextTerm);
      return;
    }

    const ladder = await ensureCurrentLadder(nextTerm);
    if (ladder.sub_rank_term !== nextTerm) {
      await api.patch(
        `/belts/ladders/${ladder.id}`,
        { sub_rank_term: nextTerm },
        token || undefined
      );
    }
    await refreshBelts();
  }, [ensureCurrentLadder, isPreviewMode, refreshBelts, token]);

  const promoteStudent = useCallback(async (studentId: string, toRankId: string, notes?: string) => {
    if (isPreviewMode) {
      const student = students.find((item) => item.id === studentId);
      if (!student) {
        throw new Error("Student not found");
      }

      const targetRank = beltRanks.find((rank) => rank.id === toRankId);
      if (!targetRank) {
        throw new Error("Target rank not found");
      }

      const now = new Date().toISOString();
      persistStudents(
        students.map((item) =>
          item.id === studentId
            ? { ...item, current_belt_rank_id: toRankId, updated_at: now }
            : item
        )
      );

      return {
        id: localId(),
        studio_id: student.studio_id,
        student_id: studentId,
        from_rank_id: student.current_belt_rank_id,
        to_rank_id: toRankId,
        promoted_by: "preview-user",
        notes,
        promoted_at: now,
        student_name: student.preferred_name || `${student.legal_first_name} ${student.legal_last_name}`,
        from_rank_name: beltRanks.find((rank) => rank.id === student.current_belt_rank_id)?.name,
        to_rank_name: targetRank.name,
      };
    }

    if (!token) {
      throw new Error("Not authenticated");
    }

    const result = await api.post<Promotion>(
      "/belts/promote",
      {
        student_id: studentId,
        to_rank_id: toRankId,
        notes,
      },
      token
    );

    await Promise.all([refreshStudents(), refreshBelts()]);
    return result;
  }, [beltRanks, isPreviewMode, persistStudents, refreshBelts, refreshStudents, students, token]);

  // ── Schedule ──
  const addSession = useCallback(async (data: Partial<ClassSession>) => {
    if (isPreviewMode) {
      const newSession: ClassSession = {
        id: localId(),
        studio_id: "mock-studio",
        name: data.name || "Untitled Class",
        date: data.date || new Date().toISOString().split("T")[0],
        start_time: data.start_time || "18:00",
        end_time: data.end_time || "19:30",
        capacity: data.capacity,
        status: "scheduled",
        created_at: new Date().toISOString(),
        attendance_count: 0,
      };
      persistSessions([...sessions, newSession]);
    } else {
      if (!token) throw new Error("Not authenticated");
      const res = await api.post<ClassSession>("/schedule/sessions", data, token);
      setSessions([...sessions, res]);
    }
  }, [sessions, isPreviewMode, token]);

  const toggleCheckIn = useCallback(async (sessionId: string, studentId: string, name: string) => {
    if (isPreviewMode) {
      const existing = attendance.find(
        a => a.session_id === sessionId && a.student_id === studentId
      );
      let next: AttendanceRecord[];
      if (existing) {
        const cycle: AttendanceStatus[] = ["present", "late", "absent"];
        const idx = cycle.indexOf(existing.status);
        if (idx === cycle.length - 1) {
          next = attendance.filter(a => a !== existing);
        } else {
          next = attendance.map(a =>
            a === existing ? { ...a, status: cycle[idx + 1] } : a
          );
        }
      } else {
        next = [
          ...attendance,
          {
            id: localId(),
            studio_id: "mock-studio",
            session_id: sessionId,
            student_id: studentId,
            status: "present" as AttendanceStatus,
            checked_in_at: new Date().toISOString(),
            student_name: name,
          },
        ];
      }
      persistAttendance(next);
    } else {
      if (!token) throw new Error("Not authenticated");

      const cycle: AttendanceStatus[] = ["present", "late", "absent"];
      const existing = attendance.find(
        (record) => record.session_id === sessionId && record.student_id === studentId
      );
      const currentIndex = existing ? cycle.indexOf(existing.status) : -1;
      const nextStatus = cycle[(currentIndex + 1 + cycle.length) % cycle.length];
      const res = await api.post<AttendanceRecord>(
        "/schedule/attendance",
        {
          session_id: sessionId,
          student_id: studentId,
          status: nextStatus,
        },
        token
      );

      setAttendance((current) => {
        const next = current.filter(
          (record) => !(record.session_id === sessionId && record.student_id === studentId)
        );
        next.push({
          ...res,
          student_name: existing?.student_name || name,
        });
        return next;
      });
    }
  }, [attendance, isPreviewMode, token]);

  // ── Studio ──
  const setStudioName = useCallback(async (name: string) => {
    if (isPreviewMode) {
      setStudioNameState(name);
      save(KEYS.studioName, name);
    } else {
      if (!token) throw new Error("Not authenticated");
      await api.patch("/studios/current", { name }, token);
      setStudioNameState(name);
    }
  }, [isPreviewMode, token]);

  // ── Value ──
  const value: StoreContextValue = {
    isPreviewMode,
    token,
    students,
    addStudent,
    updateStudent,
    deleteStudents,
    importStudents,
    refreshStudents,
    leads,
    addLead,
    updateLead,
    deleteLead,
    refreshLeads,
    convertLeadToStudent,
    beltRanks,
    setBeltRanks,
    ladderName,
    setLadderName,
    subRankTerm,
    setSubRankTerm,
    eligibility,
    promoteStudent,
    sessions,
    addSession,
    templates,
    attendance,
    toggleCheckIn,
    studioName,
    setStudioName,
  };

  if (!hydrated) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <StoreContext.Provider value={value}>
      {children}
    </StoreContext.Provider>
  );
}
