import { randomUUID } from "node:crypto";

export type OutboxKind = "social_post" | "email_send";
export type OutboxStatus = "pending_approval" | "scheduled" | "processing" | "published" | "sent" | "rejected" | "failed";

export interface OutboxItem {
  id: string;
  companyId: string;
  kind: OutboxKind;
  channel: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  requestedByAgentId: string | null;
  requestedByAgentName: string | null;
  runId: string | null;
  scheduledFor: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export type RetryStatus = "none" | "retrying" | "gave_up" | "resolved";

export interface ErrorLogEntry {
  id: string;
  companyId: string;
  source: string;
  task: string;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
  error: string;
  retryStatus: RetryStatus;
  createdAt: string;
}

export interface GmailAccount {
  companyId: string;
  email: string | null;
  refreshTokenEnc: string | null;
  scopes: string | null;
  status: "not_connected" | "connected" | "expired" | "error";
  lastError: string | null;
  connectedAt: string | null;
}

export interface OAuthPending {
  state: string;
  companyId: string;
  userId: string | null;
  codeVerifier: string;
  redirectUri: string;
  createdAt: string;
}

export type NewOutboxItem = Pick<OutboxItem, "companyId" | "kind" | "channel" | "payload" | "status"> &
  Partial<Pick<OutboxItem, "requestedByAgentId" | "requestedByAgentName" | "runId" | "scheduledFor">>;

export interface MagnoraStore {
  createOutbox(item: NewOutboxItem): Promise<OutboxItem>;
  getOutbox(companyId: string, id: string): Promise<OutboxItem | null>;
  listOutbox(companyId: string, opts?: { statuses?: OutboxStatus[]; kind?: OutboxKind; limit?: number }): Promise<OutboxItem[]>;
  /** Atomic compare-and-set on status; returns the updated row or null if the status did not match. */
  transitionOutbox(
    companyId: string,
    id: string,
    from: OutboxStatus[],
    patch: Partial<Pick<OutboxItem, "status" | "decidedByUserId" | "decidedAt" | "decisionNote" | "result" | "error" | "attempts">>,
  ): Promise<OutboxItem | null>;
  dueScheduled(nowIso: string, limit: number): Promise<OutboxItem[]>;
  countOutbox(companyId: string): Promise<Record<string, number>>;

  logError(entry: Omit<ErrorLogEntry, "id" | "createdAt">): Promise<ErrorLogEntry>;
  listErrors(companyId: string, limit: number): Promise<ErrorLogEntry[]>;

  getGmailAccount(companyId: string): Promise<GmailAccount | null>;
  saveGmailAccount(account: GmailAccount): Promise<void>;

  saveOAuthPending(pending: Omit<OAuthPending, "createdAt">): Promise<void>;
  takeOAuthPending(state: string): Promise<OAuthPending | null>;
}

type Row = Record<string, unknown>;

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

const json = (value: unknown): Record<string, unknown> | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return value as Record<string, unknown>;
};

function outboxFromRow(row: Row): OutboxItem {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    kind: row.kind as OutboxKind,
    channel: String(row.channel),
    payload: json(row.payload) ?? {},
    status: row.status as OutboxStatus,
    requestedByAgentId: (row.requested_by_agent_id as string | null) ?? null,
    requestedByAgentName: (row.requested_by_agent_name as string | null) ?? null,
    runId: (row.run_id as string | null) ?? null,
    scheduledFor: iso(row.scheduled_for),
    decidedByUserId: (row.decided_by_user_id as string | null) ?? null,
    decidedAt: iso(row.decided_at),
    decisionNote: (row.decision_note as string | null) ?? null,
    result: json(row.result),
    error: (row.error as string | null) ?? null,
    attempts: Number(row.attempts ?? 0),
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

function errorFromRow(row: Row): ErrorLogEntry {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    source: String(row.source),
    task: String(row.task),
    agentId: (row.agent_id as string | null) ?? null,
    agentName: (row.agent_name as string | null) ?? null,
    runId: (row.run_id as string | null) ?? null,
    error: String(row.error),
    retryStatus: row.retry_status as RetryStatus,
    createdAt: iso(row.created_at) ?? "",
  };
}

interface DbLike {
  namespace: string;
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

/** Persistence in the plugin's own Postgres namespace (survives redeploys). */
export class SqlStore implements MagnoraStore {
  constructor(private readonly db: DbLike) {}

  private t(table: string) {
    return `${this.db.namespace}.${table}`;
  }

