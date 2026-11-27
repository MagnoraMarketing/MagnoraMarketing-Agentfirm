/**
 * Company-scoped configuration for the Magnora plugin.
 *
 * Every credential field is a Paperclip `secret_ref` (format: "secret-ref"),
 * so values live in the company secrets vault and the UI only ever shows
 * "configured / not configured". Non-secret identifiers (page id, client id,
 * publisher id) are plain strings.
 */

export type SecretRef = { type: "secret_ref"; secretId: string; version?: "latest" | number };

export type ApprovalMode = "with_approval" | "auto";
export type SendMode = "disabled" | "with_approval";

export interface GmailConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: SecretRef | null;
  sendMode: SendMode;
  allowArchive: boolean;
  allowedAgents: string[];
  draftAgents: string[];
}

export interface SocialChannelConfig {
  enabled: boolean;
  accessToken: SecretRef | null;
  publishMode: ApprovalMode;
  allowedAgents: string[];
  /** Facebook page id / Instagram business user id / LinkedIn author URN. */
  accountId: string;
  /** Graph API version ("v23.0") or LinkedIn-Version ("202609"). */
  apiVersion: string;
}

export type SocialChannelKey = "facebook" | "instagram" | "linkedin" | "x";
export const SOCIAL_CHANNEL_KEYS: SocialChannelKey[] = ["facebook", "instagram", "linkedin", "x"];

export interface JsonAffiliateProviderConfig {
  key: string;
  displayName: string;
  enabled: boolean;
  /** Official report endpoint. `{startDate}` and `{endDate}` (YYYY-MM-DD) are substituted. */
  statsUrl: string;
  apiToken: SecretRef | null;
  authHeader: string;
  authPrefix: string;
  /** Dot-path to the array of rows in the JSON response; empty = the response itself. */
  rowsPath: string;
  fields: {
    clicks: string;
    leads: string;
    conversions: string;
    sales: string;
    commission: string;
    payouts: string;
  };
  currency: string;
}

export interface AffiliateConfig {
  allowedAgents: string[];
  providers: JsonAffiliateProviderConfig[];
}

export interface MagnoraConfig {
  timezone: string;
  gmail: GmailConfig;
  social: Record<SocialChannelKey, SocialChannelConfig>;
  affiliate: AffiliateConfig;
}

const DEFAULT_SOCIAL_VERSION: Record<SocialChannelKey, string> = {
  facebook: "v23.0",
  instagram: "v23.0",
  linkedin: "202609",
  x: "2",
};

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function list(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((s) => s.trim());
}

export function parseSecretRef(value: unknown): SecretRef | null {
  const r = rec(value);
  if (r.type !== "secret_ref" || typeof r.secretId !== "string" || !r.secretId.trim()) return null;
  const version = r.version === undefined || r.version === null ? "latest" : r.version;
  if (version !== "latest" && !(typeof version === "number" && Number.isInteger(version) && version > 0)) return null;
  return { type: "secret_ref", secretId: r.secretId.trim(), version };
}

export function parseConfig(raw: Record<string, unknown> | null | undefined): MagnoraConfig {
  const root = rec(raw);
  const gmail = rec(root.gmail);
  const social = rec(root.social);
  const affiliate = rec(root.affiliate);

  const socialChannels = {} as Record<SocialChannelKey, SocialChannelConfig>;
  for (const key of SOCIAL_CHANNEL_KEYS) {
    const c = rec(social[key]);
    socialChannels[key] = {
      enabled: bool(c.enabled, false),
      accessToken: parseSecretRef(c.accessToken),
      publishMode: c.publishMode === "auto" ? "auto" : "with_approval",
      allowedAgents: list(c.allowedAgents, ["social-media", "marketing"]),
      accountId: str(c.accountId),
      apiVersion: str(c.apiVersion) || DEFAULT_SOCIAL_VERSION[key],
    };
  }

  const providers = Array.isArray(affiliate.providers) ? affiliate.providers : [];
  return {
    timezone: str(root.timezone) || "Europe/Copenhagen",
    gmail: {
      enabled: bool(gmail.enabled, false),
      clientId: str(gmail.clientId),
      clientSecret: parseSecretRef(gmail.clientSecret),
      sendMode: gmail.sendMode === "disabled" ? "disabled" : "with_approval",
      allowArchive: bool(gmail.allowArchive, false),
      allowedAgents: list(gmail.allowedAgents, ["email", "ceo"]),
      draftAgents: list(gmail.draftAgents, ["email"]),
    },
    social: socialChannels,
    affiliate: {
      allowedAgents: list(affiliate.allowedAgents, ["affiliate", "ceo"]),
      providers: providers.map((entry, index) => {
        const p = rec(entry);
        const fields = rec(p.fields);
        const key = str(p.key) || `provider-${index + 1}`;
        return {
          key,
          displayName: str(p.displayName) || key,
          enabled: bool(p.enabled, true),
          statsUrl: str(p.statsUrl),
          apiToken: parseSecretRef(p.apiToken),
          authHeader: str(p.authHeader) || "Authorization",
          authPrefix: typeof p.authPrefix === "string" ? p.authPrefix : "Bearer ",
          rowsPath: str(p.rowsPath),
          fields: {
            clicks: str(fields.clicks) || "clicks",
            leads: str(fields.leads),
            conversions: str(fields.conversions),
            sales: str(fields.sales),
            commission: str(fields.commission),
            payouts: str(fields.payouts),
          },
          currency: str(p.currency) || "DKK",
        };
      }),
    },
  };
}

