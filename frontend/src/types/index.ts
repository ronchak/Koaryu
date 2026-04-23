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
  hold_start_date?: string | null;
  hold_end_date?: string | null;
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
  hold_start_date?: string | null;
  hold_end_date?: string | null;
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

export interface BulkStudentTagUpdateRequest {
  student_ids: string[];
  tags_to_add: string[];
  tags_to_remove?: string[];
}

export interface BulkStudentTagUpdateResponse {
  updated: number;
}

export interface BulkStudentStatusUpdateRequest {
  student_ids: string[];
  status: StudentStatus;
}

export interface BulkStudentStatusUpdateResponse {
  updated: number;
}

// ---- CSV Import ----

export interface CsvImportRow {
  row_number: number;
  data: Record<string, unknown>;
  issues: CsvImportIssue[];
  is_valid: boolean;
}

export interface CsvImportIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
  field?: string;
  value?: string;
  suggested_action?: string;
}

export interface CsvImportWarning {
  code: string;
  message: string;
  severity: "warning";
  row_numbers: number[];
  field?: string;
  values: string[];
  suggested_action?: string;
}

export interface CsvImportSetupIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  row_numbers: number[];
  values: string[];
  suggested_action?: string;
}

export interface CsvImportActionOptions {
  can_create_missing_programs: boolean;
  can_create_missing_belts: boolean;
  can_import_without_unresolved_belt: boolean;
  belt_tracker_href?: string;
}

export interface CsvImportOptions {
  create_missing_programs: boolean;
  create_missing_belts: boolean;
  import_without_unresolved_belt: boolean;
  status_alias_mode: "strict" | "normalize";
}

export interface CsvImportRequest {
  mapping: Record<string, string>;
  options: CsvImportOptions;
  import_key?: string;
  idempotency_key?: string;
}

export interface CsvImportResult {
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  rows: CsvImportRow[];
  errors?: CsvImportRow[];
  warnings: CsvImportWarning[];
  setup_issues: CsvImportSetupIssue[];
  actions_available: CsvImportActionOptions;
  created_programs: string[];
  created_ladders: string[];
  created_belts: string[];
  imported_without_belt_count: number;
  normalized_status_count: number;
  imported_count: number;
  idempotency_key?: string;
  reused_result?: boolean;
  execution_status?: "completed" | "completed_with_warnings" | "reused";
  non_critical_errors?: string[];
}

export interface CsvMappingSuggestion {
  field: string;
  confidence?: number;
  reason?: string;
  sample_values?: string[];
}

export interface CsvParseResponse {
  headers: string[];
  auto_mapping: Record<string, string>;
  preview_rows: Record<string, string>[];
  total_rows: number;
  mapping_suggestions?: Record<string, CsvMappingSuggestion>;
  warnings?: CsvImportIssue[];
  required_fields?: string[];
}

// ---- Schedule (Phase 3) ----

export interface ClassTemplate {
  id: string;
  studio_id: string;
  name: string;
  day_of_week: number; // 0=Sunday
  start_time: string;
  end_time: string;
  start_date: string;
  end_date?: string;
  instructor_id?: string;
  program_id?: string;
  capacity?: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ClassTemplateCreate {
  name: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  start_date?: string;
  end_date?: string;
  instructor_id?: string;
  program_id?: string;
  capacity?: number;
}

export interface ClassSessionCreate {
  template_id?: string;
  name: string;
  date: string;
  start_time: string;
  end_time: string;
  instructor_id?: string;
  program_id?: string;
  capacity?: number;
  notes?: string;
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

export type ClassSessionDeleteScope = "session" | "future_series";

// ---- Belt Tracker (Phase 4) ----

export interface BeltLadder {
  id: string;
  studio_id: string;
  name: string;
  program_id?: string;
  sub_rank_term: string;
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
  current_rank_id?: string;
  current_rank_name?: string;
  current_rank_color?: string;
  next_rank_id?: string;
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
  follow_up_date?: string | null;
  lost_reason?: LostReason;
  notes?: string;
  converted_student_id?: string | null;
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
