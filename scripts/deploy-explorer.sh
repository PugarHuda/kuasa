#!/usr/bin/env bash
# Builds the explorer + public A2A function and deploys docs/explorer to Vercel (project kuasa-explorer),
# then points kuasa-explorer.vercel.app at the new deployment (the alias does not move by itself).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${TMPDIR:-${TEMP:-/tmp}}/kuasa-explorer-deploy"
pnpm --dir "$ROOT/packages/explorer" build
mkdir -p "$OUT"
cp -r "$ROOT/docs/explorer/." "$OUT/"
cd "$OUT"
[ -d .vercel ] || vercel link --yes --project kuasa-explorer
URL=$(vercel deploy --prod --yes 2>/dev/null | grep -o '"url": "https://[^"]*' | head -1 | cut -d'"' -f4)
vercel alias set "$URL" kuasa-explorer.vercel.app
echo "deployed $URL -> https://kuasa-explorer.vercel.app"
