#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04/24.04 VM (amd64 or arm64) for Magnora.
# Can be pasted as "cloud-init / user data" when creating the VM in the
# Oracle Cloud or Hetzner web console, or run as root over the browser SSH.
#
# What it does:
#   - installs Docker Engine + compose plugin, enables it on boot
#   - opens only 22, 80, 443 in the host firewall
#   - creates the 'deploy' user (used by GitHub Actions over SSH)
#   - creates a read-only GitHub deploy key for cloning the private repo
#   - adds 4 GB swap (agent CLIs + builds need headroom on small VMs)
set -euo pipefail

REPO_SSH_URL="${REPO_SSH_URL:-git@github.com:MagnoraMarketing/MagnoraMarketing-Agentfirm.git}"
APP_DIR="${APP_DIR:-/opt/magnora}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git ufw unattended-upgrades

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
dpkg-reconfigure -f noninteractive unattended-upgrades || true

# Firewall. NOTE: Oracle Cloud also needs ingress rules for 80/443 in the VCN
# security list (web console) – see README.
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
# Oracle images ship iptables REJECT rules that block 80/443 even with ufw.
if [ -f /etc/iptables/rules.v4 ] && grep -q "REJECT" /etc/iptables/rules.v4; then
  iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT || true
  iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT || true
  netfilter-persistent save || true
fi

if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

id -u "$DEPLOY_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 700 "/home/$DEPLOY_USER/.ssh"
touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"

KEY="/home/$DEPLOY_USER/.ssh/github_deploy_key"
if [ ! -f "$KEY" ]; then
  sudo -u "$DEPLOY_USER" ssh-keygen -t ed25519 -N "" -C "magnora-server-deploy-key" -f "$KEY"
fi
sudo -u "$DEPLOY_USER" bash -c "cat > ~/.ssh/config <<CFG
Host github.com
  IdentityFile $KEY
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
CFG
chmod 600 ~/.ssh/config"

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"

cat <<MSG

=====================================================================
Server ready. Next steps (all in the browser):

1. GitHub → repo Settings → Deploy keys → Add deploy key (read-only):
$(cat "$KEY.pub")

2. Then, as $DEPLOY_USER on this server:
   git clone $REPO_SSH_URL $APP_DIR
   cp $APP_DIR/deploy/magnora/.env.example $APP_DIR/deploy/magnora/.env
   chmod 600 $APP_DIR/deploy/magnora/.env   # fill in the values
   $APP_DIR/deploy/magnora/deploy.sh

3. Add the GitHub Actions public key to /home/$DEPLOY_USER/.ssh/authorized_keys
   (see deploy/magnora/README.md).
=====================================================================
MSG
