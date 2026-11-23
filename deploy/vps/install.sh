#!/usr/bin/env bash
# Installs or updates a Paperclip server on a fresh Ubuntu/Debian VM
# (Oracle Cloud, Hetzner, ...). Database: Supabase via DATABASE_URL.
#
#   curl -fsSL https://raw.githubusercontent.com/MagnoraMarketing/MagnoraMarketing-Agentfirm/HEAD/deploy/vps/install.sh | sudo bash
#
# Re-run the same command to update to the latest code. Existing settings in
# /opt/agentfirm/src/deploy/vps/.env are kept.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/MagnoraMarketing/MagnoraMarketing-Agentfirm.git}"
BRANCH="${BRANCH:-}"
APP_DIR="${APP_DIR:-/opt/agentfirm}"
SRC_DIR="$APP_DIR/src"
ENV_FILE="$SRC_DIR/deploy/vps/.env"

log() { printf '\n==> %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: ... | sudo bash" >&2
  exit 1
fi

log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git openssl

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# Oracle Cloud Ubuntu images ship iptables rules that reject everything except
# SSH. Open HTTP/HTTPS and persist the rules.
if iptables -S INPUT 2>/dev/null | grep -q -- "-j REJECT"; then
  log "Opening ports 80 and 443 in the local firewall"
  for port in 80 443; do
    iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null \
      || iptables -I INPUT 5 -p tcp --dport "$port" -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save
  fi
fi
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp
  ufw allow 443/tcp
fi

if [ -z "$BRANCH" ]; then
  BRANCH="$(git ls-remote --symref "$REPO_URL" HEAD | awk '/^ref:/ {sub("refs/heads/", "", $2); print $2}')"
fi
log "Fetching code ($BRANCH)"
mkdir -p "$APP_DIR"
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$SRC_DIR" checkout -B "$BRANCH" FETCH_HEAD
else
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
fi

if [ ! -f "$ENV_FILE" ]; then
  log "First-time setup"
  if [ ! -r /dev/tty ]; then
    echo "No terminal available for questions. Create $ENV_FILE by hand." >&2
    exit 1
  fi

  printf 'Supabase DATABASE_URL (Session pooler URI, password filled in): '
  read -r DATABASE_URL </dev/tty
  case "$DATABASE_URL" in
    postgres://*|postgresql://*) ;;
    *) echo "DATABASE_URL must start with postgres:// or postgresql://" >&2; exit 1 ;;
  esac
  if printf '%s' "$DATABASE_URL" | grep -q 'YOUR-PASSWORD'; then
    echo "Replace [YOUR-PASSWORD] with the database password first." >&2
    exit 1
  fi

  printf 'ANTHROPIC_API_KEY (Enter to skip): '
  read -r ANTHROPIC_API_KEY </dev/tty
  printf 'OPENAI_API_KEY (Enter to skip): '
  read -r OPENAI_API_KEY </dev/tty

  PUBLIC_IP="$(curl -fsS4 https://api.ipify.org || true)"
  DEFAULT_DOMAIN=""
  if [ -n "$PUBLIC_IP" ]; then
    DEFAULT_DOMAIN="$(printf '%s' "$PUBLIC_IP" | tr '.' '-').sslip.io"
  fi
  printf 'Domain [%s]: ' "$DEFAULT_DOMAIN"
  read -r DOMAIN </dev/tty
  DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
  if [ -z "$DOMAIN" ]; then
    echo "A domain is required." >&2
    exit 1
  fi

  umask 077
  cat >"$ENV_FILE" <<ENVEOF
DOMAIN=$DOMAIN
PAPERCLIP_PUBLIC_URL=https://$DOMAIN
DATABASE_URL=$DATABASE_URL
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
PAPERCLIP_SECRETS_MASTER_KEY=$(openssl rand -base64 32)
PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32)
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
OPENAI_API_KEY=$OPENAI_API_KEY
ENVEOF
  echo "Saved settings to $ENV_FILE"
fi

log "Building and starting (the first build takes 10-30 minutes)"
cd "$SRC_DIR/deploy/vps"
docker compose up -d --build

DOMAIN_NOW="$(grep '^DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
log "Done"
echo "Open https://$DOMAIN_NOW"
echo "Create an account, sign in, and choose 'Claim this instance'."
echo "Logs: cd $SRC_DIR/deploy/vps && docker compose logs -f paperclip"
