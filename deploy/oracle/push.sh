#!/usr/bin/env bash
# Runs on the laptop: copies the committed code plus the local .kuasa state (keys, books, receipts) to the
# Oracle VM and runs setup.sh there. From then on the VM is the live demo: do NOT also run
# scripts/demo-up.sh on the laptop (same keys, same state).
# Usage: bash deploy/oracle/push.sh <public ip> <ssh private key file>
set -euo pipefail
IP="$1"; KEY="$2"
cd "$(dirname "$0")/../.."
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "ubuntu@$IP")
tmp="$(mktemp -d)"
git archive --format=tar.gz -o "$tmp/code.tgz" HEAD
tar --exclude='archive' -czf "$tmp/state.tgz" .kuasa
scp -i "$KEY" -o StrictHostKeyChecking=accept-new "$tmp/code.tgz" "$tmp/state.tgz" "ubuntu@$IP:/tmp/"
rm -rf "$tmp"
"${SSH[@]}" "mkdir -p ~/kuasa && cd ~/kuasa && tar xzf /tmp/code.tgz && tar xzf /tmp/state.tgz && chmod 700 .kuasa && rm /tmp/code.tgz /tmp/state.tgz && bash deploy/oracle/setup.sh $IP"
