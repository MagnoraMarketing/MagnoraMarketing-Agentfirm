import { TOOL_NAMES } from "./constants.js";
import { PERIOD_KEYS } from "./periods.js";

export const TOOL_DECLARATIONS = [
  {
    name: TOOL_NAMES.integrationsStatus,
    displayName: "Magnora: integration status",
    description: "List every Magnora integration (Gmail, social channels, affiliate providers) with CONNECTED / NOT_CONFIGURED / DISABLED / ERROR / EXPIRED and the exact missing credentials.",
    parametersSchema: { type: "object", properties: {} },
  },
  {
    name: TOOL_NAMES.healthReport,
    displayName: "Magnora: health report",
    description: "CEO daily report input: integration status, pending approvals, failed publish/send items, recent integration errors (agent, task, time, error, retry status) and agents failing repeatedly.",
    parametersSchema: { type: "object", properties: {} },
  },
  {
    name: TOOL_NAMES.gmailSearch,
    displayName: "Gmail: search",
    description: "Search Gmail with Gmail query syntax (e.g. 'in:inbox is:unread newer_than:1d'). Returns sender, subject, date, snippet, labels and threadId. Read-only.",
    parametersSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query" },
        maxResults: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
    },
  },
  {
    name: TOOL_NAMES.gmailGetThread,
    displayName: "Gmail: read thread",
    description: "Read a full Gmail thread as plain text (for summarising, classifying and drafting a reply). Read-only.",
    parametersSchema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
    },
  },
  {
    name: TOOL_NAMES.gmailCreateDraft,
    displayName: "Gmail: create draft",
    description: "Create a Gmail draft (never sends). For replies pass threadId and inReplyToMessageId (the Message-ID header from gmail_get_thread).",
    parametersSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        cc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body" },
        threadId: { type: "string" },
        inReplyToMessageId: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: TOOL_NAMES.gmailRequestSend,
    displayName: "Gmail: request send (approval)",
    description: "Ask the board to approve sending an existing Gmail draft. Nothing is sent until a human approves in the Magnora page. Fails if SEND permission is disabled.",
    parametersSchema: {
      type: "object",
      properties: {
        draftId: { type: "string" },
        reason: { type: "string", description: "Why this email should be sent" },
      },
      required: ["draftId", "reason"],
    },
  },
  {
    name: TOOL_NAMES.gmailModifyLabels,
    displayName: "Gmail: label / archive",
    description: "Add/remove Gmail labels or archive a message. Only works when archive/label permission is enabled. Cannot trash or mark as spam.",
    parametersSchema: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        addLabelIds: { type: "array", items: { type: "string" } },
        removeLabelIds: { type: "array", items: { type: "string" } },
        archive: { type: "boolean" },
      },
      required: ["messageId"],
    },
  },
  {
    name: TOOL_NAMES.socialListChannels,
    displayName: "Social: list channels",
    description: "List social channels with status, publish mode (with_approval/auto), max length and which agents may draft for them.",
    parametersSchema: { type: "object", properties: {} },
  },
  {
    name: TOOL_NAMES.socialSubmitPost,
    displayName: "Social: submit post",
    description: "Submit a post for one channel. With publish mode with_approval (default) it becomes PENDING APPROVAL; the board approves in the Magnora page and it is then published. Submit one call per channel/variant.",
    parametersSchema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["facebook", "instagram", "linkedin", "x"] },
        text: { type: "string" },
        link: { type: "string" },
        imageUrl: { type: "string", description: "Public https image URL (required for Instagram)" },
        scheduledFor: { type: "string", description: "Optional ISO 8601 publish time" },
        note: { type: "string", description: "Context for the approver (campaign, variant, source task)" },
      },
      required: ["channel", "text"],
    },
  },
  {
    name: TOOL_NAMES.socialPostHistory,
    displayName: "Social: post history",
    description: "Recent social posts with status (pending_approval, scheduled, published, rejected, failed) and results.",
    parametersSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
    },
  },
  {
    name: TOOL_NAMES.affiliateStats,
    displayName: "Affiliate: stats",
    description: "Read-only affiliate performance per provider (clicks, leads, conversions, sales, commission, payouts, conversion rate) for a period, compared with the previous period of equal length.",
    parametersSchema: {
      type: "object",
      properties: {
        period: { type: "string", enum: PERIOD_KEYS, default: "yesterday" },
        provider: { type: "string", description: "Optional provider key" },
      },
    },
  },
];
