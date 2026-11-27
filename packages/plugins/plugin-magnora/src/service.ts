import { JsonAffiliateProvider } from "./affiliate/json-provider.js";
import { emptyStats, type AffiliateProvider, type AffiliateStats } from "./affiliate/types.js";
import { isAgentAllowed, parseConfig, SOCIAL_CHANNEL_KEYS, type MagnoraConfig, type SecretRef, type SocialChannelKey } from "./config.js";
import { decryptToken, encryptToken, randomToken } from "./crypto.js";
import {
  buildGoogleAuthUrl,
  buildRawMessage,
  draftSummary,
  exchangeAuthorizationCode,
  GmailClient,
  refreshAccessToken,
} from "./gmail/gmail.js";
import { IntegrationError, redact, type FetchFn } from "./http.js";
import { previousRange, resolvePeriod, type PeriodKey } from "./periods.js";
import { createChannel, type SocialPost } from "./social/channels.js";
import type { MagnoraStore, OutboxItem, OutboxKind, OutboxStatus } from "./store.js";

export type IntegrationState = "CONNECTED" | "NOT_CONFIGURED" | "DISABLED" | "ERROR" | "EXPIRED";

export interface IntegrationStatus {
  key: string;
  label: string;
  category: "email" | "social" | "affiliate";
  state: IntegrationState;
  detail: string;
  missing: string[];
}

export interface AgentInfo {
  id: string;
  name: string;
  urlKey?: string | null;
}

export interface ServiceDeps {
  store: MagnoraStore;
  fetch: FetchFn;
  getConfig(companyId: string): Promise<Record<string, unknown>>;
  resolveSecret(ref: SecretRef, companyId: string, configPath: string): Promise<string>;
  getAgent(agentId: string, companyId: string): Promise<AgentInfo | null>;
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void;
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

const ACCESS_TOKEN_SKEW_MS = 60_000;

export class MagnoraService {
  private accessTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly deps: ServiceDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async config(companyId: string): Promise<MagnoraConfig> {
    return parseConfig(await this.deps.getConfig(companyId));
  }

  // ---------------------------------------------------------------- agents

  async requireAgent(companyId: string, agentId: string, allowed: string[], capability: string): Promise<AgentInfo> {
    const agent = await this.deps.getAgent(agentId, companyId);
    if (!agent) throw new PermissionError(`Unknown agent for ${capability}`);
    if (!isAgentAllowed(allowed, agent)) {
      throw new PermissionError(`Agent "${agent.name}" is not permitted to ${capability}. Allowed: ${allowed.join(", ") || "(none)"}`);
    }
    return agent;
  }

  /** Records a failure so it is visible in the dashboard and to the CEO; never stores secrets. */
  async recordError(input: { companyId: string; source: string; task: string; error: unknown; agent?: AgentInfo | null; runId?: string | null; retryStatus?: "none" | "retrying" | "gave_up" }) {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    const retryStatus = input.retryStatus ?? (input.error instanceof IntegrationError && input.error.retryable ? "gave_up" : "none");
    try {
      await this.deps.store.logError({
        companyId: input.companyId,
        source: input.source,
        task: input.task,
        agentId: input.agent?.id ?? null,
        agentName: input.agent?.name ?? null,
        runId: input.runId ?? null,
        error: redact(message),
        retryStatus,
      });
    } catch (logError) {
      this.deps.log?.("error", "Failed to persist Magnora error log entry", { cause: String(logError) });
    }
  }

  // ------------------------------------------------------------ integrations

