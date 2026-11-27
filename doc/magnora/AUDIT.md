# Magnora – repository audit og arkitektur

Dato: 2026-11-27 · Repository: `MagnoraMarketing/MagnoraMarketing-Agentfirm`

## 1. Hvilken Paperclip-version

- Fork af `paperclipai/paperclip`. Seneste release-noter i repoet: **v2026.722.0** (22. juli 2026).
  Seneste commit på arbejdsgrenen: 6. aug. 2026 (master + feature-branch for skill-analytics).
- Pakke-versioner: `@paperclipai/server` 0.3.1, `@paperclipai/plugin-sdk` 1.0.0. pnpm 9.15.4, Node ≥ 20.
- 211 database-migrations (Drizzle) i `packages/db/src/migrations`.

## 2. Hvordan serveren startes

- Dev: `pnpm dev` (embedded PostgreSQL, ingen ekstern DB nødvendig).
- Production: `Dockerfile` (multi-stage) → `node --import tsx/loader server/dist/index.js`, port 3100.
  Imaget indeholder agent-CLI'erne `claude`, `codex`, `opencode`, `gemini`.
- Konfiguration via env + `PAPERCLIP_CONFIG` (`/paperclip/instances/default/config.json`).
- Migrations køres ved opstart (`PAPERCLIP_MIGRATION_AUTO_APPLY=true` i ikke-interaktive miljøer),
  evt. over en separat `DATABASE_MIGRATION_URL`.

## 3. Hvordan UI'et startes

- React/Vite-app i `ui/`. I production bygges den ind i server-imaget og serveres af serveren selv
  (`SERVE_UI=true`) – samme origin som API'et. Separat Vercel-hosting er ikke nødvendig.

## 4. Database

- PostgreSQL (Drizzle ORM, `postgres.js`). Embedded Postgres i dev, ekstern i production.
- Supabase understøttes allerede: `DATABASE_PREPARED_STATEMENTS=false` til Supavisor transaction pooler,
  `DATABASE_POOL_MAX`, `DATABASE_MIGRATION_URL`, `?sslmode=require`.
- Indbygget backup (`PAPERCLIP_DB_BACKUP_*`, pg_dump eller JavaScript-engine) + health-advarsler.

## 5. Hvordan agents køres

- Agenter er rækker i DB med adapter (`claude_local`, `codex_local`, `gemini_local`, `opencode_local`,
  `pi_local`, `cursor`, `hermes`, `openclaw_gateway`, …). Heartbeat-scheduleren (`HEARTBEAT_SCHEDULER_*`)
  vækker agenter; hver kørsel er et `heartbeat_run` med logs, omkostninger og status.
- Adapterne starter CLI'erne inde i containeren med en kortlivet JWT (`PAPERCLIP_API_KEY`) mod Paperclip-API'et.
- Arbejde organiseres som issues (tasks), child issues, projekter, mål, org-chart (`reportsTo`).

## 6. Secrets

- `company_secrets` med providers `local_encrypted` (AES med `PAPERCLIP_SECRETS_MASTER_KEY`),
  `aws_secrets_manager` (+ stubs for GCP/Vault). Strict mode kræver secret-refs for følsomme env-vars.
- Per-agent secret-grants, run-bound secret-API, audit af hver læsning, redaction i run-logs.
- UI viser kun navne/status – aldrig værdier.

## 7. Channels / integrationer

- **Apps v2 / Connections** (`tool_applications`, `tool_connections`): MCP (remote/stdio) og REST-forbindelser
  med OAuth (PKCE, refresh, `EXPIRED`-status, reconnect), profiler og allow/ask-first/block-regler, audit.
  Katalog: GitHub, Slack, Notion, Linear, Google Sheets, Sentry, Vercel, Zapier, Context7, Anthropic, generisk OAuth/API-nøgle.
- **Plugins** (`packages/plugins/sdk`): agent-tools, UI-sider/widgets, jobs, webhooks, egen DB-namespace,
  secret-refs i config, http.outbound. Dette er den rigtige udvidelsesvej for Gmail/social/affiliate.
- Der fandtes **ingen** Gmail-, Facebook-, Instagram-, LinkedIn-, X- eller affiliate-integration.
  Paperclip-agenter kan kun bruge MCP-/plugin-tools; Google har ingen officiel Gmail-MCP-server vi kunne verificere,
  derfor er Gmail bygget som plugin mod den officielle Gmail REST API.

## 8. Tools

- Built-in tools + plugin-tools + MCP-tools eksponeres via tool-gateway'en med policy-beslutninger
  (`allow` / `require_approval` / `deny`) pr. agent, audit og rate limits (`PAPERCLIP_MCP_GATEWAY_*`).

## 9. Scheduled jobs / heartbeats

- **Routines** (`routines`-service): cron-triggers med timezone, concurrency- og catch-up-policy, redigerbare i UI.
- Heartbeat-scheduler for agent-wakeups; plugin-jobs (`jobs.schedule`) for plugin-baggrundsarbejde.

## 10. Hvad virker allerede (genbrugt, ikke genopbygget)

| Krav | Eksisterende Paperclip-funktion |
| --- | --- |
| Company/org/agents, pause/start/arkivér, instruktioner, model | Agents UI + org-chart |
| Tasks, delegering, opfølgning | Issues, child issues, wakeups |
| Approvals | `approvals` + issue-interactions (bekræftelser) |
| Budget/cost control | `budgetMonthlyCents` pr. agent, cost events, budget incidents, auto-pause |
| Schedules | Routines (cron + timezone) |
| Secrets (masked) | Company secrets + secret-refs |
| Authentication | Better Auth, `authenticated` mode, first-admin bootstrap, sign-up kan lukkes |
| Audit logs | Activity log + security audit |
| Rate limiting | Auth rate limit, MCP gateway limits |
| Health | `/api/health` (server + DB-probe + backup-status + commit) |
| Backup | Indbygget planlagt DB-backup |

