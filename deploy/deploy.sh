#!/usr/bin/env bash
# Lokal makineden çalıştır: ./deploy/deploy.sh
# Gizli dosyalar (keys.env, .env, forge cache/broadcast) ASLA gönderilmez; sunucudaki .env elle yönetilir.
set -euo pipefail
cd "$(dirname "$0")/.."
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude dist --exclude .git \
  --exclude .env --exclude keys.env --exclude '*.pem' \
  --exclude contracts/lib --exclude contracts/out --exclude contracts/cache --exclude contracts/broadcast \
  --exclude .env.example \
  ./ yolal:~/montap/
ssh yolal 'cd ~/montap && sudo docker compose up -d --build && sudo docker compose ps'
