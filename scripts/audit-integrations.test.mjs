import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { auditEnv, classify, formatReport, parseEnvFile } from "./audit-integrations.mjs";

test("classifies missing, placeholder and configured values", () => {
  assert.equal(classify(undefined), "MISSING");
  assert.equal(classify("  "), "MISSING");
  assert.equal(classify("<DB_PASSWORD>"), "PLACEHOLDER");
  assert.equal(classify("postgresql://u:<DB_PASSWORD>@h/db"), "PLACEHOLDER");
  assert.equal(classify("paperclip-dev-secret"), "PLACEHOLDER");
  assert.equal(classify("sk-ant-real"), "CONFIGURED");
});

test("parses dotenv files without evaluating them", () => {
  const env = parseEnvFile('# c\nA=1\nexport B="two words"\nC=x # trailing\nBAD LINE\nD=$(rm -rf /)\n');
  assert.deepEqual(env, { A: "1", B: "two words", C: "x", D: "$(rm -rf /)" });
});

test("accepts alternatives such as CLAUDE_CODE_OAUTH_TOKEN", () => {
  const anthropic = auditEnv({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }).find((r) => r.name === "ANTHROPIC_API_KEY");
  assert.equal(anthropic.status, "CONFIGURED");
  assert.equal(anthropic.via, "CLAUDE_CODE_OAUTH_TOKEN");
});

test("never prints secret values", () => {
  const secret = "sk-ant-super-secret-value-123";
  const report = formatReport(auditEnv({ ANTHROPIC_API_KEY: secret, DATABASE_URL: "postgresql://postgres:hunter2@db/postgres" }));
  assert.ok(!report.includes(secret));
  assert.ok(!report.includes("hunter2"));
  assert.match(report, /ANTHROPIC_API_KEY\s+CONFIGURED/);
  assert.match(report, /GOOGLE_CLIENT_SECRET/);
});

test("CLI reads an env file and --strict fails on missing required values", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-"));
  const file = path.join(dir, ".env");
  writeFileSync(file, "ANTHROPIC_API_KEY=sk-secret-abc\n");
  const script = new URL("./audit-integrations.mjs", import.meta.url).pathname;
  const out = execFileSync(process.execPath, [script, "--env-file", file], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.match(out, /ANTHROPIC_API_KEY\s+CONFIGURED/);
  assert.match(out, /DATABASE_URL\s+MISSING/);
  assert.ok(!out.includes("sk-secret-abc"));
  assert.throws(() => execFileSync(process.execPath, [script, "--env-file", file, "--strict"], { encoding: "utf8", env: { PATH: process.env.PATH }, stdio: "pipe" }));
});