## 11. Hvad blev tilføjet

| Fil/mappe | Formål |
| --- | --- |
| `packages/plugins/plugin-magnora/` | Plugin: Gmail (OAuth/PKCE, drafts, approval-send), social (FB/IG/LinkedIn/X, approval-publish), affiliate (`AffiliateProvider` + generisk officiel-API-provider), integrations/approvals/affiliate/fejl-dashboard, 11 agent-tools, fejl-log med retry |
| `companies/magnora-marketing/` | Importérbar company-pakke: 8 agenter, budgetter, permissions, fælles skill, 5 rutiner |
| `deploy/magnora/` | Production: Docker Compose (Paperclip + Caddy HTTPS), Supabase som DB, bootstrap/deploy/backup-scripts, guide |
| `.github/workflows/magnora-deploy.yml` | CI → deploy (kun ved grønt) → health check |
| `scripts/audit-integrations.mjs` | `pnpm audit:integrations` – status uden værdier |
| `Dockerfile` | Bygger Magnora-plugin'et ind i imaget |

## 12. Cloud-arkitektur (valgt)

- **Frontend + Paperclip server + agents + scheduler:** én Docker-container på en VM
  (Oracle Cloud Free Tier Ampere A1 anbefalet; Hetzner CAX21 som billigt alternativ). Caddy foran med HTTPS.
- **Database:** Supabase PostgreSQL (projekt `lwhyzhqwqxgryofdldzh`) via Supavisor pooler med TLS.
- **Hvorfor ikke Supabase/Vercel/Colab til serveren:** Paperclip kræver en langvarig proces, der starter
  agent-CLI'er og kører schedules 24/7. Supabase Edge Functions og Vercel Functions er kortlivede;
  Colab er ikke en server. Supabase er derfor kun database.
- **Railway/Render/Fly.io** kan også køre `Dockerfile`'en med en persistent volume, men koster mere for samme RAM;
  VM-opsætningen er gratis på Oracle og giver mest kontrol.

## 13. Environment variables

Komplet liste og status: `pnpm audit:integrations` (viser aldrig værdier). Se også `deploy/magnora/.env.example`.

| Kategori | Variabler | Hvor |
| --- | --- | --- |
| CORE | `PORT`, `HOST`, `SERVE_UI`, `NODE_ENV`, `PAPERCLIP_HOME` | Sat i compose |
| DEPLOYMENT | `PAPERCLIP_DOMAIN`, `ACME_EMAIL` | `.env` |
| PAPERCLIP | `PAPERCLIP_DEPLOYMENT_MODE=authenticated`, `PAPERCLIP_DEPLOYMENT_EXPOSURE=public`, `PAPERCLIP_PUBLIC_URL`, `PAPERCLIP_ALLOWED_HOSTNAMES`, `TRUST_PROXY`, `PAPERCLIP_DB_BACKUP_*`, `PAPERCLIP_TELEMETRY_DISABLED` | Sat i compose |
| DATABASE | `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `DATABASE_PREPARED_STATEMENTS`, `DATABASE_POOL_MAX`, `PAPERCLIP_MIGRATION_AUTO_APPLY` | `.env` |
| SECURITY | `BETTER_AUTH_SECRET`, `PAPERCLIP_SECRETS_MASTER_KEY`, `PAPERCLIP_SECRETS_STRICT_MODE`, `PAPERCLIP_AGENT_JWT_SECRET`, `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`, `PAPERCLIP_AUTH_DISABLE_SIGN_UP`, `PAPERCLIP_AUTH_RATE_LIMIT_ENABLED` | `.env` |
| AI PROVIDERS | `ANTHROPIC_API_KEY` (påkrævet for `claude_local`), `OPENAI_API_KEY`, `GEMINI_API_KEY` (valgfri) | `.env` |
| GITHUB | `GITHUB_TOKEN`/`GH_TOKEN` (valgfri) | Paperclip Secrets |
| GOOGLE / GMAIL | `GOOGLE_CLIENT_ID` (plugin-setting), `GOOGLE_CLIENT_SECRET` | Paperclip Secrets |
| SOCIAL MEDIA | `META_ACCESS_TOKEN`, `LINKEDIN_ACCESS_TOKEN`, `X_ACCESS_TOKEN` | Paperclip Secrets |
| AFFILIATE | API-token pr. provider | Paperclip Secrets |

Ingen nye env-variabler er opfundet i Paperclip-serveren; integration-credentials ligger i Paperclips secrets-vault.

## 14. Kendte begrænsninger

- Awin/Partner-Ads m.fl.: dokumentationen kunne ikke hentes fra build-miljøet, så netværksspecifikke
  endpoints er ikke hardcodet. Den generiske provider bruger den rapport-URL du kopierer fra netværkets officielle API-dokumentation.
- Instagram-publicering kræver en offentlig billede-URL.
- Tokens til Meta/LinkedIn/X skal fornyes manuelt når de udløber (status vises som fejl/EXPIRED ved test).
- Upstream-workflows (fx `docker.yml`, `release.yml`) ligger stadig i repoet og kører på `master`;
  deaktivér dem under GitHub → Actions hvis du ikke vil bruge Actions-minutter på dem.
