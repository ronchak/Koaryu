#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

free_port() {
  port="$1"
  label="$2"
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)

  if [ -z "$pids" ]; then
    return
  fi

  echo "Reclaiming $label port $port from existing process(es): $pids"
  kill $pids 2>/dev/null || true

  attempts=0
  while lsof -ti tcp:"$port" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 10 ]; then
      stubborn_pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
      if [ -n "$stubborn_pids" ]; then
        echo "Force stopping $label port $port process(es): $stubborn_pids"
        kill -9 $stubborn_pids 2>/dev/null || true
      fi
      break
    fi
    sleep 0.5
  done
}

cleanup() {
  pids=$(jobs -p 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

free_port 4000 "frontend"
free_port 8001 "backend"

(
  cd "$ROOT_DIR/backend"
  exec venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8001
) &
backend_pid=$!

(
  cd "$ROOT_DIR/frontend"
  exec npm run dev
) &
frontend_pid=$!

wait "$backend_pid" "$frontend_pid"
