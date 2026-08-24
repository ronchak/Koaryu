#!/bin/sh

set -eu

if ! grep -Fq "libjemalloc.so.2" /proc/self/maps; then
  echo "jemalloc preload verification failed" >&2
  exit 1
fi

echo "jemalloc preload verified"
exec python -m uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-10000}"
