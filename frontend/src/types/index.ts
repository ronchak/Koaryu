import type * as ApiContracts from "./generated/api-contracts";

export type Studio = ApiContracts.ApiStudioResponse;
export type UserProfile = ApiContracts.ApiUserProfile;
export type AuthResponse = ApiContracts.ApiAuthResponse;

export type StaffRoleName = ApiContracts.ApiStaffMemberResponse["role"];
export type StaffStatus = ApiContracts.ApiStaffMemberResponse["status"];

export interface StaffRole {
  id: string;
  studio_id: string;
  user_id: string;
  role: StaffRoleName;
  created_at: string;
  updated_at?: string;
  invited_by?: string | null;
  invited_email?: string | null;
}

export type StaffMember = ApiContracts.ApiStaffMemberResponse;
export type StaffInviteCreate = ApiContracts.ApiStaffInviteCreate;
export type StaffRoleUpdate = ApiContracts.ApiStaffRoleUpdate;

export * from "./dashboard";

// ---- Support ----

export type SupportTicketTopic = ApiContracts.ApiSupportTicketResponse["topic"];
export type SupportTicketSeverity = ApiContracts.ApiSupportTicketResponse["severity"];
export type SupportTicketStatus = ApiContracts.ApiSupportTicketResponse["status"];
export type SupportTicketCreate = ApiContracts.ApiSupportTicketCreate;
export type SupportTicket = ApiContracts.ApiSupportTicketResponse;

// ---- Account ----

export type AccountDeletionStatus = ApiContracts.ApiAccountDeletionRequestResponse["status"];
export type AccountDeletionRequest = ApiContracts.ApiAccountDeletionRequestResponse;

// ---- Billing ----

export type SubscriptionStatus = ApiContracts.ApiPlatformBillingStatusResponse["status"];
export type BillingSubscriptionStatus = ApiContracts.ApiBillingSubscriptionResponse["status"];
export type PaymentAccountStatus = ApiContracts.ApiStudioPaymentAccountResponse["status"];
export type ConnectBusinessEntityType = NonNullable<ApiContracts.ApiConnectOnboardingLinkRequest["business_entity_type"]>;

export type BillingPlanStatus = ApiContracts.ApiBillingPlanResponse["status"];
export type BillingInterval = ApiContracts.ApiBillingPlanResponse["billing_interval"];
export type PayerBillingStatus = ApiContracts.ApiBillingPayerResponse["billing_status"];
export type AutopayStatus = ApiContracts.ApiBillingPayerResponse["autopay_status"];
export type BillingCollectionMode = ApiContracts.ApiStudentBillingEnrollmentResponse["collection_mode"];
export type BillingEnrollmentStatus = ApiContracts.ApiStudentBillingEnrollmentResponse["status"];
export type InvoiceStatus = ApiContracts.ApiBillingInvoiceResponse["status"];
export type PaymentStatus = ApiContracts.ApiBillingPaymentResponse["status"];

export type BillingLinkResponse = ApiContracts.ApiBillingLinkResponse;
export type BillingActionRequest =
  & ApiContracts.ApiConnectOnboardingLinkRequest
  & ApiContracts.ApiPlatformCheckoutRequest
  & ApiContracts.ApiPlatformPortalRequest;
export type EmailUsage = ApiContracts.ApiEmailUsageResponse;
export type PlatformBillingStatus = ApiContracts.ApiPlatformBillingStatusResponse;
export type StudioPaymentAccount = ApiContracts.ApiStudioPaymentAccountResponse;
export type BillingPlanProgram = ApiContracts.ApiBillingPlanProgramResponse;
export type BillingPlan = ApiContracts.ApiBillingPlanResponse;
export type BillingPlanCreate = ApiContracts.ApiBillingPlanCreate;
export type BillingPayer = ApiContracts.ApiBillingPayerResponse;
export type BillingPayerCreate = ApiContracts.ApiBillingPayerCreate;
export type BillingSubscription = ApiContracts.ApiBillingSubscriptionResponse;
export type StudentBillingEnrollment = ApiContracts.ApiStudentBillingEnrollmentResponse;
export type StudentBillingEnrollmentCreate = ApiContracts.ApiStudentBillingEnrollmentCreate;
export type StudentBillingEnrollmentUpdate = ApiContracts.ApiStudentBillingEnrollmentUpdate;
export type BillingInvoice = ApiContracts.ApiBillingInvoiceResponse;
export type BillingInvoiceCreate = ApiContracts.ApiBillingInvoiceCreate;
export type BillingPayment = ApiContracts.ApiBillingPaymentResponse;
export type ExternalPaymentCreate = ApiContracts.ApiExternalPaymentCreate;
export type ExportJob = ApiContracts.ApiExportJobResponse;

