#!/usr/bin/env node
/**
 * pnpm audit:integrations [--env-file deploy/magnora/.env] [--strict] [--json]
 *
 * Prints CONFIGURED / MISSING / PLACEHOLDER for every environment variable the
 * Magnora deployment uses. Secret VALUES are never printed – only status.
 *
 * Credentials for Gmail, Meta, LinkedIn, X and affiliate networks live in
 * Paperclip Secrets (browser), not in env; their live status is on the
 * Magnora page → Integrations, and via the `integrations_status` agent tool.
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @typedef {{ name: string, category: string, required: boolean, secret: boolean, note?: string, alternatives?: string[] }} Spec */

/** @type {Spec[]} */
export const ENV_SPECS = [
  { name: "PAPERCLIP_DOMAIN", category: "DEPLOYMENT", required: true, secret: false, note: "Public domain (Caddy HTTPS + PAPERCLIP_PUBLIC_URL)" },
  { name: "ACME_EMAIL", category: "DEPLOYMENT", required: true, secret: false, note: "Let's Encrypt contact" },
  { name: "DATABASE_URL", category: "DATABASE", required: true, secret: true, note: "Supabase pooler URL" },
  { name: "DATABASE_MIGRATION_URL", category: "DATABASE", required: false, secret: true, note: "Supabase session/direct URL for migrations" },
  { name: "DATABASE_PREPARED_STATEMENTS", category: "DATABASE", required: false, secret: false, note: "false for the Supabase transaction pooler" },
  { name: "BETTER_AUTH_SECRET", category: "SECURITY", required: true, secret: true },
  { name: "PAPERCLIP_SECRETS_MASTER_KEY", category: "SECURITY", required: true, secret: true, note: "Encrypts Paperclip Secrets – back it up offline" },
  { name: "PAPERCLIP_AGENT_JWT_SECRET", category: "SECURITY", required: true, secret: true },
  { name: "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", category: "SECURITY", required: true, secret: true },
  { name: "PAPERCLIP_AUTH_DISABLE_SIGN_UP", category: "SECURITY", required: false, secret: false, note: "true after your admin account exists" },
  { name: "ANTHROPIC_API_KEY", category: "AI PROVIDERS", required: true, secret: true, note: "Claude Code adapter (agents)", alternatives: ["CLAUDE_CODE_OAUTH_TOKEN"] },
  { name: "OPENAI_API_KEY", category: "AI PROVIDERS", required: false, secret: true, note: "Only for Codex/OpenAI-based agents" },
  { name: "GEMINI_API_KEY", category: "AI PROVIDERS", required: false, secret: true },
  { name: "GITHUB_TOKEN", category: "GITHUB", required: false, secret: true, note: "Prefer a GitHub app connection or Paperclip Secret", alternatives: ["GH_TOKEN"] },
  { name: "PAPERCLIP_DEPLOYMENT_MODE", category: "PAPERCLIP", required: false, secret: false, note: "Set by docker-compose (authenticated)" },
  { name: "PAPERCLIP_PUBLIC_URL", category: "PAPERCLIP", required: false, secret: false, note: "Set by docker-compose from PAPERCLIP_DOMAIN" },
];

/** Integrations whose credentials are stored in Paperclip Secrets (shown for completeness). */
export const SECRET_STORE_INTEGRATIONS = [
  { category: "GOOGLE / GMAIL", items: ["GOOGLE_CLIENT_ID (plugin setting)", "GOOGLE_CLIENT_SECRET (Paperclip Secret)", "Gmail account (OAuth connect button)"] },
  { category: "SOCIAL MEDIA", items: ["META_ACCESS_TOKEN (Facebook Page / Instagram)", "LINKEDIN_ACCESS_TOKEN", "X_ACCESS_TOKEN"] },
  { category: "AFFILIATE", items: ["AFFILIATE_API_KEY per provider (+ report URL)"] },
];

const PLACEHOLDER_PATTERNS = [/^<.*>$/, /<[A-Z_]+>/, /change[-_]?me/i, /^paperclip-dev-secret$/, /^x+$/i, /^your[-_ ]/i, /^todo$/i];

/** Parse a dotenv file without evaluating it. */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    env[match[1]] = value;
  }
  return env;
}

/** @returns {"CONFIGURED" | "MISSING" | "PLACEHOLDER"} */
export function classify(value) {
  if (value === undefined || value === null || String(value).trim() === "") return "MISSING";
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(String(value).trim())) ? "PLACEHOLDER" : "CONFIGURED";
}

export function auditEnv(env, specs = ENV_SPECS) {
  return specs.map((spec) => {
    let status = classify(env[spec.name]);
    let via = spec.name;
    if (status === "MISSING" && spec.alternatives) {
      for (const alt of spec.alternatives) {
        const altStatus = classify(env[alt]);
        if (altStatus !== "MISSING") {
          status = altStatus;
          via = alt;
          break;
        }
      }
    }
    return { name: spec.name, via, category: spec.category, required: spec.required, status, note: spec.note ?? "" };
  });
}

export function formatReport(results) {
  const lines = [];
  const width = Math.max(...results.map((r) => r.name.length)) + 2;
  let category = "";
  for (const result of results) {
    if (result.category !== category) {
      category = result.category;
      lines.push("", category);
    }
    const tag = result.required ? "required" : "optional";
    const via = result.via !== result.name ? ` (via ${result.via})` : "";
    lines.push(`  ${result.name.padEnd(width)}${result.status.padEnd(12)} ${tag}${via}${result.note ? ` – ${result.note}` : ""}`);
  }
  for (const group of SECRET_STORE_INTEGRATIONS) {
    lines.push("", `${group.category} (Paperclip Secrets – see Magnora → Integrations)`);
    for (const item of group.items) lines.push(`  ${item}`);
  }
  const missing = results.filter((r) => r.required && r.status !== "CONFIGURED");
  lines.push("", missing.length === 0 ? "All required variables are configured." : `Missing/placeholder required: ${missing.map((r) => r.name).join(", ")}`);
  return lines.join("\n");
}

function main(argv) {
  const args = argv.slice(2);
  const envFileIndex = args.indexOf("--env-file");
  let envFile = envFileIndex >= 0 ? args[envFileIndex + 1] : undefined;
  if (!envFile && existsSync("deploy/magnora/.env")) envFile = "deploy/magnora/.env";
  const fileEnv = envFile && existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
  const env = { ...fileEnv, ...process.env };
  const results = auditEnv(env);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ envFile: envFile ?? null, results }, null, 2));
  } else {
    console.log(`Magnora integration audit${envFile ? ` (env file: ${envFile} + process env)` : " (process env)"}`);
    console.log(formatReport(results));
  }
  if (args.includes("--strict") && results.some((r) => r.required && r.status !== "CONFIGURED")) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv);
