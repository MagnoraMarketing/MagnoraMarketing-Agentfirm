export const PLUGIN_ID = "magnora.marketing-ops";
export const PLUGIN_VERSION = "0.1.0";
export const DB_NAMESPACE_SLUG = "magnora";

export const PAGE_ROUTE = "magnora";

export const SLOT_IDS = {
  page: "magnora-page",
  sidebar: "magnora-sidebar",
  dashboardWidget: "magnora-dashboard-widget",
} as const;

export const EXPORT_NAMES = {
  page: "MagnoraPage",
  sidebar: "MagnoraSidebarLink",
  dashboardWidget: "MagnoraDashboardWidget",
} as const;

export const JOB_KEYS = {
  publishScheduled: "publish-scheduled",
  integrationProbe: "integration-probe",
} as const;

export const TOOL_NAMES = {
  integrationsStatus: "integrations_status",
  healthReport: "health_report",
  gmailSearch: "gmail_search",
  gmailGetThread: "gmail_get_thread",
  gmailCreateDraft: "gmail_create_draft",
  gmailRequestSend: "gmail_request_send",
  gmailModifyLabels: "gmail_modify_labels",
  socialListChannels: "social_list_channels",
  socialSubmitPost: "social_submit_post",
  socialPostHistory: "social_post_history",
  affiliateStats: "affiliate_stats",
} as const;

export const DATA_KEYS = {
  overview: "overview",
  outbox: "outbox",
  affiliate: "affiliate",
  errors: "errors",
} as const;

export const ACTION_KEYS = {
  approve: "approve",
  reject: "reject",
  retry: "retry",
  testConnection: "test-connection",
  gmailBeginOAuth: "gmail-begin-oauth",
  gmailCompleteOAuth: "gmail-complete-oauth",
  gmailDisconnect: "gmail-disconnect",
} as const;

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Least-privilege Gmail scopes. `gmail.modify` covers read + label/archive,
 * `gmail.compose` covers drafts and sending drafts. Sending is additionally
 * gated by the plugin's approval queue and the `sendMode` setting.
 */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;
