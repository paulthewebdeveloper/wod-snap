#!/bin/sh
# End-to-end check of the wod function as real signed-in users. Creates two temporary athletes, exercises the API,
# then deletes them. Run: checks/smoke.sh   (needs the Supabase CLI login; prints PASS lines, exits 1 on the first FAIL)
set -eu
REF=ktotbpvtkaubecmodgyb
URL=https://$REF.supabase.co
FN=$URL/functions/v1/wod
KEYS=$(supabase projects api-keys --project-ref $REF -o json 2>/dev/null)
SR=$(echo "$KEYS" | python3 -c "import json,sys;print([k['api_key'] for k in json.load(sys.stdin) if k['name']=='service_role'][0])")
ANON=$(echo "$KEYS" | python3 -c "import json,sys;print([k['api_key'] for k in json.load(sys.stdin) if k['name']=='anon'][0])")
PW="Smoke-$(date +%s)-x9"
TMP=$(mktemp -d)
ok() { echo "PASS $1"; }
fail() { echo "FAIL $1"; cleanup; exit 1; }

mkuser() { # email name -> prints id
  id=$(curl -sS -X POST $URL/auth/v1/admin/users -H "apikey: $SR" -H "Authorization: Bearer $SR" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$PW\",\"email_confirm\":true}" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  curl -sS -X POST "$URL/rest/v1/members" -H "apikey: $SR" -H "Authorization: Bearer $SR" -H 'content-type: application/json' \
    -d "{\"user_id\":\"$id\",\"email\":\"$1\",\"name\":\"$2\",\"role\":\"athlete\"}" >/dev/null
  echo "$id"
}
token() { curl -sS -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H 'content-type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$PW\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'])"; }
cleanup() {
  for id in ${U1:-} ${U2:-}; do
    # results hold a foreign key to the account, so remove them first or the account delete is refused
    curl -sS -X DELETE "$URL/rest/v1/results?user_id=eq.$id" -H "apikey: $SR" -H "Authorization: Bearer $SR" >/dev/null || true
    curl -sS -X DELETE "$URL/auth/v1/admin/users/$id" -H "apikey: $SR" -H "Authorization: Bearer $SR" >/dev/null || true
  done
  rm -rf "$TMP"
}
call() { # method path token [body] -> status in $TMP/s, body in $TMP/b
  if [ -n "${4:-}" ]; then
    curl -sS -o $TMP/b -w '%{http_code}' -X "$1" "$FN/$2" -H "Authorization: Bearer $3" -H 'content-type: application/json' -d "$4" > $TMP/s
  else
    curl -sS -o $TMP/b -w '%{http_code}' -X "$1" "$FN/$2" -H "Authorization: Bearer $3" > $TMP/s
  fi
}

U1=$(mkuser smoke1-$$@test.invalid Smoke1); U2=$(mkuser smoke2-$$@test.invalid Smoke2)
T1=$(token smoke1-$$@test.invalid); T2=$(token smoke2-$$@test.invalid)

call GET list nonsense; [ "$(cat $TMP/s)" = 401 ] && ok "no valid token -> 401" || fail "no valid token -> $(cat $TMP/s)"
call POST members "$T1" '{"email":"x@test.invalid","name":"X","role":"coach"}'
[ "$(cat $TMP/s)" = 403 ] && ok "athlete cannot add members" || fail "athlete add member -> $(cat $TMP/s)"
call POST save "$T1" '{"results":[{"title":"Smoke WOD","kind":"for_time","score":"5:00","score_value":300,"rx":true}]}'
[ "$(cat $TMP/s)" = 201 ] && ok "save" || fail "save -> $(cat $TMP/s) $(cat $TMP/b)"
call GET 'list?scope=mine' "$T1"
grep -q 'Smoke WOD' $TMP/b && ok "own list has it" || fail "own list missing row"
call GET 'list?scope=team' "$T2"
python3 -c "import json,sys;d=json.load(open('$TMP/b'));sys.exit(0 if any(r['title']=='Smoke WOD' and r.get('owner_name')=='Smoke1' for r in d) else 1)" \
  && ok "teammate sees it with owner_name" || fail "teammate team list: $(head -c 300 $TMP/b)"
call GET 'list?scope=mine' "$T2"
grep -q 'Smoke WOD' $TMP/b && fail "teammate's own list includes another's row" || ok "own list is only mine"
call PATCH "members?id=$U1" "$T1" '{"private":true}'
[ "$(cat $TMP/s)" = 200 ] && ok "self can go private" || fail "self private -> $(cat $TMP/s) $(cat $TMP/b)"
call GET 'list?scope=team' "$T2"
grep -q 'Smoke WOD' $TMP/b && fail "private row still visible to teammate" || ok "private hides from teammate"
call PATCH "members?id=$U1" "$T1" '{"role":"admin"}'
[ "$(cat $TMP/s)" = 403 ] && ok "self cannot change role" || fail "self role change -> $(cat $TMP/s)"
call GET members "$T2"
python3 -c "import json,sys;d=json.load(open('$TMP/b'));sys.exit(0 if d and all(set(m)<= {'user_id','name'} for m in d) else 1)" \
  && ok "athlete sees names only" || fail "athlete members view: $(head -c 300 $TMP/b)"

cleanup
echo "ALL PASS"