/** Normalise an agent name / url key for allow-list comparisons. */
export function agentSlug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function isAgentAllowed(allowed: string[], agent: { name?: string | null; urlKey?: string | null; id?: string }): boolean {
  if (allowed.includes("*")) return true;
  const normalized = new Set(allowed.map(agentSlug));
  const candidates = [agent.name, agent.urlKey, agent.id].filter((v): v is string => typeof v === "string" && v.length > 0);
  return candidates.some((candidate) => normalized.has(agentSlug(candidate)) || normalized.has(candidate));
}

const secretRefField = (title: string, description: string) => ({
  type: "object",
  format: "secret-ref",
  title,
  description,
});

const agentsField = (title: string, defaults: string[]) => ({
  type: "array",
  title,
  description: "Agent names or URL keys allowed to use this integration. Use * for all agents.",
  items: { type: "string" },
  default: defaults,
});

function socialChannelSchema(title: string, accountIdTitle: string, versionDefault: string, versionTitle: string) {
  return {
    type: "object",
    title,
    properties: {
      enabled: { type: "boolean", title: "Enabled", default: false },
      accountId: { type: "string", title: accountIdTitle },
      accessToken: secretRefField("Access token", "Stored in Paperclip secrets. Never shown after saving."),
      publishMode: {
        type: "string",
        title: "Publish mode",
        enum: ["with_approval", "auto"],
        default: "with_approval",
        description: "with_approval: every post waits for board approval. auto: posts publish without approval.",
      },
      allowedAgents: agentsField("Agents allowed to draft posts", ["social-media", "marketing"]),
      apiVersion: { type: "string", title: versionTitle, default: versionDefault },
    },
  };
}

export const CONFIG_SCHEMA = {
  type: "object",
  properties: {
    timezone: { type: "string", title: "Report timezone", default: "Europe/Copenhagen" },
    gmail: {
      type: "object",
      title: "Gmail",
      properties: {
        enabled: { type: "boolean", title: "Enabled", default: false },
        clientId: { type: "string", title: "Google OAuth client ID" },
        clientSecret: secretRefField("Google OAuth client secret", "Create a Web OAuth client in Google Cloud Console."),
        sendMode: {
          type: "string",
          title: "SEND permission",
          enum: ["disabled", "with_approval"],
          default: "with_approval",
          description: "disabled: agents can never send. with_approval: agents can request a send that you approve.",
        },
        allowArchive: {
          type: "boolean",
          title: "Allow archive / label changes",
          default: false,
        },
        allowedAgents: agentsField("Agents allowed to read Gmail", ["email", "ceo"]),
        draftAgents: agentsField("Agents allowed to create drafts", ["email"]),
      },
    },
    social: {
      type: "object",
      title: "Social channels",
      properties: {
        facebook: socialChannelSchema("Facebook Page", "Facebook Page ID", "v23.0", "Graph API version"),
        instagram: socialChannelSchema("Instagram (business account)", "Instagram business user ID", "v23.0", "Graph API version"),
        linkedin: socialChannelSchema("LinkedIn", "Author URN (urn:li:organization:123 or urn:li:person:abc)", "202609", "LinkedIn-Version header (YYYYMM)"),
        x: socialChannelSchema("X / Twitter", "X user id (optional)", "2", "API version"),
      },
    },
    affiliate: {
      type: "object",
      title: "Affiliate",
      properties: {
        allowedAgents: agentsField("Agents allowed to read affiliate data", ["affiliate", "ceo"]),
        providers: {
          type: "array",
          title: "Affiliate providers (official report APIs)",
          items: {
            type: "object",
            properties: {
              key: { type: "string", title: "Key (e.g. partner-ads)" },
              displayName: { type: "string", title: "Display name" },
              enabled: { type: "boolean", title: "Enabled", default: true },
              statsUrl: {
                type: "string",
                title: "Report URL from the network's API documentation",
                description: "Use {startDate} and {endDate} placeholders (YYYY-MM-DD).",
              },
              apiToken: secretRefField("API token", "Read-only reporting token from the network."),
              authHeader: { type: "string", title: "Auth header name", default: "Authorization" },
              authPrefix: { type: "string", title: "Auth header prefix", default: "Bearer " },
              rowsPath: { type: "string", title: "JSON path to rows (empty = root)" },
              currency: { type: "string", title: "Currency", default: "DKK" },
              fields: {
                type: "object",
                title: "Field mapping (dot paths inside each row)",
                properties: {
                  clicks: { type: "string", title: "Clicks", default: "clicks" },
                  leads: { type: "string", title: "Leads" },
                  conversions: { type: "string", title: "Conversions" },
                  sales: { type: "string", title: "Sales amount" },
                  commission: { type: "string", title: "Commission" },
                  payouts: { type: "string", title: "Payouts" },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
