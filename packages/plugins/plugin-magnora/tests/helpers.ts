import { MagnoraService, type AgentInfo } from "../src/service.js";
import { MemoryStore } from "../src/store.js";

export const COMPANY = "11111111-1111-4111-8111-111111111111";

export const AGENTS: Record<string, AgentInfo> = {
  social: { id: "a-social", name: "Social Media", urlKey: "social-media" },
  email: { id: "a-email", name: "Email", urlKey: "email" },
  ceo: { id: "a-ceo", name: "CEO", urlKey: "ceo" },
  sales: { id: "a-sales", name: "Sales", urlKey: "sales" },
  affiliate: { id: "a-aff", name: "Affiliate", urlKey: "affiliate" },
};

export const ref = (id: string) => ({ type: "secret_ref", secretId: id, version: "latest" });

export interface FakeCall {
  url: string;
  init?: RequestInit;
}

export type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function makeService(config: Record<string, unknown>, responder: Responder = () => jsonResponse({})) {
  const store = new MemoryStore();
  const calls: FakeCall[] = [];
  const secrets: Record<string, string> = {
    "fb-token": "FB_TOKEN",
    "x-token": "X_TOKEN",
    "google-secret": "GOOGLE_SECRET",
    "aff-token": "AFF_TOKEN",
  };
  let currentConfig = config;
  const service = new MagnoraService({
    store,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return responder(url, init);
    },
    getConfig: async () => currentConfig,
    resolveSecret: async (secretRef) => {
      const value = secrets[secretRef.secretId];
      if (value === undefined) throw new Error("missing secret");
      return value;
    },
    getAgent: async (agentId) => Object.values(AGENTS).find((a) => a.id === agentId) ?? null,
    now: () => new Date("2026-11-27T09:00:00Z"),
  });
  return {
    service,
    store,
    calls,
    secrets,
    setConfig(next: Record<string, unknown>) {
      currentConfig = next;
    },
  };
}