// ---- Programs ----

export type ProgramUsage = ApiContracts.ApiProgramUsageResponse;
export type Program = ApiContracts.ApiProgramResponse;
export type ProgramCreate = ApiContracts.ApiProgramCreate;
export type ProgramUpdate = ApiContracts.ApiProgramUpdate;
export type StudioCreate = ApiContracts.ApiStudioCreate;
export type StudioUpdate = ApiContracts.ApiStudioUpdate;

// ---- Students ----

export type StudentStatus = ApiContracts.ApiStudentResponse["status"];
export type Guardian = ApiContracts.ApiGuardianResponse;
export type GuardianCreate = ApiContracts.ApiGuardianCreate;
export type StudentProgramMembership = ApiContracts.ApiStudentProgramMembershipResponse;
export type Student = ApiContracts.ApiStudentResponse;
export type StudentListResponse = ApiContracts.ApiStudentListResponse;
export type StudentListQueryContract = ApiContracts.ApiStudentListQueryContract;
export type StudentCreate = ApiContracts.ApiStudentCreate;
export type StudentUpdate = ApiContracts.ApiStudentUpdate;
export type BulkStudentTagUpdateRequest = ApiContracts.ApiBulkTagUpdate;
export type BulkStudentTagUpdateResponse = ApiContracts.ApiBulkStudentUpdateResponse;

export type BulkStudentStatusUpdateRequest = ApiContracts.ApiBulkStatusUpdate;
export type BulkStudentStatusUpdateResponse = ApiContracts.ApiBulkStudentUpdateResponse;

// ---- CSV Import ----

export type CsvImportRow = ApiContracts.ApiCsvImportRow;
export type CsvImportIssue = ApiContracts.ApiCsvImportIssue;
export type CsvImportWarning = ApiContracts.ApiCsvImportWarning;
export type CsvImportSetupIssue = ApiContracts.ApiCsvImportSetupIssue;
export type CsvImportActionOptions = ApiContracts.ApiCsvImportActionOptions;
export type CsvImportOptions = ApiContracts.ApiCsvImportOptions;
export type CsvImportRequest = ApiContracts.ApiCsvImportRequest;
export type CsvImportResult = ApiContracts.ApiCsvImportResult;
export type CsvMappingSuggestion = ApiContracts.ApiCsvMappingSuggestion;
export type CsvParseResponse = ApiContracts.ApiCsvParseResponse;

// ---- Schedule (Phase 3) ----

export type ClassTemplate = ApiContracts.ApiClassTemplateResponse;
export type ClassTemplateCreate = ApiContracts.ApiClassTemplateCreate;
export type ClassSessionCreate = ApiContracts.ApiClassSessionCreate;
export type ClassSession = ApiContracts.ApiClassSessionResponse;
export type AttendanceStatus = ApiContracts.ApiAttendanceResponse["status"];
export type AttendanceRecord = ApiContracts.ApiAttendanceResponse;

export type ClassSessionDeleteScope = ApiContracts.ApiClassSessionDeleteScope["scope"];

// ---- Belt Tracker (Phase 4) ----

export type BeltLadder = ApiContracts.ApiBeltLadderResponse;
export type BeltRank = ApiContracts.ApiBeltRankResponse;
export type EligibilityEntry = ApiContracts.ApiEligibilityEntry;
export type Promotion = ApiContracts.ApiPromotionResponse;

// ---- Leads (Phase 5) ----

export type LeadSource = ApiContracts.ApiLeadResponse["source"];
export type LeadStage = ApiContracts.ApiLeadResponse["stage"];
export type LostReason = NonNullable<ApiContracts.ApiLeadResponse["lost_reason"]>;
export type Lead = ApiContracts.ApiLeadResponse;
export type LeadCreate = ApiContracts.ApiLeadCreate;
export type LeadUpdate = ApiContracts.ApiLeadUpdate;
export type LeadActivity = ApiContracts.ApiLeadActivityResponse;