  async integrationStatuses(companyId: string): Promise<IntegrationStatus[]> {
    const config = await this.config(companyId);
    const statuses: IntegrationStatus[] = [];

    const gmailMissing: string[] = [];
    if (!config.gmail.clientId) gmailMissing.push("gmail.clientId (GOOGLE_CLIENT_ID)");
    if (!config.gmail.clientSecret) gmailMissing.push("gmail.clientSecret (GOOGLE_CLIENT_SECRET)");
    const account = await this.deps.store.getGmailAccount(companyId);
    let gmailState: IntegrationState;
    let gmailDetail: string;
    if (!config.gmail.enabled) {
      gmailState = "DISABLED";
      gmailDetail = "Disabled in plugin settings";
    } else if (gmailMissing.length) {
      gmailState = "NOT_CONFIGURED";
      gmailDetail = "OAuth client is not configured";
    } else if (!account || account.status === "not_connected" || !account.refreshTokenEnc) {
      gmailState = "NOT_CONFIGURED";
      gmailDetail = "Not connected – click Connect Gmail";
      gmailMissing.push("Gmail account connection (OAuth)");
    } else if (account.status === "expired") {
      gmailState = "EXPIRED";
      gmailDetail = `Token expired – reconnect ${account.email ?? ""}`.trim();
    } else if (account.status === "error") {
      gmailState = "ERROR";
      gmailDetail = account.lastError ?? "Error";
    } else {
      gmailState = "CONNECTED";
      gmailDetail = `${account.email ?? "Connected"} · send: ${config.gmail.sendMode}`;
    }
    statuses.push({ key: "gmail", label: "Gmail", category: "email", state: gmailState, detail: gmailDetail, missing: gmailMissing });

    for (const key of SOCIAL_CHANNEL_KEYS) {
      const channelConfig = config.social[key];
      const channel = createChannel(key, channelConfig, this.deps.fetch);
      const status = channel.configuredStatus();
      const missing: string[] = [];
      if (!channelConfig.accessToken) missing.push(`social.${key}.accessToken`);
      if (key !== "x" && !channelConfig.accountId) missing.push(`social.${key}.accountId`);
      statuses.push({
        key: `social.${key}`,
        label: channel.displayName,
        category: "social",
        state: status === "connected" ? "CONNECTED" : status === "disabled" ? "DISABLED" : "NOT_CONFIGURED",
        detail: status === "connected" ? `publish: ${channelConfig.publishMode}` : status === "disabled" ? "Disabled" : "Missing credentials",
        missing: status === "disabled" ? [] : missing,
      });
    }

    if (config.affiliate.providers.length === 0) {
      statuses.push({
        key: "affiliate",
        label: "Affiliate providers",
        category: "affiliate",
        state: "NOT_CONFIGURED",
        detail: "No affiliate provider added",
        missing: ["affiliate.providers[] (report URL + API token)"],
      });
    }
    for (const provider of this.affiliateProviders(companyId, config)) {
      const providerConfig = config.affiliate.providers.find((p) => p.key === provider.key)!;
      const status = provider.status();
      statuses.push({
        key: `affiliate.${provider.key}`,
        label: provider.displayName,
        category: "affiliate",
        state: !providerConfig.enabled ? "DISABLED" : status === "connected" ? "CONNECTED" : "NOT_CONFIGURED",
        detail: status === "connected" ? "Report API configured" : "Missing report URL or token",
        missing: [!providerConfig.statsUrl && `affiliate.${provider.key}.statsUrl`, !providerConfig.apiToken && `affiliate.${provider.key}.apiToken`].filter(Boolean) as string[],
      });
    }
    return statuses;
  }

