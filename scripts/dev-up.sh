#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
STATE_DIR=${KOARYU_DEV_STATE_DIR:-"$ROOT_DIR/.koaryu-dev"}
PID_DIR="$STATE_DIR/pids"

mkdir -p "$PID_DIR"

pid_file() {
  printf '%s/%s.pid\n' "$PID_DIR" "$1"
}

start_file() {
  printf '%s/%s.start\n' "$PID_DIR" "$1"
}

is_running() {
  pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

is_expected_process() {
  label="$1"
  pid="$2"
  start_path=$(start_file "$label")
  if [ ! -f "$start_path" ]; then
    return 1
  fi

  recorded_start=$(cat "$start_path" 2>/dev/null || true)
  current_start=$(ps -p "$pid" -o lstart= 2>/dev/null || true)
  if [ -z "$recorded_start" ] || [ "$recorded_start" != "$current_start" ]; then
    return 1
  fi

  case "$label" in
    backend)
      expected_cwd="$ROOT_DIR/backend"
      command_pattern='uvicorn app\.main:app'
      ;;
    frontend)
      expected_cwd="$ROOT_DIR/frontend"
      command_pattern='npm .*run dev|next .*dev'
      ;;
    *)
      return 1
      ;;
  esac

  process_cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
  if [ "$process_cwd" != "$expected_cwd" ]; then
    return 1
  fi

  command=$(ps -p "$pid" -o command= 2>/dev/null || true)
  printf '%s\n' "$command" | grep -Eq "$command_pattern"
}

record_process_start() {
  label="$1"
  pid="$2"
  ps -p "$pid" -o lstart= >"$(start_file "$label")"
}

stop_recorded_process() {
  label="$1"
  file=$(pid_file "$label")
  if [ ! -f "$file" ]; then
    return
  fi

  pid=$(cat "$file" 2>/dev/null || true)
  if ! is_running "$pid"; then
    rm -f "$file"
    return
  fi

  if ! is_expected_process "$label" "$pid"; then
    echo "Recorded $label pid $pid is not an expected Koaryu dev process; refusing to stop it." >&2
    rm -f "$file"
    return
  fi

  echo "Stopping previous Koaryu $label process from $file: $pid"
  kill "$pid" 2>/dev/null || true

  attempts=0
  while is_running "$pid"; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 10 ]; then
      echo "Force stopping previous Koaryu $label process: $pid"
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
    sleep 0.5
  done

  rm -f "$file" "$(start_file "$label")"
}

require_port_clear() {
  port="$1"
  label="$2"
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)

  if [ -z "$pids" ]; then
    return
  fi

  echo "$label port $port is already in use by process(es): $pids" >&2
  echo "Refusing to kill untracked processes. Stop them manually or run npm run dev:down if they were started by this repo." >&2
  exit 1
}

cleanup() {
  pids=$(jobs -p 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
  fi
  rm -f "$(pid_file frontend)" "$(pid_file backend)" "$(start_file frontend)" "$(start_file backend)"
}

trap cleanup INT TERM EXIT

stop_recorded_process frontend
stop_recorded_process backend
require_port_clear 4000 "frontend"
require_port_clear 8001 "backend"

(
  cd "$ROOT_DIR/backend"
  exec venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8001
) &
backend_pid=$!
printf '%s\n' "$backend_pid" >"$(pid_file backend)"
record_process_start backend "$backend_pid"

(
  cd "$ROOT_DIR/frontend"
  exec npm run dev
) &
frontend_pid=$!
printf '%s\n' "$frontend_pid" >"$(pid_file frontend)"
record_process_start frontend "$frontend_pid"

wait "$backend_pid" "$frontend_pid"
