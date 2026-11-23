---
title: VPS + Supabase
summary: Run Paperclip on one Linux server (Oracle Cloud, Hetzner) with Supabase Postgres
---

`deploy/vps/` runs Paperclip on any Ubuntu or Debian server with Docker.
Caddy serves HTTPS, and Supabase holds the database.

Server size: at least 2 GB RAM (4 GB or more recommended). Oracle Cloud
"Always Free" Ampere (ARM) and Hetzner CX22 both work.

## 1. Open ports 80 and 443

- **Oracle Cloud:** Instance → Subnet → Security List → **Add Ingress Rules**:
  source `0.0.0.0/0`, TCP, destination ports `80,443`.
  The install script opens the same ports in the server's own firewall.
- **Hetzner:** no change unless you attached a Hetzner firewall.

## 2. Run the installer

SSH to the server (or use the browser console) and run:

```sh
curl -fsSL https://raw.githubusercontent.com/MagnoraMarketing/MagnoraMarketing-Agentfirm/HEAD/deploy/vps/install.sh | sudo bash
```

The script asks for:

- `DATABASE_URL`: Supabase → **Connect** → Session pooler URI, with the
  password filled in.
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` (either may be skipped).
- Domain: press Enter to use `<ip>.sslip.io`, or type your own domain whose
  DNS A record points at the server.

It generates the auth and encryption secrets, builds the image, and starts
the app. The first build takes 10–30 minutes. Settings are stored in
`/opt/agentfirm/src/deploy/vps/.env`. Back up `PAPERCLIP_SECRETS_MASTER_KEY`;
stored secrets cannot be read without it.

## 3. Claim the instance

Open the printed URL, create an account, sign in, and choose
**Claim this instance**. Do this right away: until the instance is claimed,
the first signed-in user can claim it. Afterwards you can add
`PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` to `.env` and rerun the installer.

## Updates and logs

- Update to the latest code: run the same installer command again.
- Logs: `cd /opt/agentfirm/src/deploy/vps && sudo docker compose logs -f paperclip`
