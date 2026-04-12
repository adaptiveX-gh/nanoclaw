#!/usr/bin/env bash
# Start the TV manual-trade FreqTrade bot as a Docker container.
# This bot accepts only forced trades via API — no autonomous signals.
#
# Usage: ./scripts/start-tv-manual-bot.sh [--live]
#   --live  Switch to live trading (default: dry_run/paper)

set -euo pipefail

# Prevent Git Bash / MSYS from mangling paths like /freqtrade/config.json
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CONTAINER_NAME="nanoclaw-bot-tv-manual"
HOST_PORT=8180
BOT_IMAGE="${FREQTRADE_BOT_IMAGE:-freqtradeorg/freqtrade:stable}"

CONFIG_DIR="$PROJECT_ROOT/data/bot-runner/configs/tv-manual"
STRATEGIES_DIR="$PROJECT_ROOT/data/sessions/whatsapp_main/freqtrade-user-data/strategies"
DATA_DIR="$CONFIG_DIR/data"

mkdir -p "$DATA_DIR"

# Remove existing container if any
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

echo "Starting TV manual-trade bot..."
echo "  Container: $CONTAINER_NAME"
echo "  Port:      $HOST_PORT -> 8080"
echo "  Strategy:  TVManualTrade"
echo "  Config:    $CONFIG_DIR/config.json"
echo "  Image:     $BOT_IMAGE"

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -v "$STRATEGIES_DIR:/freqtrade/user_data/strategies:ro" \
  -v "$CONFIG_DIR/config.json:/freqtrade/config.json:ro" \
  -v "$DATA_DIR:/freqtrade/user_data/data" \
  -p "$HOST_PORT:8080" \
  "$BOT_IMAGE" \
  trade \
  --config /freqtrade/config.json \
  --strategy TVManualTrade

echo ""
echo "TV manual-trade bot started."
echo "  API URL: http://127.0.0.1:$HOST_PORT"
echo "  Username: tv-manual"
echo "  Password: tv-manual-nanoclaw"
echo ""
echo "Test with:"
echo "  curl -s http://127.0.0.1:$HOST_PORT/api/v1/ping"
