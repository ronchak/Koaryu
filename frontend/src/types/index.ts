export interface Studio {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  logo_url: string | null;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export interface UserProfile {
  id: string;
  email: string;
  full_name: string;
}

export interface StaffRole {
  id: string;
  studio_id: string;
  user_id: string;
  role: "admin" | "instructor" | "front_desk";
  created_at: string;
}

export interface StudioCreate {
  name: string;
  timezone: string;
}

export interface StudioUpdate {
  name?: string;
  timezone?: string;
  logo_url?: string;
}

// ---- Students ----

export type StudentStatus = "active" | "trialing" | "inactive" | "paused" | "canceled";

export interface Guardian {
  id: string;
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  relation?: string;
  is_primary_contact: boolean;
}

export interface Student {
  id: string;
  studio_id: string;
  legal_first_name: string;
  legal_last_name: string;
  preferred_name?: string;
  date_of_birth?: string;
  is_minor?: boolean;
  email?: string;
  phone?: string;
  address_line1?: string;
  address_city?: string;
  address_state?: string;
  address_zip?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  emergency_contact_relation?: string;
  status: StudentStatus;
  membership_start_date?: string;
  program_id?: string;
  current_belt_rank_id?: string;
  stripe_customer_id?: string;
  notes?: string;
  tags: string[];
  guardians: Guardian[];
  created_at: string;
  updated_at: string;
}

export interface StudentListResponse {
  items: Student[];
  total: number;
  page: number;
  page_size: number;
}

export interface StudentCreate {
  legal_first_name: string;
  legal_last_name: string;
  preferred_name?: string;
  date_of_birth?: string;
  email?: string;
  phone?: string;
  address_line1?: string;
  address_city?: string;
  address_state?: string;
  address_zip?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  emergency_contact_relation?: string;
  status?: StudentStatus;
  membership_start_date?: string;
  program_id?: string;
  notes?: string;
  tags?: string[];
  guardians?: {
    first_name: string;
    last_name: string;
    email?: string;
    phone?: string;
    relation?: string;
    is_primary_contact?: boolean;
  }[];
}

// ---- CSV Import ----

export interface CsvImportRow {
  row_number: number;
  data: Record<string, string>;
  errors: string[];
  is_valid: boolean;
}

export interface CsvImportResult {
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  errors: CsvImportRow[];
  imported_count: number;
}

export interface CsvParseResponse {
  headers: string[];
  auto_mapping: Record<string, string>;
  preview_rows: Record<string, string>[];
  total_rows: number;
}

// ---- Schedule (Phase 3) ----

export interface ClassTemplate {
  id: string;
  studio_id: string;
  name: string;
  day_of_week: number; // 0=Sunday
  start_time: string;
  end_time: string;
  instructor_id?: string;
  program_id?: string;
  capacity?: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ClassSession {
  id: string;
  studio_id: string;
  template_id?: string;
  name: string;
  date: string;
  start_time: string;
  end_time: string;
  instructor_id?: string;
  program_id?: string;
  capacity?: number;
  status: "scheduled" | "in_progress" | "completed" | "canceled";
  notes?: string;
  created_at: string;
  attendance_count: number;
}

export type AttendanceStatus = "present" | "late" | "excused" | "absent";

export interface AttendanceRecord {
  id: string;
  studio_id: string;
  session_id: string;
  student_id: string;
  status: AttendanceStatus;
  checked_in_at: string;
  checked_in_by?: string;
  student_name?: string;
}

// ---- Belt Tracker (Phase 4) ----

export interface BeltLadder {
  id: string;
  studio_id: string;
  name: string;
  program_id?: string;
  created_at: string;
  updated_at: string;
  ranks: BeltRank[];
}

export interface BeltRank {
  id: string;
  ladder_id: string;
  studio_id: string;
  name: string;
  color_hex: string;
  display_order: number;
  min_classes: number;
  min_months: number;
  requires_approval: boolean;
  is_tip: boolean;
  tip_color_hex?: string;
  created_at: string;
}

export interface EligibilityEntry {
  student_id: string;
  student_name: string;
  current_rank_name?: string;
  current_rank_color?: string;
  next_rank_name?: string;
  next_rank_color?: string;
  classes_since_promo: number;
  classes_required: number;
  days_at_rank: number;
  days_required: number;
  classes_met: boolean;
  time_met: boolean;
  needs_approval: boolean;
  is_eligible: boolean;
}

export interface Promotion {
  id: string;
  studio_id: string;
  student_id: string;
  from_rank_id?: string;
  to_rank_id: string;
  promoted_by: string;
  notes?: string;
  promoted_at: string;
  student_name?: string;
  from_rank_name?: string;
  to_rank_name?: string;
}

// ---- Leads (Phase 5) ----

export type LeadSource = "walk_in" | "referral" | "social" | "search" | "website" | "other";
export type LeadStage = "inquiry" | "trial_scheduled" | "trial_completed" | "offer_sent" | "enrolled" | "closed_lost";
export type LostReason = "no_show" | "price_objection" | "timing" | "no_response" | "other";

export interface Lead {
  id: string;
  studio_id: string;
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  source: LeadSource;
  stage: LeadStage;
  program_interest?: string;
  is_minor: boolean;
  guardian_name?: string;
  guardian_email?: string;
  guardian_phone?: string;
  assigned_staff_id?: string;
  follow_up_date?: string;
  lost_reason?: LostReason;
  notes?: string;
  converted_student_id?: string;
  created_at: string;
  updated_at: string;
}

export interface LeadActivity {
  id: string;
  studio_id: string;
  lead_id: string;
  activity_type: string;
  description?: string;
  created_by?: string;
  created_at: string;
}

