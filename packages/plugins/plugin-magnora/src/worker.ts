import { definePlugin, runWorker, type PluginContext, type ToolResult, type ToolRunContext } from "@paperclipai/plugin-sdk";
import { ACTION_KEYS, DATA_KEYS, JOB_KEYS, TOOL_NAMES } from "./constants.js";
import { IntegrationError } from "./http.js";
import { isPeriodKey } from "./periods.js";
import { MagnoraService, PermissionError, publicOutbox, type AgentInfo } from "./service.js";
import { SqlStore, type MagnoraStore, type OutboxKind, type OutboxStatus } from "./store.js";
import { TOOL_DECLARATIONS } from "./tools.js";

type Params = Record<string, unknown>;

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export function createService(ctx: PluginContext, store?: MagnoraStore) {
  return new MagnoraService({
    store: store ?? new SqlStore(ctx.db),
    fetch: (url, init) => ctx.http.fetch(url, init),
    getConfig: (companyId) => ctx.config.get(companyId),
    resolveSecret: (ref, companyId, configPath) => ctx.secrets.resolve(ref, { companyId, configPath }),
    getAgent: async (agentId, companyId): Promise<AgentInfo | null> => {
      const agent = await ctx.agents.get(agentId, companyId);
      return agent ? { id: agent.id, name: agent.name, urlKey: agent.urlKey } : null;
    },
    log: (level, message, meta) => ctx.logger[level](message, meta),
  });
}

