import { describe, expect, it } from "vitest";
import { JsonAffiliateProvider } from "../src/affiliate/json-provider.js";
import { isAgentAllowed, parseConfig } from "../src/config.js";
import { decryptToken, encryptToken } from "../src/crypto.js";
import { buildGoogleAuthUrl, buildRawMessage, extractText } from "../src/gmail/gmail.js";
import { IntegrationError, redact, requestJson } from "../src/http.js";
import { previousRange, resolvePeriod } from "../src/periods.js";
import { jsonResponse, ref } from "./helpers.js";

describe("config", () => {
  it("applies least-privilege defaults", () => {
    const config = parseConfig({});
    expect(config.gmail.enabled).toBe(false);
    expect(config.gmail.sendMode).toBe("with_approval");
    expect(config.gmail.allowArchive).toBe(false);
    expect(config.gmail.draftAgents).toEqual(["email"]);
    expect(config.social.facebook.publishMode).toBe("with_approval");
    expect(config.social.linkedin.apiVersion).toBe("202609");
    expect(config.timezone).toBe("Europe/Copenhagen");
  });

  it("only accepts well-formed secret refs", () => {
    expect(parseConfig({ gmail: { clientSecret: "plain-text-secret" } }).gmail.clientSecret).toBeNull();
    expect(parseConfig({ gmail: { clientSecret: ref("abc") } }).gmail.clientSecret).toEqual({ type: "secret_ref", secretId: "abc", version: "latest" });
  });

  it("matches agents by name or url key", () => {
    expect(isAgentAllowed(["social-media"], { name: "Social Media" })).toBe(true);
    expect(isAgentAllowed(["Social Media"], { name: "x", urlKey: "social-media" })).toBe(true);
    expect(isAgentAllowed(["email"], { name: "Sales", urlKey: "sales" })).toBe(false);
    expect(isAgentAllowed(["*"], { name: "Anyone" })).toBe(true);
  });
});

describe("periods", () => {
  const now = new Date("2026-11-27T23:30:00Z"); // 00:30 on the 28th in Copenhagen
  it("resolves periods in the report timezone", () => {
    expect(resolvePeriod("today", now, "Europe/Copenhagen")).toEqual({ startDate: "2026-11-28", endDate: "2026-11-28" });
    expect(resolvePeriod("yesterday", now, "Europe/Copenhagen")).toEqual({ startDate: "2026-11-27", endDate: "2026-11-27" });
    expect(resolvePeriod("7d", now, "Europe/Copenhagen")).toEqual({ startDate: "2026-11-22", endDate: "2026-11-28" });
    expect(resolvePeriod("this_month", now, "Europe/Copenhagen")).toEqual({ startDate: "2026-11-01", endDate: "2026-11-28" });
  });
  it("computes the previous equal-length range", () => {
    expect(previousRange({ startDate: "2026-11-22", endDate: "2026-11-28" })).toEqual({ startDate: "2026-11-15", endDate: "2026-11-21" });
    expect(previousRange({ startDate: "2026-03-01", endDate: "2026-03-01" })).toEqual({ startDate: "2026-02-28", endDate: "2026-02-28" });
  });
});

describe("token encryption", () => {
  it("round-trips and fails closed with another key or company", () => {
    const enc = encryptToken("refresh-123", "secret", "company-a");
    expect(enc).not.toContain("refresh-123");
    expect(decryptToken(enc, "secret", "company-a")).toBe("refresh-123");
    expect(decryptToken(enc, "other", "company-a")).toBeNull();
    expect(decryptToken(enc, "secret", "company-b")).toBeNull();
  });
});

describe("http", () => {
  it("retries transient errors then succeeds", async () => {
    let n = 0;
    const result = await requestJson(async () => (++n < 3 ? new Response("busy", { status: 503 }) : jsonResponse({ ok: true })), "https://x", { retryBaseMs: 1 });
    expect(result).toEqual({ ok: true });
    expect(n).toBe(3);
  });
  it("maps 401 to auth_expired without retrying", async () => {
    let n = 0;
    await expect(requestJson(async () => (n++, new Response("no", { status: 401 })), "https://x", { retryBaseMs: 1 })).rejects.toMatchObject({ kind: "auth_expired" });
    expect(n).toBe(1);
  });
  it("redacts credentials", () => {
    expect(redact("Bearer abc.def access_token=zzz")).toBe("Bearer [redacted] access_token=[redacted]");
    expect(redact('{"refresh_token":"rt"}')).toBe('{"refresh_token":"[redacted]"}');
  });
});

describe("gmail helpers", () => {
  it("builds a PKCE consent URL with offline access", () => {
    const url = new URL(buildGoogleAuthUrl({ clientId: "cid", redirectUri: "https://h/MAG/magnora", state: "s", codeVerifier: "v".repeat(43) }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("gmail.compose");
  });
  it("encodes UTF-8 subjects and rejects header injection", () => {
    const raw = Buffer.from(buildRawMessage({ to: "a@b.dk", subject: "Hej Søren", body: "Tak" }), "base64url").toString("utf8");
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(() => buildRawMessage({ to: "a@b.dk\r\nBcc: evil@x.com", subject: "x", body: "y" })).toThrow(IntegrationError);
  });
  it("extracts plain text, falling back to HTML", () => {
    const html = Buffer.from("<p>Hello <b>there</b></p>").toString("base64url");
    expect(extractText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: html } }] })).toBe("Hello there");
  });
});

describe("JsonAffiliateProvider", () => {
  const base = {
    key: "net",
    displayName: "Network",
    enabled: true,
    statsUrl: "https://api.example-network.test/report?from={startDate}&to={endDate}",
    apiToken: { type: "secret_ref" as const, secretId: "t" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    rowsPath: "data.rows",
    fields: { clicks: "clicks", leads: "leads", conversions: "orders", sales: "revenue.amount", commission: "commission", payouts: "" },
    currency: "DKK",
  };

  it("sums mapped fields across rows and substitutes the date range", async () => {
    let seen = "";
    let auth = "";
    const provider = new JsonAffiliateProvider(base, async (url, init) => {
      seen = url;
      auth = (init?.headers as Record<string, string>).Authorization;
      return jsonResponse({ data: { rows: [{ clicks: 100, leads: 3, orders: 4, revenue: { amount: "1000.50" }, commission: 80 }, { clicks: 50, leads: "1", orders: 1, revenue: { amount: 200 }, commission: "20" }] } });
    }, async () => "TOKEN");
    const stats = await provider.getStats({ startDate: "2026-11-01", endDate: "2026-11-07" });
    expect(seen).toBe("https://api.example-network.test/report?from=2026-11-01&to=2026-11-07");
    expect(auth).toBe("Bearer TOKEN");
    expect(stats).toMatchObject({ clicks: 150, leads: 4, conversions: 5, sales: 1200.5, commission: 100, payouts: 0 });
    expect(stats.conversionRate).toBeCloseTo(5 / 150);
    expect(await provider.getCommission({ startDate: "2026-11-01", endDate: "2026-11-07" })).toBe(100);
  });

  it("is NOT_CONFIGURED without a token and rejects non-https URLs", async () => {
    expect(new JsonAffiliateProvider({ ...base, apiToken: null }, fetch, async () => null).status()).toBe("not_configured");
    const insecure = new JsonAffiliateProvider({ ...base, statsUrl: "http://insecure.test/r" }, fetch, async () => "T");
    await expect(insecure.getStats({ startDate: "2026-11-01", endDate: "2026-11-01" })).rejects.toThrow(/https/);
  });
});
