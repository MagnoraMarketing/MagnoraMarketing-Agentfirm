# Magnora Marketing Ops (Paperclip plugin)

Plugin id: `magnora.marketing-ops`. Bygget på Paperclips eksisterende plugin-system
(agent-tools, company-secrets, plugin-DB-namespace, jobs, UI-slots). Ingen parallel
infrastruktur.

## Hvad plugin'et giver

| Område | Hvad | Sikkerhed |
| --- | --- | --- |
| Gmail | OAuth 2.0 (PKCE) mod Google, søg/læs tråde, opret drafts, label/arkivér, send via godkendelse | Scopes `gmail.modify` + `gmail.compose`. Refresh token krypteres (AES-256-GCM, nøgle afledt af client secret fra Paperclip secrets). SEND kræver altid godkendelse og kan slås helt fra. Arkivering er slået fra som standard. Trash/Spam er blokeret. |
| Social | Facebook Page, Instagram Business, LinkedIn (Posts API), X (API v2) | Hvert opslag bliver `PENDING APPROVAL` som standard. Kanal kan aktiveres/deaktiveres, tildeles agenter og sættes til `auto` hvis du vil. |
| Affiliate | `AffiliateProvider`-interface + generisk provider for netværkets officielle JSON-rapport-API | Read-only. Token i Paperclip secrets. Kun https. |
| Dashboard | Side `/<firma>/magnora` + sidebar-link + dashboard-widget | Godkend/afvis kun som indlogget board-bruger. |
| Fejl | Fejl-log (agent, task, tid, fejl, retry-status), automatisk retry af 429/5xx | Tokens redigeres ud af fejlbeskeder. |

## Agent-tools

`integrations_status`, `health_report`, `gmail_search`, `gmail_get_thread`,
`gmail_create_draft`, `gmail_request_send`, `gmail_modify_labels`,
`social_list_channels`, `social_submit_post`, `social_post_history`, `affiliate_stats`.

Hver tool tjekker at den kaldende agent står på integrationens tilladelsesliste
(agentnavn eller URL-key) – least privilege. Standard:

- Gmail læse: `email`, `ceo` · Gmail drafts/send-anmodning: `email`
- Social: `social-media`, `marketing`
- Affiliate: `affiliate`, `ceo`

## Installation (på serveren, ingen lokal installation)

1. Plugin'et bygges ind i Docker-imaget (`/app/packages/plugins/plugin-magnora`).
2. I Paperclip UI: **Company settings → Instance → Plugins → Install** → vælg
   *local path* og angiv `/app/packages/plugins/plugin-magnora`.
3. Åbn plugin'ets settings og udfyld credentials (secret-felter vælges fra Paperclip
   Secrets – værdier vises aldrig igen).

## Gmail opsætning

1. Google Cloud Console → APIs & Services → aktiver **Gmail API**.
2. OAuth consent screen (External/Testing er nok til eget brug; tilføj din egen konto som test user).
3. Credentials → OAuth client ID → *Web application*.
   Authorized redirect URI: `https://<dit-domæne>/<FIRMA-PREFIX>/magnora`
   (præcis URL vises på Magnora → Integrations).
4. Gem client secret som Paperclip secret `GOOGLE_CLIENT_SECRET`, sæt client ID i plugin-settings.
5. Magnora → Integrations → **Connect Gmail**.

Status: `CONNECTED`, `NOT CONFIGURED`, `EXPIRED` (refresh token afvist → *Reconnect Gmail*), `ERROR`.

## Social opsætning

| Kanal | Account ID | Token (secret) |
| --- | --- | --- |
| Facebook | Page ID | Page access token med `pages_manage_posts` |
| Instagram | Instagram business user ID | Token med `instagram_basic`, `instagram_content_publish` (kræver billede-URL) |
| LinkedIn | `urn:li:organization:<id>` eller `urn:li:person:<id>` | Token med `w_organization_social` / `w_member_social`; `LinkedIn-Version` er konfigurerbar |
| X | – | OAuth 2.0 user token med `tweet.write` |

## Affiliate opsætning

Tilføj en provider pr. netværk med den rapport-URL netværkets officielle API-dokumentation
angiver (`{startDate}`/`{endDate}` erstattes), auth-header og felt-mapping. Netværk uden
officielt API understøttes bevidst ikke (ingen scraping/login-omgåelse).

## Udvikling

```bash
pnpm --filter @paperclipai/plugin-magnora test
pnpm --filter @paperclipai/plugin-magnora typecheck
pnpm --filter @paperclipai/plugin-magnora build
```
