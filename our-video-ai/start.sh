#!/usr/bin/env bash
# Starts (or restarts) the Our Video AI server + public tunnel. Usage: ./start.sh [stop]
# Interrupted videos are re-queued automatically when the server comes back.
cd "$(dirname "$0")"
pkill -f "run_loop.sh server" ; pkill -f "run_loop.sh tunnel"; pkill -f "uvicorn app:app --host 127.0.0.1 --port 7860"; pkill -f "liveapps tunnel --port 7860"; pkill -f "our-video-ai/render.py"
[ "$1" = "stop" ] && { echo stopped; exit 0; }
: > tunnel.log
setsid nohup ./run_loop.sh server > /dev/null 2>&1 < /dev/null &
setsid nohup ./run_loop.sh tunnel > /dev/null 2>&1 < /dev/null &
for i in $(seq 1 40); do u=$(grep -o 'https://[a-z0-9-]*\.liveapps\.dev' tunnel.log 2>/dev/null | tail -1); [ -n "$u" ] && break; sleep 1; done
echo "${u:-tunnel not up yet - check tunnel.log}" | tee url.txt
