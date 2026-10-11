import type * as ApiContracts from "./generated/api-contracts";

export type DashboardBootstrapResponse = ApiContracts.ApiDashboardBootstrapResponse;
export type DashboardBootstrapStudioSummary = ApiContracts.ApiDashboardBootstrapStudioSummary;
export type DashboardHome = ApiContracts.ApiDashboardHomeResponse;
export type DashboardHomeViewer = ApiContracts.ApiDashboardHomeViewer;
export type DashboardHomeStudio = ApiContracts.ApiDashboardHomeStudio;
export type DashboardHomeAttentionItem =
  ApiContracts.ApiDashboardHomeNeedsAttention["items"][number];
export type DashboardHomeSetupStep = ApiContracts.ApiDashboardHomeSetupItem["next_step"];
export type DashboardHomeClassesToday = ApiContracts.ApiDashboardHomeClassesToday;
export type DashboardHomeClassRow = ApiContracts.ApiDashboardHomeClassRow;
export type DashboardHomeStats = ApiContracts.ApiDashboardHomeStats;
export type DashboardHomeFollowUpStats = ApiContracts.ApiDashboardHomeFollowUpStats;
export type DashboardHomePromotionStats = ApiContracts.ApiDashboardHomePromotionStats;
export type DashboardHomeFollowUpRow = ApiContracts.ApiDashboardHomeFollowUpRow;
export type DashboardHomeLeadStage = ApiContracts.ApiDashboardHomeFollowUpRow["stage"];
export type DashboardHomePromotionRow = ApiContracts.ApiDashboardHomePromotionRow;
export type DashboardHomeBelt = ApiContracts.ApiDashboardHomeBelt;
export type DashboardHomeRecentStudent = ApiContracts.ApiDashboardHomeRecentStudent;