  async testConnection(companyId: string, key: string): Promise<{ ok: boolean; message: string }> {
    const config = await this.config(companyId);
    try {
      if (key === "gmail") {
        const client = await this.gmailClient(companyId, config);
        const profile = await client.profile();
        return { ok: true, message: `Connected as ${profile.emailAddress}` };
      }
      if (key.startsWith("social.")) {
        const channelKey = key.slice("social.".length) as SocialChannelKey;
        if (!SOCIAL_CHANNEL_KEYS.includes(channelKey)) return { ok: false, message: "Unknown channel" };
        const channelConfig = config.social[channelKey];
        const channel = createChannel(channelKey, channelConfig, this.deps.fetch);
        if (channel.configuredStatus() !== "connected") return { ok: false, message: "Not configured or disabled" };
        const token = await this.deps.resolveSecret(channelConfig.accessToken!, companyId, `social.${channelKey}.accessToken`);
        return { ok: true, message: await channel.testConnection(token) };
      }
      if (key.startsWith("affiliate.")) {
        const provider = this.affiliateProviders(companyId, config).find((p) => `affiliate.${p.key}` === key);
        if (!provider) return { ok: false, message: "Unknown provider" };
        return await provider.testConnection();
      }
      return { ok: false, message: "Unknown integration" };
    } catch (error) {
      await this.recordError({ companyId, source: key, task: "test_connection", error });
      return { ok: false, message: redact(error instanceof Error ? error.message : String(error)) };
    }
  }

  // ------------------------------------------------------------------ gmail

  async beginGmailOAuth(companyId: string, userId: string | null, redirectUri: string) {
    const config = await this.config(companyId);
    if (!config.gmail.clientId || !config.gmail.clientSecret) {
      throw new IntegrationError("not_configured", "Configure the Google OAuth client ID and client secret in the Magnora plugin settings first");
    }
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new IntegrationError("invalid_request", "OAuth redirect URI must use https");
    }
    const state = randomToken(24);
    const codeVerifier = randomToken(48);
    await this.deps.store.saveOAuthPending({ state, companyId, userId, codeVerifier, redirectUri });
    return { authUrl: buildGoogleAuthUrl({ clientId: config.gmail.clientId, redirectUri, state, codeVerifier }) };
  }

