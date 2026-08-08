#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFICATION_DIR="$ROOT_DIR/supabase/verification"
SUPABASE_DB_TARGET="${SUPABASE_DB_TARGET:-local}"
SQL_RUNNER="$ROOT_DIR/scripts/run-supabase-sql.sh"

node "$ROOT_DIR/scripts/check-supabase-contract-inventory.mjs"

contract_files=()
while IFS= read -r contract_path; do
  contract_files+=("$(basename "$contract_path")")
done < <(find "$VERIFICATION_DIR" -maxdepth 1 -type f -name '*.sql' -print | sort)

for contract_file in "${contract_files[@]}"; do
  echo "Running Supabase contract on $SUPABASE_DB_TARGET database: $contract_file"
  "$SQL_RUNNER" "$VERIFICATION_DIR/$contract_file"
done
