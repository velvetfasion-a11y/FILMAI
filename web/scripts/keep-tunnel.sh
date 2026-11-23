#!/usr/bin/env bash
set -u
URL_FILE=/tmp/filmai-public-url.txt
LOG=/tmp/cf-watch.log
OUT=/tmp/cf-watch.out
STATUS=/tmp/cf-watch-status.log

while true; do
  rm -f "$LOG" "$OUT"
  npx --yes cloudflared tunnel --url http://127.0.0.1:3000 --protocol http2 --logfile "$LOG" --loglevel info >"$OUT" 2>&1 &
  PID=$!
  URL=""
  for _ in $(seq 1 30); do
    sleep 2
    URL=$(grep -ohE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" "$OUT" 2>/dev/null | head -1 || true)
    if [ -n "$URL" ]; then
      echo "$URL" > "$URL_FILE"
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) up $URL" >> "$STATUS"
      break
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
  done

  while kill -0 "$PID" 2>/dev/null; do
    sleep 45
    if [ -z "$URL" ]; then
      kill "$PID" 2>/dev/null || true
      break
    fi
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$URL/" || echo 000)
    if [ "$code" != "200" ]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) dead code=$code restarting" >> "$STATUS"
      kill "$PID" 2>/dev/null || true
      pkill -f 'cloudflared tunnel --url' 2>/dev/null || true
      break
    fi
  done
  wait "$PID" 2>/dev/null || true
  sleep 3
done
