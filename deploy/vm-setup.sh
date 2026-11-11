#!/usr/bin/env bash
# Sets up the Hitscan server on a fresh Ubuntu VM (any Ubuntu VM, or any Ubuntu 22.04 / 24.04 machine):
# Node, the game server as a service that restarts itself, and Caddy for HTTPS (Let's Encrypt certificate, automatic).
#
#   ./vm-setup.sh <domain> <site-address> [repo-url]
#   ./vm-setup.sh hitscan-ammar.duckdns.org https://hitscan.pages.dev
#
# <domain> must already point at this machine's public IP, and ports 80 and 443 must be open in the cloud firewall.
# Safe to run again: it updates the code and restarts the service.
set -euo pipefail

DOMAIN="${1:?usage: $0 <domain> <site-address> [repo-url]}"
ORIGIN="${2:?usage: $0 <domain> <site-address> [repo-url]}"
REPO="${3:-https://github.com/Ammar-S-Malik/Hitscan.git}"
APP=/home/hitscan/app

echo "== packages"
sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "== node 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "== the game server code"
id hitscan >/dev/null 2>&1 || sudo useradd --system --create-home --shell /usr/sbin/nologin hitscan
if [ -d "$APP/.git" ]; then
  sudo -u hitscan git -C "$APP" pull --ff-only
else
  sudo -u hitscan git clone "$REPO" "$APP"
fi
sudo -u hitscan bash -c "cd '$APP' && npm ci --omit=dev"

echo "== service"
sudo tee /etc/systemd/system/hitscan.service >/dev/null <<UNIT
[Unit]
Description=Hitscan game server
After=network.target

[Service]
User=hitscan
WorkingDirectory=$APP
Environment=PORT=8787
Environment=TRUST_PROXY=1
Environment=ALLOWED_ORIGINS=$ORIGIN
Environment=MAX_MATCHES=16
ExecStart=/usr/bin/node --experimental-strip-types --disable-warning=ExperimentalWarning server/src/main.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now hitscan
sudo systemctl restart hitscan

echo "== caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$DOMAIN {
  reverse_proxy 127.0.0.1:8787
}
CADDY
sudo systemctl enable --now caddy
sudo systemctl reload caddy || sudo systemctl restart caddy

echo "== VM firewall (Ubuntu images on Oracle block everything but SSH by default)"
sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
sudo netfilter-persistent save

echo
echo "Done. Check it:"
echo "  curl https://$DOMAIN/health      (should print: ok)"
echo "  sudo systemctl status hitscan    (should say active (running))"
echo "  journalctl -u hitscan -f         (the server's log)"
echo "Then set VITE_SERVER_URL=wss://$DOMAIN on Cloudflare Pages and redeploy the site."
