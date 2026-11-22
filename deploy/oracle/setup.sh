#!/usr/bin/env bash
# Runs ON the Oracle VM (Ubuntu, as the default `ubuntu` user with sudo). Installs Node 22 and Caddy,
# opens 80/443 in the VM firewall, and runs the demo (scripts/demo-up.sh) as a systemd service behind
# Caddy with automatic HTTPS on <ip>.sslip.io subdomains:
#   https://shop.<ip>.sslip.io  -> shop (4021)
#   https://cover.<ip>.sslip.io -> Kuasa Cover (4023)
#   https://re.<ip>.sslip.io    -> Kuasa Re (4024)
# Usage (done by push.sh): bash ~/kuasa/deploy/oracle/setup.sh <public ip>
set -euo pipefail
IP="$1"; DOMAIN="${IP//./-}.sslip.io"
APP="$HOME/kuasa"

if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update && sudo apt-get install -y caddy
fi
# Oracle's Ubuntu images reject everything but SSH in iptables, on top of the VCN security list
for p in 80 443; do sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport $p -j ACCEPT; done
sudo netfilter-persistent save 2>/dev/null || true

cd "$APP" && sudo corepack enable && pnpm install --frozen-lockfile

sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
shop.$DOMAIN { reverse_proxy localhost:4021 }
cover.$DOMAIN { reverse_proxy localhost:4023 }
re.$DOMAIN { reverse_proxy localhost:4024 }
EOF
sudo systemctl restart caddy

sudo tee /etc/systemd/system/kuasa.service >/dev/null <<EOF
[Unit]
Description=Kuasa demo (shop, Kuasa Cover, Kuasa Re)
After=network-online.target
[Service]
User=$USER
WorkingDirectory=$APP
Environment=SHOP_PUBLIC=https://shop.$DOMAIN
Environment=INSURER_PUBLIC=https://cover.$DOMAIN
ExecStart=/usr/bin/bash scripts/demo-up.sh
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now kuasa && sudo systemctl restart kuasa
echo "up: https://shop.$DOMAIN  https://cover.$DOMAIN  https://re.$DOMAIN"
