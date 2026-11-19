#!/bin/sh
# Run a SQL file against the wod-snap database through the Supabase Management API.
# Usage: checks/sql.sh checks/rls.sql   (uses the Supabase CLI login from the macOS Keychain)
set -eu
REF=ktotbpvtkaubecmodgyb
TOK=$(security find-generic-password -s "Supabase CLI" -a access-token -w | sed 's/^go-keyring-base64://' | base64 -d)
python3 -c 'import json,sys; print(json.dumps({"query": open(sys.argv[1]).read()}))' "$1" |
  curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" --data @- |
  python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps(r)[:2000]); sys.exit(1 if isinstance(r,dict) and r.get("message") else 0)'
