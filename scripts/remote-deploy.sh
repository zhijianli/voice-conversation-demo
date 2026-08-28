#!/usr/bin/env bash
# On EC2: extract archive, install deps, build frontend, publish static files, restart service
set -euo pipefail

APP_NAME="voice-conversation-demo"
PROJECT_DIR="/home/ec2-user/projects/voice-conversation-demo"
WEBROOT="/var/www/voice-conversation-demo"
ARCHIVE="${1:-/tmp/voice-conversation-demo.tar.gz}"

log() { printf '[remote-deploy] %s\n' "$*"; }

if [[ ! -f "$ARCHIVE" ]]; then
  echo "archive not found: $ARCHIVE" >&2
  exit 1
fi

log "extracting $ARCHIVE -> $PROJECT_DIR"
mkdir -p "$PROJECT_DIR"
tar -xzf "$ARCHIVE" -C "$PROJECT_DIR"
rm -f "$ARCHIVE"

log "backend dependencies"
cd "$PROJECT_DIR/backend"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q --upgrade pip
pip install -q -r requirements.txt
deactivate

log "frontend build"
cd "$PROJECT_DIR/frontend"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run build

log "publish static files -> $WEBROOT"
sudo mkdir -p "$WEBROOT"
sudo rsync -a --delete dist/ "$WEBROOT/"

log "restart backend"
sudo systemctl restart "$APP_NAME"
sleep 3

log "health check"
curl -fsS http://127.0.0.1:8000/api/health >/dev/null
curl -fsS -o /dev/null https://api.volohorizon.com/realtime/api/health
curl -fsS -o /dev/null https://api.volohorizon.com/realtime/

log "deploy ok"
echo "  https://api.volohorizon.com/realtime/"
