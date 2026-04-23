#!/bin/sh

set -eu

stop_port() {
  port="$1"
  label="$2"
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)

  if [ -z "$pids" ]; then
    echo "$label port $port is already clear."
    return
  fi

  echo "Stopping $label on port $port: $pids"
  kill $pids 2>/dev/null || true

  attempts=0
  while lsof -ti tcp:"$port" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 10 ]; then
      stubborn_pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
      if [ -n "$stubborn_pids" ]; then
        echo "Force stopping $label on port $port: $stubborn_pids"
        kill -9 $stubborn_pids 2>/dev/null || true
      fi
      break
    fi
    sleep 0.5
  done
}

stop_port 4000 "frontend"
stop_port 8001 "backend"
