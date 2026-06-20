#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
STATE_DIR=${KOARYU_DEV_STATE_DIR:-"$ROOT_DIR/.koaryu-dev"}
PID_DIR="$STATE_DIR/pids"

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

require_port_clear() {
  port="$1"
  label="$2"
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)

  if [ -z "$pids" ]; then
    echo "$label port $port is clear."
    return
  fi

  echo "$label port $port is still in use by process(es): $pids" >&2
  echo "Refusing to kill untracked processes. Stop them manually if they are not from this repo." >&2
  exit 1
}

stop_recorded_process() {
  label="$1"
  port="$2"
  file=$(pid_file "$label")
  if [ ! -f "$file" ]; then
    echo "$label has no Koaryu pid file at $file."
    return
  fi

  pid=$(cat "$file" 2>/dev/null || true)
  if ! is_running "$pid"; then
    echo "$label recorded process is no longer running: $pid"
    rm -f "$file" "$(start_file "$label")"
    return
  fi

  if ! is_expected_process "$label" "$pid"; then
    echo "Recorded $label pid $pid is not an expected Koaryu dev process; refusing to stop it." >&2
    rm -f "$file" "$(start_file "$label")"
    return
  fi

  echo "Stopping Koaryu $label process from $file: $pid"
  kill "$pid" 2>/dev/null || true

  attempts=0
  while is_running "$pid"; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 10 ]; then
      echo "Force stopping Koaryu $label process from $file: $pid"
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
    sleep 0.5
  done

  rm -f "$file" "$(start_file "$label")"

  require_port_clear "$port" "$label"
}

stop_recorded_process frontend 4000
stop_recorded_process backend 8001
require_port_clear 4000 "frontend"
require_port_clear 8001 "backend"
