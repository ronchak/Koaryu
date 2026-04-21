"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type {
  Student, StudentCreate, StudentStatus,
  Lead, LeadStage, LeadSource,
  BeltRank, BeltLadder,
  ClassSession, ClassTemplate, AttendanceRecord, AttendanceStatus,
  EligibilityEntry,
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
  // Students
  students: Student[];
  addStudent: (data: StudentCreate) => Student;
  updateStudent: (id: string, data: Partial<Student>) => void;
  deleteStudents: (ids: string[]) => void;
  importStudents: (rows: Record<string, string>[], mapping: Record<string, string>) => number;

  // Leads
  leads: Lead[];
  addLead: (data: Partial<Lead>) => void;
  updateLead: (id: string, data: Partial<Lead>) => void;
  deleteLead: (id: string) => void;

  // Belt Tracker
  beltRanks: BeltRank[];
  setBeltRanks: (ranks: BeltRank[]) => void;
  ladderName: string;
  setLadderName: (name: string) => void;
  subRankTerm: string;
  setSubRankTerm: (term: string) => void;
  eligibility: EligibilityEntry[];

  // Schedule
  sessions: ClassSession[];
  addSession: (data: Partial<ClassSession>) => void;
  templates: ClassTemplate[];
  attendance: AttendanceRecord[];
  toggleCheckIn: (sessionId: string, studentId: string, name: string) => void;

  // Studio
  studioName: string;
  setStudioName: (name: string) => void;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}

