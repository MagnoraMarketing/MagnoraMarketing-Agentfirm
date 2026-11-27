# Magnora – cloud deployment (ingen lokal installation)

Alt kører i skyen. Din Windows-computer bruges kun til browser, GitHub og Claude Code.

```
GitHub (main/master)
   │ push
   ▼
GitHub Actions: CI (typecheck · tests · build)  ── fejler? → intet deployes
   │ grønt
   ▼ SSH
Cloud-VM (Oracle Cloud Free Tier / Hetzner)
   ├─ Caddy  ── HTTPS (Let's Encrypt) ── https://<dit-domæne>
   └─ Paperclip server (Docker)
        ├─ Web UI + API
        ├─ Agents (Claude Code CLI i containeren)
        ├─ Scheduler: routines, heartbeats, plugin-jobs
        └─ Magnora-plugin (Gmail, sociale kanaler, affiliate)
   │ TLS
   ▼
Supabase PostgreSQL (projekt lwhyzhqwqxgryofdldzh) – managed database + backups
   │
   ▼
Eksterne API'er: Anthropic/OpenAI, Gmail API, Meta Graph, LinkedIn, X, affiliate-netværk
```

**Hvorfor ikke alt i Supabase?** Supabase leverer databasen (managed Postgres, backups,
TLS). Paperclip-serveren er en langvarig Node-proces, der starter agent-CLI'er og kører
schedules 24/7 – det kan Supabase (Edge Functions = korte, tidsbegrænsede kald) ikke. Derfor
kører serveren på en lille VM og bruger Supabase som database.

**Hvorfor ikke Vercel til UI?** Paperclip-serveren leverer selv UI'et på samme domæne. Det
giver én HTTPS-origin, simple sikre cookies og ingen CORS. Et separat Vercel-frontend ville
kun tilføje fejlkilder.

## 1. Vælg VM (anbefaling)

| Valg | Pris | Kommentar |
| --- | --- | --- |
| **Oracle Cloud Free Tier – Ampere A1** (2–4 OCPU, 12–24 GB RAM, Ubuntu 24.04, arm64) | 0 kr | Anbefalet. Opgradér kontoen til *Pay As You Go* (stadig gratis inden for Always Free) så instansen ikke bliver genindvundet ved lav brug, og for at undgå "out of capacity". |
| Hetzner Cloud CAX21 (4 vCPU arm64, 8 GB) | ca. 6–7 €/md. | Mest stabile billige alternativ, hvis Oracle ikke har kapacitet. |

Krav: mindst 4 GB RAM (8+ anbefalet, fordi Docker-imaget bygges på serveren og agenter kører i containeren).

## 2. Supabase

1. Supabase dashboard → projekt `lwhyzhqwqxgryofdldzh` → **Connect**.
2. Kopiér **Transaction pooler** (port 6543) → `DATABASE_URL`, og **Session pooler** (port 5432) → `DATABASE_MIGRATION_URL`. Indsæt dit database-password og tilføj `?sslmode=require`.
   (Den direkte forbindelse `db.lwhyzhqwqxgryofdldzh.supabase.co` er kun IPv6 på free plan – brug pooleren fra en IPv4-VM.)
3. Paperclip opretter selv alle tabeller (migrations kører automatisk ved start).
4. Backups: Supabase Pro har daglige backups/PITR. På Free plan er Paperclips egen daglige backup (nedenfor) din backup – overvej Pro når systemet bruges i drift.

## 3. Opret VM og domæne

1. Opret VM'en (Ubuntu 24.04). Indsæt hele `deploy/magnora/bootstrap-server.sh` som **cloud-init / user data** – eller kør den som root via konsollens browser-SSH.
2. **Oracle:** VCN → Security List → tilføj ingress TCP 80 og 443 fra `0.0.0.0/0`.
3. DNS hos din domæneudbyder: A-record `ai.magnoramarketing.dk` (eller andet) → VM'ens offentlige IP.

## 4. Første start (i browser-SSH på VM'en)

```bash
sudo -iu deploy
```

Tilføj den public key, som bootstrap-scriptet udskrev, under GitHub → repo → **Settings → Deploy keys** (read-only). Derefter:

```bash
git clone git@github.com:MagnoraMarketing/MagnoraMarketing-Agentfirm.git /opt/magnora
```

```bash
cd /opt/magnora/deploy/magnora && cp .env.example .env && chmod 600 .env && nano .env
```

Generér hemmeligheder med `openssl rand -base64 48` (og `-base64 32` til `PAPERCLIP_SECRETS_MASTER_KEY`). Gem `PAPERCLIP_SECRETS_MASTER_KEY` et sikkert sted offline – uden den kan Paperclip Secrets ikke dekrypteres.

```bash
/opt/magnora/deploy/magnora/deploy.sh
```

Første build tager 10–20 min. Kontrollér konfigurationen (viser kun status, aldrig værdier):

