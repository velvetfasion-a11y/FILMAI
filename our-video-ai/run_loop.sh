#!/usr/bin/env bash
# Keeps a component alive, restarting it if it crashes.
cd "$(dirname "$0")"
NAME=${TUNNEL_NAME:-our-video-ai}
while true; do
  if [ "$1" = server ]; then
    HF_HOME=$PWD/hf ./.venv/bin/uvicorn app:app --host 127.0.0.1 --port 7860 >> server.log 2>&1
  else
    ./tunnel/node_modules/.bin/liveapps tunnel --port 7860 --name "$NAME" --unlisted > tunnel.log 2>&1
  fi
  sleep 5
done
