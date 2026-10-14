#!/usr/bin/env bash
set -euo pipefail
source_dir=${1:?Pass source SQL directory}
destination=${2:?Pass empty destination directory}
mkdir -p "$destination"
test -z "$(ls -A "$destination")" || { echo 'Destination must be empty' >&2; exit 1; }
for file in "$source_dir/"*.sql; do
  name=$(basename "$file")
  [[ "$name" =~ ^([0-9]{3})_([a-z0-9_]+)\.sql$ ]] || exit 1
  output=V${BASH_REMATCH[1]}__${BASH_REMATCH[2]}.sql
  test "$(awk '!/^--/ && NF {print;exit}' "$file")" = 'BEGIN;' || { echo "Unsupported transaction wrapper: $name" >&2; exit 1; }
  test "$(tail -n 1 "$file")" = 'COMMIT;' || exit 1
  # Flyway owns the transaction; retain the stable blank lines and SQL bodies.
  sed '0,/^BEGIN;$/s/^BEGIN;$//; ${s/^COMMIT;$//;}' "$file" > "$destination/$output"
done