```bash
cd /opt/magnora && docker compose -f deploy/magnora/docker-compose.yml --env-file deploy/magnora/.env exec server node scripts/audit-integrations.mjs
```

## 5. Login – du er eneste administrator

```bash
cd /opt/magnora/deploy/magnora && docker compose --env-file .env exec server node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts auth bootstrap-ceo --base-url "https://$(grep ^PAPERCLIP_DOMAIN= .env | cut -d= -f2)"
```

1. Åbn den udskrevne engangs-URL, opret din konto → du er instance admin.
2. Luk for nye tilmeldinger: sæt `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` i `.env` og kør `deploy.sh` igen.

## 6. Magnora company + plugin

1. **Plugin:** Paperclip → Company settings → Instance → Plugins → Install → local path
   `/app/packages/plugins/plugin-magnora`.
2. **Company:** importér `companies/magnora-marketing` (8 agenter, budgetter, rutiner):

```bash
cd /opt/magnora/deploy/magnora && docker compose --env-file .env exec server node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts company import /app/companies/magnora-marketing --target new --api-base http://127.0.0.1:3100 --yes
```

   (CLI'en beder om board-login første gang – følg linket i browseren.) Alternativt: UI → *Import company* → upload mappen.
3. Paperclip → Secrets: opret `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_SECRET`, `META_ACCESS_TOKEN`, `LINKEDIN_ACCESS_TOKEN`, `X_ACCESS_TOKEN`, affiliate-tokens. Vælg dem i Magnora-plugin'ets settings.
4. Magnora → Integrations → **Connect Gmail** og **Test connection** for hver kanal.

## 7. Automatisk deployment fra GitHub

GitHub → repo → Settings → **Environments → production**:

| Navn | Type | Værdi |
| --- | --- | --- |
| `DEPLOY_HOST` | secret | VM'ens IP eller DNS |
| `DEPLOY_SSH_KEY` | secret | Privat SSH-nøgle (ed25519) kun til deploy |
| `DEPLOY_KNOWN_HOSTS` | secret | Output af `ssh-keyscan <host>` (kør i VM-konsollen: `ssh-keyscan localhost` og erstat `localhost` med IP) |
| `PAPERCLIP_DOMAIN` | variable | f.eks. `ai.magnoramarketing.dk` |
| `DEPLOY_USER` / `DEPLOY_PATH` | variable (valgfri) | `deploy` / `/opt/magnora` |

SSH-nøglen laves i VM'ens browser-konsol:

```bash
ssh-keygen -t ed25519 -N "" -f ~/gha_deploy -C github-actions && cat ~/gha_deploy.pub >> ~/.ssh/authorized_keys && cat ~/gha_deploy
```

Indsæt det sidste output (privat nøgle) som `DEPLOY_SSH_KEY`, og slet derefter filerne `~/gha_deploy*`.

Herefter: **`git push origin master`** (eller `main`) → CI → deploy → health check. Fejler CI eller build, kører den gamle version videre. Tilføj gerne *Required reviewers* på environment'et hvis du vil godkende hver deploy.

## 8. Backup og restore

- **Automatisk:** Paperclip tager daglig backup af Supabase-databasen (`/paperclip/backups` i volumen `paperclip-data`, 14 dages retention). Status ses i `/api/health` (logget ind).
- **Manuelt:** `deploy/magnora/backup-now.sh`
- **Supabase:** Dashboard → Database → Backups (Pro: daglig + PITR).

Restore fra Paperclip-backup (stop serveren først, så intet skriver imens):

```bash
cd /opt/magnora/deploy/magnora && docker compose --env-file .env stop server && docker compose --env-file .env run --rm --no-deps server ls -lh /paperclip/backups
```

```bash
cd /opt/magnora/deploy/magnora && docker compose --env-file .env run --rm --no-deps -e BACKUP=<filnavn>.sql.gz server sh -c 'gunzip -c /paperclip/backups/$BACKUP | psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1' && docker compose --env-file .env up -d
```

(Restore til en tom database; ved fuld genetablering: opret nyt Supabase-projekt eller nulstil `public`-schemaet først. `psql` kan installeres i containeren med `apt-get install -y postgresql-client` hvis den mangler.)

## 9. Drift

| Hvad | Hvordan |
| --- | --- |
| Status | `https://<domæne>/api/health` (server + database), Magnora-siden (Gmail, kanaler, affiliate, fejl), Paperclip dashboard (agenter, fejlede runs, budgetter) |
| Logs | `docker compose --env-file .env logs -f server` |
| Genstart | `docker compose --env-file .env restart server` (containere starter selv efter reboot: `restart: unless-stopped` + Docker enabled) |
| Opdatering | `git push` (automatisk) eller `deploy.sh` manuelt |

## Lokal udvikling (valgfrit, ikke nødvendigt)

Se `doc/DEVELOPING.md`: `pnpm install && pnpm dev` (embedded Postgres, http://localhost:3100).