  async createOutbox(item: NewOutboxItem) {
    const id = randomUUID();
    await this.db.execute(
      `INSERT INTO ${this.t("outbox")} (id, company_id, kind, channel, payload, status, requested_by_agent_id, requested_by_agent_name, run_id, scheduled_for)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
      [id, item.companyId, item.kind, item.channel, JSON.stringify(item.payload), item.status, item.requestedByAgentId ?? null, item.requestedByAgentName ?? null, item.runId ?? null, item.scheduledFor ?? null],
    );
    return (await this.getOutbox(item.companyId, id))!;
  }

  async getOutbox(companyId: string, id: string) {
    const rows = await this.db.query(`SELECT * FROM ${this.t("outbox")} WHERE company_id = $1 AND id = $2`, [companyId, id]);
    return rows[0] ? outboxFromRow(rows[0]) : null;
  }

  async listOutbox(companyId: string, opts: { statuses?: OutboxStatus[]; kind?: OutboxKind; limit?: number } = {}) {
    const params: unknown[] = [companyId];
    let where = "company_id = $1";
    if (opts.statuses?.length) {
      params.push(opts.statuses);
      where += ` AND status = ANY($${params.length}::text[])`;
    }
    if (opts.kind) {
      params.push(opts.kind);
      where += ` AND kind = $${params.length}`;
    }
    params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
    const rows = await this.db.query(`SELECT * FROM ${this.t("outbox")} WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map(outboxFromRow);
  }

  async transitionOutbox(
    companyId: string,
    id: string,
    from: OutboxStatus[],
    patch: Partial<Pick<OutboxItem, "status" | "decidedByUserId" | "decidedAt" | "decisionNote" | "result" | "error" | "attempts">>,
  ) {
    const columns: Record<string, unknown> = {
      status: patch.status,
      decided_by_user_id: patch.decidedByUserId,
      decided_at: patch.decidedAt,
      decision_note: patch.decisionNote,
      result: patch.result === undefined ? undefined : JSON.stringify(patch.result),
      error: patch.error,
      attempts: patch.attempts,
    };
    const params: unknown[] = [companyId, id, from];
    const sets: string[] = ["updated_at = now()"];
    for (const [column, value] of Object.entries(columns)) {
      if (value === undefined) continue;
      params.push(value);
      sets.push(`${column} = $${params.length}${column === "result" ? "::jsonb" : ""}`);
    }
    const { rowCount } = await this.db.execute(
      `UPDATE ${this.t("outbox")} SET ${sets.join(", ")} WHERE company_id = $1 AND id = $2 AND status = ANY($3::text[])`,
      params,
    );
    return rowCount > 0 ? this.getOutbox(companyId, id) : null;
  }

  async dueScheduled(nowIso: string, limit: number) {
    const rows = await this.db.query(
      `SELECT * FROM ${this.t("outbox")} WHERE status = 'scheduled' AND (scheduled_for IS NULL OR scheduled_for <= $1) ORDER BY scheduled_for ASC NULLS FIRST LIMIT $2`,
      [nowIso, limit],
    );
    return rows.map(outboxFromRow);
  }

  async countOutbox(companyId: string) {
    const rows = await this.db.query<{ status: string; n: number | string }>(
      `SELECT status, count(*) AS n FROM ${this.t("outbox")} WHERE company_id = $1 GROUP BY status`,
      [companyId],
    );
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  async logError(entry: Omit<ErrorLogEntry, "id" | "createdAt">) {
    const id = randomUUID();
    await this.db.execute(
      `INSERT INTO ${this.t("error_log")} (id, company_id, source, task, agent_id, agent_name, run_id, error, retry_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, entry.companyId, entry.source, entry.task, entry.agentId, entry.agentName, entry.runId, entry.error, entry.retryStatus],
    );
    return { ...entry, id, createdAt: new Date().toISOString() };
  }

  async listErrors(companyId: string, limit: number) {
    const rows = await this.db.query(`SELECT * FROM ${this.t("error_log")} WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`, [companyId, Math.min(Math.max(limit, 1), 200)]);
    return rows.map(errorFromRow);
  }

  async getGmailAccount(companyId: string) {
    const rows = await this.db.query(`SELECT * FROM ${this.t("gmail_account")} WHERE company_id = $1`, [companyId]);
    const row = rows[0];
    if (!row) return null;
    return {
      companyId: String(row.company_id),
      email: (row.email as string | null) ?? null,
      refreshTokenEnc: (row.refresh_token_enc as string | null) ?? null,
      scopes: (row.scopes as string | null) ?? null,
      status: row.status as GmailAccount["status"],
      lastError: (row.last_error as string | null) ?? null,
      connectedAt: iso(row.connected_at),
    };
  }

  async saveGmailAccount(account: GmailAccount) {
    await this.db.execute(
      `INSERT INTO ${this.t("gmail_account")} (company_id, email, refresh_token_enc, scopes, status, last_error, connected_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (company_id) DO UPDATE SET email = EXCLUDED.email, refresh_token_enc = EXCLUDED.refresh_token_enc, scopes = EXCLUDED.scopes,
         status = EXCLUDED.status, last_error = EXCLUDED.last_error, connected_at = EXCLUDED.connected_at, updated_at = now()`,
      [account.companyId, account.email, account.refreshTokenEnc, account.scopes, account.status, account.lastError, account.connectedAt],
    );
  }

  async saveOAuthPending(pending: Omit<OAuthPending, "createdAt">) {
    await this.db.execute(`DELETE FROM ${this.t("oauth_pending")} WHERE created_at < now() - interval '30 minutes'`, []);
    await this.db.execute(
      `INSERT INTO ${this.t("oauth_pending")} (state, company_id, user_id, code_verifier, redirect_uri) VALUES ($1, $2, $3, $4, $5)`,
      [pending.state, pending.companyId, pending.userId, pending.codeVerifier, pending.redirectUri],
    );
  }

  async takeOAuthPending(state: string) {
    const rows = await this.db.query(
      `SELECT * FROM ${this.t("oauth_pending")} WHERE state = $1 AND created_at > now() - interval '30 minutes'`,
      [state],
    );
    await this.db.execute(`DELETE FROM ${this.t("oauth_pending")} WHERE state = $1`, [state]);
    const row = rows[0];
    if (!row) return null;
    return {
      state: String(row.state),
      companyId: String(row.company_id),
      userId: (row.user_id as string | null) ?? null,
      codeVerifier: String(row.code_verifier),
      redirectUri: String(row.redirect_uri),
      createdAt: iso(row.created_at) ?? "",
    };
  }
}

/** In-memory store used by unit tests. */
export class MemoryStore implements MagnoraStore {
  outbox = new Map<string, OutboxItem>();
  errors: ErrorLogEntry[] = [];
  gmail = new Map<string, GmailAccount>();
  pending = new Map<string, OAuthPending>();

  async createOutbox(item: NewOutboxItem) {
    const now = new Date().toISOString();
    const row: OutboxItem = {
      id: randomUUID(),
      requestedByAgentId: null,
      requestedByAgentName: null,
      runId: null,
      scheduledFor: null,
      decidedByUserId: null,
      decidedAt: null,
      decisionNote: null,
      result: null,
      error: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      ...item,
    };
    this.outbox.set(row.id, row);
    return { ...row };
  }
  async getOutbox(companyId: string, id: string) {
    const row = this.outbox.get(id);
    return row && row.companyId === companyId ? { ...row } : null;
  }
  async listOutbox(companyId: string, opts: { statuses?: OutboxStatus[]; kind?: OutboxKind; limit?: number } = {}) {
    return [...this.outbox.values()]
      .filter((r) => r.companyId === companyId && (!opts.statuses?.length || opts.statuses.includes(r.status)) && (!opts.kind || r.kind === opts.kind))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts.limit ?? 50);
  }
  async transitionOutbox(companyId: string, id: string, from: OutboxStatus[], patch: Partial<OutboxItem>) {
    const row = this.outbox.get(id);
    if (!row || row.companyId !== companyId || !from.includes(row.status)) return null;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...row, ...defined, updatedAt: new Date().toISOString() } as OutboxItem;
    this.outbox.set(id, next);
    return { ...next };
  }
  async dueScheduled(nowIso: string, limit: number) {
    return [...this.outbox.values()].filter((r) => r.status === "scheduled" && (!r.scheduledFor || r.scheduledFor <= nowIso)).slice(0, limit);
  }
  async countOutbox(companyId: string) {
    const counts: Record<string, number> = {};
    for (const r of this.outbox.values()) if (r.companyId === companyId) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return counts;
  }
  async logError(entry: Omit<ErrorLogEntry, "id" | "createdAt">) {
    const row = { ...entry, id: randomUUID(), createdAt: new Date().toISOString() };
    this.errors.unshift(row);
    return row;
  }
  async listErrors(companyId: string, limit: number) {
    return this.errors.filter((e) => e.companyId === companyId).slice(0, limit);
  }
  async getGmailAccount(companyId: string) {
    return this.gmail.get(companyId) ?? null;
  }
  async saveGmailAccount(account: GmailAccount) {
    this.gmail.set(account.companyId, { ...account });
  }
  async saveOAuthPending(pending: Omit<OAuthPending, "createdAt">) {
    this.pending.set(pending.state, { ...pending, createdAt: new Date().toISOString() });
  }
  async takeOAuthPending(state: string) {
    const row = this.pending.get(state) ?? null;
    this.pending.delete(state);
    return row;
  }
}
