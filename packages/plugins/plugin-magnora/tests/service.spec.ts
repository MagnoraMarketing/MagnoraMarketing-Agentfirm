import { describe, expect, it } from "vitest";
import { encryptToken } from "../src/crypto.js";
import { PermissionError } from "../src/service.js";
import { AGENTS, COMPANY, jsonResponse, makeService, ref } from "./helpers.js";

const socialConfig = (publishMode = "with_approval") => ({
  social: {
    facebook: { enabled: true, accountId: "123", accessToken: ref("fb-token"), publishMode },
    x: { enabled: true, accessToken: ref("x-token"), publishMode },
  },
});

const fbResponder = (url: string) => {
  if (url.includes("/123/feed")) return jsonResponse({ id: "123_999" });
  return jsonResponse({}, 404);
};

describe("social approval flow", () => {
  it("creates PENDING APPROVAL and publishes only after approval", async () => {
    const { service, calls } = makeService(socialConfig(), fbResponder);
    const item = await service.submitPost(COMPANY, AGENTS.social.id, "run-1", { channel: "facebook", text: "Ny kampagne" });
    expect(item.status).toBe("pending_approval");
    expect(calls).toHaveLength(0);

    const approved = await service.approve(COMPANY, "user-1", item.id);
    expect(approved.status).toBe("published");
    expect(approved.result).toMatchObject({ externalId: "123_999" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/123/feed");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer FB_TOKEN");

    await expect(service.approve(COMPANY, "user-1", item.id)).rejects.toThrow(/not pending approval/);
    expect(calls).toHaveLength(1);
  });

  it("denies agents that are not assigned to the channel", async () => {
    const { service } = makeService(socialConfig());
    await expect(service.submitPost(COMPANY, AGENTS.sales.id, null, { channel: "facebook", text: "hi" })).rejects.toBeInstanceOf(PermissionError);
  });

  it("validates channel limits", async () => {
    const { service } = makeService(socialConfig());
    await expect(service.submitPost(COMPANY, AGENTS.social.id, null, { channel: "x", text: "a".repeat(281) })).rejects.toThrow(/280/);
    await expect(service.submitPost(COMPANY, AGENTS.social.id, null, { channel: "myspace", text: "a" })).rejects.toThrow(/Unknown channel/);
  });

  it("rejected posts are never published", async () => {
    const { service, calls } = makeService(socialConfig(), fbResponder);
    const item = await service.submitPost(COMPANY, AGENTS.social.id, null, { channel: "facebook", text: "x" });
    const rejected = await service.reject(COMPANY, "user-1", item.id, "off brand");
    expect(rejected.status).toBe("rejected");
    expect(await service.processDue()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("auto mode publishes immediately; future schedules wait for the job", async () => {
    const { service, calls } = makeService(socialConfig("auto"), fbResponder);
    const now = await service.submitPost(COMPANY, AGENTS.social.id, null, { channel: "facebook", text: "now" });
    expect(now.status).toBe("published");
    const later = await service.submitPost(COMPANY, AGENTS.social.id, null, { channel: "facebook", text: "later", scheduledFor: "2026-12-01T08:00:00Z" });
    expect(later.status).toBe("scheduled");
    expect(calls).toHaveLength(1);
    expect(await service.processDue()).toBe(0);
  });

  it("records failures with retry status and lets the board retry", async () => {
    let fail = true;
    const { service, store } = makeService(socialConfig(), (url) => (fail ? new Response("boom", { status: 400 }) : fbResponder(url)));
    const item = await service.submitPost(COMPANY, AGENTS.social.id, "run-9", { channel: "facebook", text: "x" });
    const failed = await service.approve(COMPANY, "user-1", item.id);
    expect(failed.status).toBe("failed");
    expect(store.errors[0]).toMatchObject({ source: "social.facebook", agentName: "Social Media", runId: "run-9", retryStatus: "gave_up" });
    fail = false;
    expect((await service.retry(COMPANY, item.id)).status).toBe("published");
  });
});

describe("gmail", () => {
  const gmailConfig = (sendMode = "with_approval") => ({
    gmail: { enabled: true, clientId: "cid.apps.googleusercontent.com", clientSecret: ref("google-secret"), sendMode },
  });

  it("is NOT_CONFIGURED until connected and lists the missing credential", async () => {
    const { service } = makeService({ gmail: { enabled: true } });
    const gmail = (await service.integrationStatuses(COMPANY)).find((s) => s.key === "gmail")!;
    expect(gmail.state).toBe("NOT_CONFIGURED");
    expect(gmail.missing.join(" ")).toContain("GOOGLE_CLIENT_ID");
  });

  it("completes OAuth, stores only an encrypted refresh token and reports CONNECTED", async () => {
    const { service, store, calls } = makeService(gmailConfig(), (url) => {
      if (url === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "AT", refresh_token: "RT-secret", expires_in: 3600 });
      if (url.endsWith("/profile")) return jsonResponse({ emailAddress: "mail@example.dk" });
      return jsonResponse({}, 404);
    });
    const { authUrl } = await service.beginGmailOAuth(COMPANY, "user-1", "https://paperclip.example.dk/MAG/magnora");
    const state = new URL(authUrl).searchParams.get("state")!;
    await expect(service.completeGmailOAuth(COMPANY, "user-1", "code", "forged")).rejects.toThrow(/state/);
    const { email } = await service.completeGmailOAuth(COMPANY, "user-1", "code", state);
    expect(email).toBe("mail@example.dk");
    const account = store.gmail.get(COMPANY)!;
    expect(account.refreshTokenEnc).not.toContain("RT-secret");
    const tokenCall = calls.find((c) => c.url.includes("oauth2.googleapis.com"))!;
    expect(String(tokenCall.init?.body)).toContain("code_verifier=");
    expect((await service.integrationStatuses(COMPANY)).find((s) => s.key === "gmail")!.state).toBe("CONNECTED");
    // state is single use
    await expect(service.completeGmailOAuth(COMPANY, "user-1", "code", state)).rejects.toThrow(/state/);
  });

  it("marks the account EXPIRED when Google rejects the refresh token", async () => {
    const { service, store } = makeService(gmailConfig(), (url) =>
      url.includes("oauth2.googleapis.com") ? jsonResponse({ error: "invalid_grant" }, 400) : jsonResponse({}),
    );
    await store.saveGmailAccount({ companyId: COMPANY, email: "a@b.dk", refreshTokenEnc: encryptToken("rt", "GOOGLE_SECRET", COMPANY), scopes: null, status: "connected", lastError: null, connectedAt: null });
    await expect(service.gmailSearch(COMPANY, AGENTS.email.id, "is:unread", 5)).rejects.toMatchObject({ kind: "auth_expired" });
    expect((await service.integrationStatuses(COMPANY)).find((s) => s.key === "gmail")!.state).toBe("EXPIRED");
  });

  it("never sends without approval and respects SEND disabled", async () => {
    const responder = (url: string) => {
      if (url.includes("oauth2.googleapis.com")) return jsonResponse({ access_token: "AT", expires_in: 3600 });
      if (url.includes("/drafts/d1")) return jsonResponse({ id: "d1", message: { id: "m", threadId: "t", payload: { headers: [{ name: "To", value: "kunde@x.dk" }, { name: "Subject", value: "Tilbud" }] } } });
      if (url.endsWith("/drafts/send")) return jsonResponse({ id: "sent-1", threadId: "t" });
      return jsonResponse({}, 404);
    };
    const ctx = makeService(gmailConfig(), responder);
    await ctx.store.saveGmailAccount({ companyId: COMPANY, email: "a@b.dk", refreshTokenEnc: encryptToken("rt", "GOOGLE_SECRET", COMPANY), scopes: null, status: "connected", lastError: null, connectedAt: null });

    await expect(ctx.service.gmailRequestSend(COMPANY, AGENTS.ceo.id, null, "d1", "x")).rejects.toBeInstanceOf(PermissionError);
    const request = await ctx.service.gmailRequestSend(COMPANY, AGENTS.email.id, "run", "d1", "Kunde venter på svar");
    expect(request.status).toBe("pending_approval");
    expect(request.payload).toMatchObject({ to: "kunde@x.dk", subject: "Tilbud" });
    expect(ctx.calls.some((c) => c.url.endsWith("/drafts/send"))).toBe(false);

    // SEND switched off after the request: approval must not send.
    ctx.setConfig(gmailConfig("disabled"));
    const blocked = await ctx.service.approve(COMPANY, "user-1", request.id);
    expect(blocked.status).toBe("failed");
    expect(ctx.calls.some((c) => c.url.endsWith("/drafts/send"))).toBe(false);
    await expect(ctx.service.gmailRequestSend(COMPANY, AGENTS.email.id, "run", "d1", "x")).rejects.toThrow(/SEND permission is disabled/);

    ctx.setConfig(gmailConfig());
    const second = await ctx.service.gmailRequestSend(COMPANY, AGENTS.email.id, "run", "d1", "x");
    expect((await ctx.service.approve(COMPANY, "user-1", second.id)).status).toBe("sent");
  });

  it("archive requires explicit permission and never trashes", async () => {
    const ctx = makeService(gmailConfig(), () => jsonResponse({ access_token: "AT" }));
    await ctx.store.saveGmailAccount({ companyId: COMPANY, email: null, refreshTokenEnc: encryptToken("rt", "GOOGLE_SECRET", COMPANY), scopes: null, status: "connected", lastError: null, connectedAt: null });
    await expect(ctx.service.gmailModifyLabels(COMPANY, AGENTS.email.id, { messageId: "m", archive: true })).rejects.toThrow(/permission is disabled/);
    ctx.setConfig({ gmail: { ...gmailConfig().gmail, allowArchive: true } });
    await expect(ctx.service.gmailModifyLabels(COMPANY, AGENTS.email.id, { messageId: "m", addLabelIds: ["TRASH"] })).rejects.toThrow(/Trash/);
  });
});

describe("affiliate + health", () => {
  it("reports per provider with previous-period comparison and flags repeated failures", async () => {
    const ctx = makeService(
      {
        affiliate: {
          providers: [
            { key: "net", displayName: "Net", statsUrl: "https://api.net.test/r?s={startDate}&e={endDate}", apiToken: ref("aff-token"), fields: { clicks: "c", commission: "k" } },
            { key: "broken", displayName: "Broken", statsUrl: "https://api.broken.test/r", apiToken: ref("aff-token") },
            { key: "unset", displayName: "Unset" },
          ],
        },
      },
      (url) => {
        if (url.includes("broken")) return new Response("nope", { status: 401 });
        return jsonResponse(url.includes("s=2026-11-26") ? [{ c: 200, k: 50 }] : [{ c: 100, k: 25 }]);
      },
    );
    const report = await ctx.service.affiliateReport(COMPANY, "yesterday", { agentId: AGENTS.affiliate.id });
    const [net, broken, unset] = report.providers;
    expect(report.range).toEqual({ startDate: "2026-11-26", endDate: "2026-11-26" });
    expect(net).toMatchObject({ status: "CONNECTED", current: { clicks: 200, commission: 50 }, previous: { clicks: 100 } });
    expect(net!.change!.clicks).toBe(1);
    expect(broken!.status).toBe("EXPIRED");
    expect(unset!.status).toBe("NOT_CONFIGURED");
    await expect(ctx.service.affiliateReport(COMPANY, "7d", { agentId: AGENTS.social.id })).rejects.toBeInstanceOf(PermissionError);

    await ctx.service.affiliateReport(COMPANY, "today");
    await ctx.service.affiliateReport(COMPANY, "7d");
    const health = await ctx.service.healthReport(COMPANY);
    expect(health.repeatedFailures.some((f) => f.key.includes("affiliate.broken"))).toBe(true);
    expect(JSON.stringify(health)).not.toContain("AFF_TOKEN");
  });
});
