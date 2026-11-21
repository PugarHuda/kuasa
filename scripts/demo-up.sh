#!/usr/bin/env bash
# Starts the whole demo with low memory use: shop (4021), console (4022), Kuasa Cover (4023), Kuasa Re (4024).
# Each Node process is capped (--max-old-space-size); Kuasa Re watches the chain less often (one public node
# serves everyone). Optional public URLs (e.g. Cloudflare tunnels): INSURER_PUBLIC=https://… SHOP_PUBLIC=https://…
# Usage: bash scripts/demo-up.sh   (Ctrl-C stops everything)
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_OPTIONS="--max-old-space-size=384"
JURORS=4j733XjURhA9UFkxfNbZHsKpRSMvnbQjJyjbbMHUKuzMu8huDH,4Gw69UEYtxxE1EroXsp3AwAZWa38cKCuQZCgs9HYLc1Xys4oqg
pids=()
trap 'kill "${pids[@]}" 2>/dev/null' EXIT
(cd packages/shop && KUASA_SHOP_PUBLIC_URL="${SHOP_PUBLIC:-}" node --import tsx src/server.ts) & pids+=($!)
(cd packages/insurer && KUASA_INSURER_PUBLIC_URL="${INSURER_PUBLIC:-}" KUASA_JURORS=$JURORS node --import tsx src/server.ts) & pids+=($!)
(cd packages/insurer && PORT=4024 KUASA_PROFILE=insurer2 KUASA_COVER_INDEX=13108 KUASA_STATE_FILE=insurer2-state.json \
  KUASA_CAPITAL_FILE=capital2.json KUASA_INSURER_URL=http://localhost:4024 KUASA_PRICE_BPS=8500 KUASA_WATCH_MS=30000 \
  node --import tsx src/server.ts) & pids+=($!)
curl -s -m 3 localhost:4022 >/dev/null 2>&1 || { (cd packages/console && node --import tsx src/server.ts) & pids+=($!); }
wait