function describeError(error: unknown): string {
  if (error instanceof PermissionError) return `PERMISSION DENIED: ${error.message}`;
  if (error instanceof IntegrationError) {
    if (error.kind === "not_configured") return `NOT CONFIGURED: ${error.message}`;
    if (error.kind === "auth_expired") return `TOKEN EXPIRED: ${error.message}`;
    return `${error.kind.toUpperCase()}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function registerMagnora(ctx: PluginContext, service: MagnoraService) {
  const toolHandlers: Record<string, (params: Params, run: ToolRunContext) => Promise<unknown>> = {
    [TOOL_NAMES.integrationsStatus]: (_p, run) => service.integrationStatuses(run.companyId),
    [TOOL_NAMES.healthReport]: (_p, run) => service.healthReport(run.companyId),
    [TOOL_NAMES.gmailSearch]: (p, run) => service.gmailSearch(run.companyId, run.agentId, str(p.query), num(p.maxResults, 20)),
    [TOOL_NAMES.gmailGetThread]: (p, run) => service.gmailGetThread(run.companyId, run.agentId, str(p.threadId)),
    [TOOL_NAMES.gmailCreateDraft]: (p, run) =>
      service.gmailCreateDraft(run.companyId, run.agentId, {
        to: str(p.to),
        cc: str(p.cc) || undefined,
        subject: str(p.subject),
        body: typeof p.body === "string" ? p.body : "",
        threadId: str(p.threadId) || undefined,
        inReplyToMessageId: str(p.inReplyToMessageId) || undefined,
      }),
    [TOOL_NAMES.gmailRequestSend]: async (p, run) =>
      publicOutbox(await service.gmailRequestSend(run.companyId, run.agentId, run.runId, str(p.draftId), str(p.reason))),
    [TOOL_NAMES.gmailModifyLabels]: (p, run) =>
      service.gmailModifyLabels(run.companyId, run.agentId, {
        messageId: str(p.messageId),
        addLabelIds: Array.isArray(p.addLabelIds) ? p.addLabelIds.map(String) : [],
        removeLabelIds: Array.isArray(p.removeLabelIds) ? p.removeLabelIds.map(String) : [],
        archive: p.archive === true,
      }),
    [TOOL_NAMES.socialListChannels]: (_p, run) => service.listChannels(run.companyId),
    [TOOL_NAMES.socialSubmitPost]: async (p, run) =>
      publicOutbox(
        await service.submitPost(run.companyId, run.agentId, run.runId, {
          channel: str(p.channel),
          text: typeof p.text === "string" ? p.text : "",
          link: str(p.link) || undefined,
          imageUrl: str(p.imageUrl) || undefined,
          scheduledFor: str(p.scheduledFor) || undefined,
          note: str(p.note) || undefined,
        }),
      ),
    [TOOL_NAMES.socialPostHistory]: async (p, run) =>
      (await service.listOutbox(run.companyId, { kind: "social_post", limit: num(p.limit, 20) })).map(publicOutbox),
    [TOOL_NAMES.affiliateStats]: (p, run) =>
      service.affiliateReport(run.companyId, isPeriodKey(p.period) ? p.period : "yesterday", { agentId: run.agentId, providerKey: str(p.provider) || undefined }),
  };

  for (const declaration of TOOL_DECLARATIONS) {
    const handler = toolHandlers[declaration.name];
    if (!handler) throw new Error(`Missing handler for tool ${declaration.name}`);
    ctx.tools.register(
      declaration.name,
      { displayName: declaration.displayName, description: declaration.description, parametersSchema: declaration.parametersSchema },
      async (params, run): Promise<ToolResult> => {
        try {
          const data = await handler((params ?? {}) as Params, run);
          return { content: JSON.stringify(data, null, 2), data };
        } catch (error) {
          const message = describeError(error);
          if (!(error instanceof PermissionError)) {
            const agent = await ctx.agents.get(run.agentId, run.companyId).catch(() => null);
            await service.recordError({
              companyId: run.companyId,
              source: declaration.name.split("_")[0] ?? "magnora",
              task: declaration.name,
              error,
              agent: agent ? { id: agent.id, name: agent.name } : { id: run.agentId, name: "" },
              runId: run.runId,
            });
          }
          return { error: message };
        }
      },
    );
  }

  const companyOf = (params: Params) => {
    const companyId = str(params.companyId);
    if (!companyId) throw new Error("companyId is required");
    return companyId;
  };

  ctx.data.register(DATA_KEYS.overview, async (params) => service.healthReport(companyOf(params)));
  ctx.data.register(DATA_KEYS.outbox, async (params) => {
    const statuses = Array.isArray(params.statuses) ? (params.statuses.map(String) as OutboxStatus[]) : undefined;
    const kind = params.kind === "email_send" || params.kind === "social_post" ? (params.kind as OutboxKind) : undefined;
    return (await service.listOutbox(companyOf(params), { statuses, kind, limit: num(params.limit, 50) })).map(publicOutbox);
  });
  ctx.data.register(DATA_KEYS.affiliate, async (params) =>
    service.affiliateReport(companyOf(params), isPeriodKey(params.period) ? params.period : "7d"),
  );
  ctx.data.register(DATA_KEYS.errors, async (params) => service.listErrors(companyOf(params), num(params.limit, 50)));

  const boardAction = (key: string, fn: (companyId: string, userId: string, params: Params) => Promise<unknown>) =>
    ctx.actions.register(key, async (params, context) => {
      if (context.actor.type !== "user" || !context.actor.userId) {
        throw new Error("Only a signed-in board user can perform this action");
      }
      const companyId = context.companyId ?? str(params.companyId);
      if (!companyId) throw new Error("companyId is required");
      const result = await fn(companyId, context.actor.userId, params);
      await ctx.activity
        .log({ companyId, message: `Magnora: ${key}`, entityType: "plugin", metadata: { action: key, id: str(params.id) || null } })
        .catch(() => undefined);
      return result;
    });

  boardAction(ACTION_KEYS.approve, async (companyId, userId, p) => publicOutbox(await service.approve(companyId, userId, str(p.id), str(p.note) || undefined)));
  boardAction(ACTION_KEYS.reject, async (companyId, userId, p) => publicOutbox(await service.reject(companyId, userId, str(p.id), str(p.note) || undefined)));
  boardAction(ACTION_KEYS.retry, async (companyId, _userId, p) => publicOutbox(await service.retry(companyId, str(p.id))));
  boardAction(ACTION_KEYS.testConnection, (companyId, _userId, p) => service.testConnection(companyId, str(p.key)));
  boardAction(ACTION_KEYS.gmailBeginOAuth, (companyId, userId, p) => service.beginGmailOAuth(companyId, userId, str(p.redirectUri)));
  boardAction(ACTION_KEYS.gmailCompleteOAuth, (companyId, userId, p) => service.completeGmailOAuth(companyId, userId, str(p.code), str(p.state)));
  boardAction(ACTION_KEYS.gmailDisconnect, (companyId) => service.disconnectGmail(companyId));

  ctx.jobs.register(JOB_KEYS.publishScheduled, async () => {
    const processed = await service.processDue();
    if (processed > 0) ctx.logger.info("Magnora processed scheduled items", { processed });
  });
}

const plugin = definePlugin({
  async setup(ctx) {
    registerMagnora(ctx, createService(ctx));
    ctx.logger.info("Magnora Marketing Ops plugin ready");
  },
  async onHealth() {
    return { status: "ok", message: "Magnora Marketing Ops ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
