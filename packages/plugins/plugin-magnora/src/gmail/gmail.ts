import { createHash } from "node:crypto";
import { GMAIL_API_BASE, GMAIL_SCOPES, GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL } from "../constants.js";
import { IntegrationError, requestJson, type FetchFn, type RequestJsonOptions } from "../http.js";

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildGoogleAuthUrl(input: { clientId: string; redirectUri: string; state: string; codeVerifier: string; loginHint?: string }): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", pkceChallenge(input.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

async function tokenRequest(fetchFn: FetchFn, body: URLSearchParams): Promise<GoogleTokenResponse> {
  const response = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    const code = typeof payload.error === "string" ? payload.error : `http_${response.status}`;
    // invalid_grant = refresh token revoked/expired or code reused.
    throw new IntegrationError(code === "invalid_grant" ? "auth_expired" : "auth_failed", `Google token endpoint: ${code}`, response.status);
  }
  return payload as unknown as GoogleTokenResponse;
}

export function exchangeAuthorizationCode(
  fetchFn: FetchFn,
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string },
) {
  return tokenRequest(
    fetchFn,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  );
}

export function refreshAccessToken(fetchFn: FetchFn, input: { clientId: string; clientSecret: string; refreshToken: string }) {
  return tokenRequest(
    fetchFn,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }),
  );
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labelIds: string[];
  unread: boolean;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: GmailHeader[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function summarize(message: GmailMessage): GmailMessageSummary {
  const labelIds = message.labelIds ?? [];
  return {
    id: message.id,
    threadId: message.threadId,
    from: header(message, "From"),
    to: header(message, "To"),
    subject: header(message, "Subject"),
    date: header(message, "Date"),
    snippet: message.snippet ?? "",
    labelIds,
    unread: labelIds.includes("UNREAD"),
  };
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/** Extract a plain-text body, falling back to tag-stripped HTML. */
export function extractText(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const text = extractText(child);
    if (text) return text;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodeBase64Url(part.body.data).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return "";
}

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word for non-ASCII subjects (æøå).
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function assertHeaderSafe(name: string, value: string) {
  if (/[\r\n]/.test(value)) throw new IntegrationError("invalid_request", `${name} must not contain line breaks`);
}

export function buildRawMessage(input: { to: string; subject: string; body: string; cc?: string; inReplyTo?: string; references?: string }): string {
  for (const [name, value] of Object.entries({ to: input.to, subject: input.subject, cc: input.cc ?? "", inReplyTo: input.inReplyTo ?? "", references: input.references ?? "" })) {
    assertHeaderSafe(name, value);
  }
  const lines = [`To: ${input.to}`];
  if (input.cc) lines.push(`Cc: ${input.cc}`);
  lines.push(`Subject: ${encodeHeader(input.subject)}`);
  if (input.inReplyTo) lines.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) lines.push(`References: ${input.references}`);
  lines.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", Buffer.from(input.body, "utf8").toString("base64"));
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export class GmailClient {
  constructor(private readonly fetchFn: FetchFn, private readonly accessToken: string) {}

  private request<T>(path: string, init: RequestJsonOptions = {}) {
    return requestJson<T>(this.fetchFn, `${GMAIL_API_BASE}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.accessToken}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    });
  }

  profile() {
    return this.request<{ emailAddress: string; messagesTotal?: number }>("/profile");
  }

  async search(query: string, maxResults: number): Promise<GmailMessageSummary[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(maxResults, 1), 50)) });
    const list = await this.request<{ messages?: Array<{ id: string }> }>(`/messages?${params}`);
    const ids = (list.messages ?? []).map((m) => m.id);
    const metadata = "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
    const messages = await Promise.all(ids.map((id) => this.request<GmailMessage>(`/messages/${encodeURIComponent(id)}?${metadata}`)));
    return messages.map(summarize);
  }

  async getThread(threadId: string, maxCharsPerMessage = 6000) {
    const thread = await this.request<{ id: string; messages?: GmailMessage[] }>(`/threads/${encodeURIComponent(threadId)}?format=full`);
    return {
      threadId: thread.id,
      messages: (thread.messages ?? []).map((m) => ({
        ...summarize(m),
        messageIdHeader: header(m, "Message-ID") || header(m, "Message-Id"),
        body: extractText(m.payload).slice(0, maxCharsPerMessage),
      })),
    };
  }

  createDraft(raw: string, threadId?: string) {
    return this.request<{ id: string; message?: { id: string; threadId: string } }>("/drafts", {
      method: "POST",
      body: JSON.stringify({ message: threadId ? { raw, threadId } : { raw } }),
    });
  }

  getDraft(draftId: string) {
    return this.request<{ id: string; message?: GmailMessage }>(`/drafts/${encodeURIComponent(draftId)}?format=metadata`);
  }

  sendDraft(draftId: string) {
    return this.request<{ id: string; threadId: string }>("/drafts/send", { method: "POST", body: JSON.stringify({ id: draftId }), retries: 0 });
  }

  modify(messageId: string, addLabelIds: string[], removeLabelIds: string[]) {
    return this.request<{ id: string; labelIds?: string[] }>(`/messages/${encodeURIComponent(messageId)}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
  }

  listLabels() {
    return this.request<{ labels?: Array<{ id: string; name: string }> }>("/labels");
  }
}

export function draftSummary(draft: { id: string; message?: GmailMessage }) {
  const message = draft.message;
  return {
    draftId: draft.id,
    to: message ? header(message, "To") : "",
    subject: message ? header(message, "Subject") : "",
    snippet: message?.snippet ?? "",
    threadId: message?.threadId ?? null,
  };
}