  async completeGmailOAuth(companyId: string, userId: string | null, code: string, state: string) {
    const pending = await this.deps.store.takeOAuthPending(state);
    if (!pending || pending.companyId !== companyId || (pending.userId && userId && pending.userId !== userId)) {
      throw new IntegrationError("invalid_request", "OAuth state is invalid or expired. Start the Gmail connection again.");
    }
    const config = await this.config(companyId);
    const clientSecret = await this.deps.resolveSecret(config.gmail.clientSecret!, companyId, "gmail.clientSecret");
    const tokens = await exchangeAuthorizationCode(this.deps.fetch, {
      clientId: config.gmail.clientId,
      clientSecret,
      code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
    });
    if (!tokens.refresh_token) {
      throw new IntegrationError("auth_failed", "Google did not return a refresh token. Remove the app's access at myaccount.google.com/permissions and connect again.");
    }
    const profile = await new GmailClient(this.deps.fetch, tokens.access_token).profile();
    await this.deps.store.saveGmailAccount({
      companyId,
      email: profile.emailAddress,
      refreshTokenEnc: encryptToken(tokens.refresh_token, clientSecret, companyId),
      scopes: tokens.scope ?? null,
      status: "connected",
      lastError: null,
      connectedAt: this.now().toISOString(),
    });
    this.accessTokens.set(companyId, { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 3000) * 1000 });
    return { email: profile.emailAddress };
  }

  async disconnectGmail(companyId: string) {
    this.accessTokens.delete(companyId);
    await this.deps.store.saveGmailAccount({ companyId, email: null, refreshTokenEnc: null, scopes: null, status: "not_connected", lastError: null, connectedAt: null });
  }

  private async gmailClient(companyId: string, config: MagnoraConfig): Promise<GmailClient> {
    if (!config.gmail.enabled) throw new IntegrationError("not_configured", "Gmail integration is disabled");
    if (!config.gmail.clientId || !config.gmail.clientSecret) throw new IntegrationError("not_configured", "Gmail OAuth client is not configured");
    const cached = this.accessTokens.get(companyId);
    if (cached && cached.expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) return new GmailClient(this.deps.fetch, cached.token);

    const account = await this.deps.store.getGmailAccount(companyId);
    if (!account?.refreshTokenEnc || account.status === "not_connected") throw new IntegrationError("not_configured", "Gmail is not connected");
    if (account.status === "expired") throw new IntegrationError("auth_expired", "Gmail token expired – reconnect Gmail in the Magnora page");
    const clientSecret = await this.deps.resolveSecret(config.gmail.clientSecret, companyId, "gmail.clientSecret");
    const refreshToken = decryptToken(account.refreshTokenEnc, clientSecret, companyId);
    if (!refreshToken) {
      await this.deps.store.saveGmailAccount({ ...account, status: "expired", lastError: "Stored token could not be decrypted (client secret changed)" });
      throw new IntegrationError("auth_expired", "Gmail token is no longer valid – reconnect Gmail");
    }
    try {
      const tokens = await refreshAccessToken(this.deps.fetch, { clientId: config.gmail.clientId, clientSecret, refreshToken });
      this.accessTokens.set(companyId, { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 3000) * 1000 });
      if (account.status !== "connected") await this.deps.store.saveGmailAccount({ ...account, status: "connected", lastError: null });
      return new GmailClient(this.deps.fetch, tokens.access_token);
    } catch (error) {
      if (error instanceof IntegrationError && error.kind === "auth_expired") {
        await this.deps.store.saveGmailAccount({ ...account, status: "expired", lastError: error.message });
      }
      throw error;
    }
  }

  async gmailSearch(companyId: string, agentId: string, query: string, maxResults: number) {
    const config = await this.config(companyId);
    await this.requireAgent(companyId, agentId, config.gmail.allowedAgents, "read Gmail");
    return (await this.gmailClient(companyId, config)).search(query || "in:inbox newer_than:1d", maxResults);
  }

  async gmailGetThread(companyId: string, agentId: string, threadId: string) {
    const config = await this.config(companyId);
    await this.requireAgent(companyId, agentId, config.gmail.allowedAgents, "read Gmail");
    return (await this.gmailClient(companyId, config)).getThread(threadId);
  }

  async gmailCreateDraft(companyId: string, agentId: string, input: { to: string; subject: string; body: string; cc?: string; threadId?: string; inReplyToMessageId?: string }) {
    const config = await this.config(companyId);
    await this.requireAgent(companyId, agentId, config.gmail.draftAgents, "create Gmail drafts");
    const raw = buildRawMessage({
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      body: input.body,
      inReplyTo: input.inReplyToMessageId,
      references: input.inReplyToMessageId,
    });
    const draft = await (await this.gmailClient(companyId, config)).createDraft(raw, input.threadId);
    return { draftId: draft.id, threadId: draft.message?.threadId ?? input.threadId ?? null };
  }

  async gmailRequestSend(companyId: string, agentId: string, runId: string | null, draftId: string, reason: string) {
    const config = await this.config(companyId);
    const agent = await this.requireAgent(companyId, agentId, config.gmail.draftAgents, "request Gmail sends");
    if (config.gmail.sendMode === "disabled") {
      throw new PermissionError("SEND permission is disabled for Gmail. The draft stays in Gmail for you to send manually.");
    }
    const draft = draftSummary(await (await this.gmailClient(companyId, config)).getDraft(draftId));
    return this.deps.store.createOutbox({
      companyId,
      kind: "email_send",
      channel: "gmail",
      payload: { ...draft, reason },
      status: "pending_approval",
      requestedByAgentId: agent.id,
      requestedByAgentName: agent.name,
      runId,
    });
  }

  async gmailModifyLabels(companyId: string, agentId: string, input: { messageId: string; addLabelIds?: string[]; removeLabelIds?: string[]; archive?: boolean }) {
    const config = await this.config(companyId);
    await this.requireAgent(companyId, agentId, config.gmail.draftAgents, "change Gmail labels");
    if (!config.gmail.allowArchive) throw new PermissionError("Archive/label permission is disabled for Gmail");
    const remove = [...(input.removeLabelIds ?? [])];
    if (input.archive) remove.push("INBOX");
    const blocked = (input.addLabelIds ?? []).filter((label) => label === "TRASH" || label === "SPAM");
    if (blocked.length) throw new PermissionError("Moving mail to Trash/Spam is not allowed");
    return (await this.gmailClient(companyId, config)).modify(input.messageId, input.addLabelIds ?? [], remove);
  }

  // ----------------------------------------------------------------- social

  async listChannels(companyId: string) {
    const config = await this.config(companyId);
    return SOCIAL_CHANNEL_KEYS.map((key) => {
      const channel = createChannel(key, config.social[key], this.deps.fetch);
      return {
        key,
        name: channel.displayName,
        status: channel.configuredStatus(),
        publishMode: config.social[key].publishMode,
        maxLength: channel.maxLength,
        allowedAgents: config.social[key].allowedAgents,
      };
    });
  }

  async submitPost(
    companyId: string,
    agentId: string,
    runId: string | null,
    input: { channel: string; text: string; link?: string; imageUrl?: string; scheduledFor?: string; note?: string },
  ): Promise<OutboxItem> {
    const key = input.channel as SocialChannelKey;
    if (!SOCIAL_CHANNEL_KEYS.includes(key)) throw new IntegrationError("invalid_request", `Unknown channel "${input.channel}"`);
    const config = await this.config(companyId);
    const channelConfig = config.social[key];
    const agent = await this.requireAgent(companyId, agentId, channelConfig.allowedAgents, `post to ${key}`);
    const channel = createChannel(key, channelConfig, this.deps.fetch);
    if (channel.configuredStatus() === "disabled") throw new IntegrationError("not_configured", `${channel.displayName} is disabled`);
    const post: SocialPost = { text: input.text, link: input.link ?? null, imageUrl: input.imageUrl ?? null };
    const invalid = channel.validate(post);
    if (invalid) throw new IntegrationError("invalid_request", invalid);
    let scheduledFor: string | null = null;
    if (input.scheduledFor) {
      const ts = Date.parse(input.scheduledFor);
      if (!Number.isFinite(ts)) throw new IntegrationError("invalid_request", "scheduledFor must be an ISO 8601 timestamp");
      scheduledFor = new Date(ts).toISOString();
    }
    const item = await this.deps.store.createOutbox({
      companyId,
      kind: "social_post",
      channel: key,
      payload: { ...post, note: input.note ?? null },
      status: channelConfig.publishMode === "auto" ? "scheduled" : "pending_approval",
      requestedByAgentId: agent.id,
      requestedByAgentName: agent.name,
      runId,
      scheduledFor,
    });
    if (item.status === "scheduled" && (!scheduledFor || Date.parse(scheduledFor) <= this.now().getTime())) {
      return (await this.execute(item)) ?? item;
    }
    return item;
  }

  // ----------------------------------------------------------- approvals

  async approve(companyId: string, userId: string, id: string, note?: string) {
    const item = await this.deps.store.getOutbox(companyId, id);
    if (!item) throw new IntegrationError("invalid_request", "Item not found");
    const approved = await this.deps.store.transitionOutbox(companyId, id, ["pending_approval"], {
      status: "scheduled",
      decidedByUserId: userId,
      decidedAt: this.now().toISOString(),
      decisionNote: note ?? null,
    });
    if (!approved) throw new IntegrationError("invalid_request", `Item is ${item.status}, not pending approval`);
    if (!approved.scheduledFor || Date.parse(approved.scheduledFor) <= this.now().getTime()) {
      return (await this.execute(approved)) ?? approved;
    }
    return approved;
  }

  async reject(companyId: string, userId: string, id: string, note?: string) {
    const rejected = await this.deps.store.transitionOutbox(companyId, id, ["pending_approval", "scheduled", "failed"], {
      status: "rejected",
      decidedByUserId: userId,
      decidedAt: this.now().toISOString(),
      decisionNote: note ?? null,
    });
    if (!rejected) throw new IntegrationError("invalid_request", "Item cannot be rejected in its current state");
    return rejected;
  }

  async retry(companyId: string, id: string) {
    const item = await this.deps.store.transitionOutbox(companyId, id, ["failed"], { status: "scheduled", error: null });
    if (!item) throw new IntegrationError("invalid_request", "Only failed items can be retried");
    return (await this.execute(item)) ?? item;
  }

  /** Publish/send an approved item exactly once (status CAS guards double execution). */
  async execute(item: OutboxItem): Promise<OutboxItem | null> {
    const claimed = await this.deps.store.transitionOutbox(item.companyId, item.id, ["scheduled"], { status: "processing", attempts: item.attempts + 1 });
    if (!claimed) return null;
    const config = await this.config(item.companyId);
    try {
      let result: Record<string, unknown>;
      let doneStatus: "published" | "sent";
      if (claimed.kind === "email_send") {
        if (config.gmail.sendMode === "disabled") throw new PermissionError("SEND permission was disabled after the request");
        const sent = await (await this.gmailClient(item.companyId, config)).sendDraft(String(claimed.payload.draftId));
        result = { messageId: sent.id, threadId: sent.threadId };
        doneStatus = "sent";
      } else {
        const key = claimed.channel as SocialChannelKey;
        const channelConfig = config.social[key];
        const channel = createChannel(key, channelConfig, this.deps.fetch);
        if (channel.configuredStatus() !== "connected") throw new IntegrationError("not_configured", `${channel.displayName} is not configured or disabled`);
        const token = await this.deps.resolveSecret(channelConfig.accessToken!, item.companyId, `social.${key}.accessToken`);
        const payload = claimed.payload as unknown as SocialPost;
        result = { ...(await channel.publish({ text: String(payload.text ?? ""), link: payload.link ?? null, imageUrl: payload.imageUrl ?? null }, token)) };
        doneStatus = "published";
      }
      return await this.deps.store.transitionOutbox(item.companyId, item.id, ["processing"], { status: doneStatus, result, error: null });
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      const retryable = error instanceof IntegrationError && error.retryable && claimed.attempts < 3;
      await this.recordError({
        companyId: item.companyId,
        source: claimed.kind === "email_send" ? "gmail" : `social.${claimed.channel}`,
        task: `${claimed.kind}:${claimed.id}`,
        error,
        agent: claimed.requestedByAgentId ? { id: claimed.requestedByAgentId, name: claimed.requestedByAgentName ?? "" } : null,
        runId: claimed.runId,
        retryStatus: retryable ? "retrying" : "gave_up",
      });
      return await this.deps.store.transitionOutbox(item.companyId, item.id, ["processing"], {
        status: retryable ? "scheduled" : "failed",
        error: message,
      });
    }
  }

  async processDue(limit = 20) {
    const due = await this.deps.store.dueScheduled(this.now().toISOString(), limit);
    let processed = 0;
    for (const item of due) {
      if (await this.execute(item)) processed += 1;
    }
    return processed;
  }

  // -------------------------------------------------------------- affiliate

  affiliateProviders(companyId: string, config: MagnoraConfig): AffiliateProvider[] {
    return config.affiliate.providers.map(
      (providerConfig, index) =>
        new JsonAffiliateProvider(providerConfig, this.deps.fetch, async () =>
          providerConfig.apiToken ? this.deps.resolveSecret(providerConfig.apiToken, companyId, `affiliate.providers.${index}.apiToken`) : null,
        ),
    );
  }

  async affiliateReport(companyId: string, period: PeriodKey, opts: { agentId?: string; providerKey?: string } = {}) {
    const config = await this.config(companyId);
    if (opts.agentId) await this.requireAgent(companyId, opts.agentId, config.affiliate.allowedAgents, "read affiliate data");
    const range = resolvePeriod(period, this.now(), config.timezone);
    const prev = previousRange(range);
    const providers = this.affiliateProviders(companyId, config).filter((p) => !opts.providerKey || p.key === opts.providerKey);
    const rows = await Promise.all(
      providers.map(async (provider) => {
        const currency = config.affiliate.providers.find((p) => p.key === provider.key)?.currency ?? "DKK";
        if (provider.status() !== "connected") {
          return { key: provider.key, name: provider.displayName, status: "NOT_CONFIGURED" as const, current: emptyStats(currency), previous: emptyStats(currency), change: null, error: null };
        }
        try {
          const [current, previous] = await Promise.all([provider.getStats(range), provider.getStats(prev)]);
          return { key: provider.key, name: provider.displayName, status: "CONNECTED" as const, current, previous, change: diffStats(current, previous), error: null };
        } catch (error) {
          await this.recordError({ companyId, source: `affiliate.${provider.key}`, task: `affiliate_stats:${period}`, error, agent: opts.agentId ? { id: opts.agentId, name: "" } : null });
          const state = error instanceof IntegrationError && error.kind === "auth_expired" ? "EXPIRED" : "ERROR";
          return { key: provider.key, name: provider.displayName, status: state as "EXPIRED" | "ERROR", current: emptyStats(currency), previous: emptyStats(currency), change: null, error: redact(String((error as Error).message ?? error)) };
        }
      }),
    );
    return { period, range, previousRange: prev, providers: rows };
  }

  // ---------------------------------------------------------------- reports

  listOutbox(companyId: string, opts: { statuses?: OutboxStatus[]; kind?: OutboxKind; limit?: number } = {}) {
    return this.deps.store.listOutbox(companyId, opts);
  }

  listErrors(companyId: string, limit: number) {
    return this.deps.store.listErrors(companyId, limit);
  }

  async healthReport(companyId: string) {
    const [integrations, counts, pending, failed, errors] = await Promise.all([
      this.integrationStatuses(companyId),
      this.deps.store.countOutbox(companyId),
      this.deps.store.listOutbox(companyId, { statuses: ["pending_approval"], limit: 20 }),
      this.deps.store.listOutbox(companyId, { statuses: ["failed"], limit: 20 }),
      this.deps.store.listErrors(companyId, 25),
    ]);
    const repeatedFailures = Object.entries(
      errors.reduce<Record<string, number>>((acc, e) => {
        const key = `${e.agentName || "system"} · ${e.source}`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .filter(([, n]) => n >= 3)
      .map(([key, count]) => ({ key, count }));
    return {
      generatedAt: this.now().toISOString(),
      integrations,
      outboxCounts: counts,
      pendingApprovals: pending.map(publicOutbox),
      failedItems: failed.map(publicOutbox),
      recentErrors: errors,
      repeatedFailures,
    };
  }
}

function diffStats(current: AffiliateStats, previous: AffiliateStats) {
  const pct = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : null) : (a - b) / b);
  return {
    clicks: pct(current.clicks, previous.clicks),
    leads: pct(current.leads, previous.leads),
    conversions: pct(current.conversions, previous.conversions),
    sales: pct(current.sales, previous.sales),
    commission: pct(current.commission, previous.commission),
  };
}

/** Outbox shape safe to show to agents and the UI. */
export function publicOutbox(item: OutboxItem) {
  return {
    id: item.id,
    kind: item.kind,
    channel: item.channel,
    status: item.status,
    payload: item.payload,
    requestedBy: item.requestedByAgentName,
    scheduledFor: item.scheduledFor,
    decidedAt: item.decidedAt,
    decisionNote: item.decisionNote,
    result: item.result,
    error: item.error,
    attempts: item.attempts,
    createdAt: item.createdAt,
  };
}