// ── Provider ─────────────────────────────────────────────────────────────────
export function StoreProvider({ children }: { children: ReactNode }) {
  // Hydration guard — don't read localStorage during SSR
  const [hydrated, setHydrated] = useState(false);

  // ── State ──
  const [students, setStudents] = useState<Student[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [beltRanks, setBeltRanksState] = useState<BeltRank[]>([]);
  const [sessions, setSessions] = useState<ClassSession[]>([]);
  const [templates] = useState<ClassTemplate[]>(MOCK_CLASS_TEMPLATES);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [studioName, setStudioNameState] = useState("My Studio");
  const [subRankTerm, setSubRankTermState] = useState("Stripe");
  const [ladderName, setLadderNameState] = useState("Brazilian Jiu-Jitsu");

  // Hydrate from localStorage on mount
  useEffect(() => {
    setStudents(load(KEYS.students, MOCK_STUDENTS));
    setLeads(load(KEYS.leads, MOCK_LEADS));
    setBeltRanksState(load(KEYS.beltRanks, MOCK_BELT_LADDER.ranks));
    setSessions(load(KEYS.sessions, MOCK_SESSIONS));
    setAttendance(load(KEYS.attendance, MOCK_ATTENDANCE));
    setStudioNameState(load(KEYS.studioName, "My Studio"));
    setSubRankTermState(load(KEYS.subRankTerm, "Stripe"));
    setLadderNameState(load(KEYS.ladderName, "Brazilian Jiu-Jitsu"));
    setHydrated(true);
  }, []);

  // ── Persist helpers ──
  function persistStudents(next: Student[]) {
    setStudents(next);
    save(KEYS.students, next);
  }
  function persistLeads(next: Lead[]) {
    setLeads(next);
    save(KEYS.leads, next);
  }
  function persistBeltRanks(next: BeltRank[]) {
    setBeltRanksState(next);
    save(KEYS.beltRanks, next);
  }
  function persistSessions(next: ClassSession[]) {
    setSessions(next);
    save(KEYS.sessions, next);
  }
  function persistAttendance(next: AttendanceRecord[]) {
    setAttendance(next);
    save(KEYS.attendance, next);
  }

  // ── Students ──
  const addStudent = useCallback((data: StudentCreate): Student => {
    const newStudent: Student = {
      id: localId(),
      studio_id: "studio-1",
      legal_first_name: data.legal_first_name,
      legal_last_name: data.legal_last_name,
      preferred_name: data.preferred_name,
      date_of_birth: data.date_of_birth,
      is_minor: data.date_of_birth ? (Date.now() - new Date(data.date_of_birth).getTime()) < 18 * 365.25 * 24 * 60 * 60 * 1000 : false,
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
    const next = [newStudent, ...students];
    persistStudents(next);
    return newStudent;
  }, [students]);

  const updateStudent = useCallback((id: string, data: Partial<Student>) => {
    const next = students.map(s => s.id === id ? { ...s, ...data, updated_at: new Date().toISOString() } : s);
    persistStudents(next);
  }, [students]);

  const deleteStudents = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    const next = students.filter(s => !idSet.has(s.id));
    persistStudents(next);
  }, [students]);

  const importStudents = useCallback((rows: Record<string, string>[], mapping: Record<string, string>): number => {
    const newStudents: Student[] = [];
    for (const row of rows) {
      const mapped: Record<string, string> = {};
      for (const [csvCol, koaryuField] of Object.entries(mapping)) {
        if (koaryuField && row[csvCol]) mapped[koaryuField] = row[csvCol];
      }
      if (!mapped.legal_first_name || !mapped.legal_last_name) continue;

      const validStatuses: StudentStatus[] = ["active", "trialing", "inactive", "paused", "canceled"];
      const rawStatus = (mapped.status || "").toLowerCase();
      const status: StudentStatus = validStatuses.includes(rawStatus as StudentStatus)
        ? (rawStatus as StudentStatus)
        : "active";

      const tags = mapped.tags ? mapped.tags.split(",").map(t => t.trim()).filter(Boolean) : [];
      const dob = mapped.date_of_birth || undefined;
      const isMinor = dob ? (Date.now() - new Date(dob).getTime()) < 18 * 365.25 * 24 * 60 * 60 * 1000 : false;

      const guardians: Student["guardians"] = [];
      if (mapped.guardian_name) {
        const parts = mapped.guardian_name.trim().split(/\s+/);
        guardians.push({
          id: localId(),
          first_name: parts[0] || "",
          last_name: parts.slice(1).join(" ") || "",
          email: mapped.guardian_email,
          phone: mapped.guardian_phone,
          relation: mapped.guardian_relation,
          is_primary_contact: true,
        });
      }

      newStudents.push({
        id: localId(),
        studio_id: "studio-1",
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
        guardians,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
    if (newStudents.length > 0) {
      const next = [...newStudents, ...students];
      persistStudents(next);
    }
    return newStudents.length;
  }, [students]);

  // ── Leads ──
  const addLead = useCallback((data: Partial<Lead>) => {
    const newLead: Lead = {
      id: localId(),
      studio_id: "studio-1",
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
    const next = [newLead, ...leads];
    persistLeads(next);
  }, [leads]);

  const updateLead = useCallback((id: string, data: Partial<Lead>) => {
    const next = leads.map(l => l.id === id ? { ...l, ...data, updated_at: new Date().toISOString() } : l);
    persistLeads(next);
  }, [leads]);

  const deleteLead = useCallback((id: string) => {
    persistLeads(leads.filter(l => l.id !== id));
  }, [leads]);

  // ── Belt tracker ──
  const setBeltRanks = useCallback((ranks: BeltRank[]) => {
    persistBeltRanks(ranks);
  }, []);

  const setLadderName = useCallback((name: string) => {
    setLadderNameState(name);
    save(KEYS.ladderName, name);
  }, []);

  const setSubRankTerm = useCallback((term: string) => {
    setSubRankTermState(term);
    save(KEYS.subRankTerm, term);
  }, []);

  // ── Schedule ──
  const addSession = useCallback((data: Partial<ClassSession>) => {
    const newSession: ClassSession = {
      id: localId(),
      studio_id: "studio-1",
      name: data.name || "Untitled Class",
      date: data.date || new Date().toISOString().split("T")[0],
      start_time: data.start_time || "18:00",
      end_time: data.end_time || "19:30",
      capacity: data.capacity,
      status: "scheduled",
      created_at: new Date().toISOString(),
      attendance_count: 0,
    };
    const next = [...sessions, newSession];
    persistSessions(next);
  }, [sessions]);

  const toggleCheckIn = useCallback((sessionId: string, studentId: string, name: string) => {
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
          studio_id: "studio-1",
          session_id: sessionId,
          student_id: studentId,
          status: "present" as AttendanceStatus,
          checked_in_at: new Date().toISOString(),
          student_name: name,
        },
      ];
    }
    persistAttendance(next);
  }, [attendance]);

  // ── Studio ──
  const setStudioName = useCallback((name: string) => {
    setStudioNameState(name);
    save(KEYS.studioName, name);
  }, []);

  // ── Value ──
  const value: StoreContextValue = {
    students,
    addStudent,
    updateStudent,
    deleteStudents,
    importStudents,
    leads,
    addLead,
    updateLead,
    deleteLead,
    beltRanks,
    setBeltRanks,
    ladderName,
    setLadderName,
    subRankTerm,
    setSubRankTerm,
    eligibility: MOCK_ELIGIBILITY,
    sessions,
    addSession,
    templates,
    attendance,
    toggleCheckIn,
    studioName,
    setStudioName,
  };

  // Don't render children until hydrated to avoid SSR/client mismatch
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
