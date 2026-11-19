# Team accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn WOD snap from a one-person app with a shared code into a small-team app with individual email-code logins, admin/coach/athlete roles, a team board per workout, and a read-only team view for admin and coach.

**Architecture:** Supabase Auth (email one-time code) issues each person a session; the `wod` edge function forwards that user's token to the database so row-level security decides every read and write. The single-file home-screen app (`index.html`) gains sign-in, Team today, team board, Team tab and Profile. Ranking lives in a small `rank.js` module so it can be tested with Node.

**Tech Stack:** Supabase (Postgres RLS, Auth, Deno edge function), supabase-js v2 from jsDelivr (pinned), plain HTML/CSS/JS on GitHub Pages, Resend SMTP, Node's built-in test runner for `rank.js`.

**Spec:** `docs/superpowers/specs/2026-11-19-team-accounts-design.md`

## Global Constraints

- Free tiers only; no build step; `index.html` stays one file plus `rank.js`, `crossfit.json`, manifest, icon.
- Supabase project `ktotbpvtkaubecmodgyb`; function `wod` keeps its existing `parse` behaviour and model order.
- Sign-in: email → **6-digit code typed into the app**; never a magic link. Public sign-up **off**.
- Roles exactly `admin` | `coach` | `athlete`. Paul = `admin`, email `paul@digitalsaints.studio`.
- Who-sees-what enforced by RLS, never only in the front end.
- Mail: Resend SMTP `smtp.resend.com:465`, user `resend`; sender `WOD <codes@mail.maketheclick.com>`. Keys never in the repo.
- Remove = deactivate (`members.active = false` + auth ban); results are never deleted by removal.
- Apple system colours and components already in `index.html`; new screens reuse its classes (`.card`, `.row`, `.hero`, `.seg`, sheet).

## Review Focus

1. **A teammate goes private after logging** — their rows must vanish from athletes' team boards immediately, still visible to admin/coach. Pinned in Task 1's `checks/rls.sql`.
2. **A removed member** — cannot sign in; their old results disappear for athletes, stay for admin/coach. Task 1 + Task 2 checks.
3. **An athlete tries to change their own role** (or another's row) through the API — must fail. Task 1 check.
4. **Ties and capped results on the team board** — capped after every finisher, more reps first, ties share a place, RX before Scaled. Task 5 `rank.test.mjs`.
5. **Session expiry while the app sits unopened for weeks** — the app refreshes silently or shows sign-in, never a broken empty screen. Task 4 manual check.

---

### Task 1: Members table, ownership and row-level security

**Files:**
- Create: `supabase/migrations/20261119_team_accounts.sql`
- Create: `checks/rls.sql`

**Interfaces:**
- Produces: table `members(user_id uuid pk → auth.users, email text unique, name text, role text check in ('admin','coach','athlete'), private bool default false, active bool default true, created_at timestamptz)`; `results.user_id uuid not null default auth.uid() → auth.users`; SQL function `public.my_role() returns text` (security definer, the caller's role if active, else null).

- [ ] **Step 1: Write `checks/rls.sql`** — inside one transaction that ends in `rollback`: create four auth users (admin A, coach C, athletes X and Y) and members rows; insert one result each; then, switching `request.jwt.claims`/`role authenticated` per user, assert with `do $$ … assert … $$`:
  - X sees X's and Y's rows (count 2 of the athletes') and A's/C's rows.
  - Y set `private = true` → X sees 0 of Y's rows; A and C still see Y's row.
  - Y set `active = false` → X sees 0 of Y's rows; A and C still see it.
  - X `update results set score='1' where user_id = Y` affects 0 rows; X `update members set role='admin' where user_id = X` affects 0 rows; X can update own `name` and `private`.
  - Only A can insert/update/delete `members`.
- [ ] **Step 2: Run it against the project (via Supabase SQL) — expect failure** (`relation "members" does not exist`).
- [ ] **Step 3: Write the migration**: tables/columns above; `my_role()`; RLS on `results` (select: owner, or `my_role() in ('admin','coach')`, or owner is an active non-private member; insert/update/delete: `user_id = auth.uid()`); RLS on `members` (select: any active member; insert/delete: admin; update: admin any row, self only `name` and `private` — enforce role/active immutability for non-admins with a `before update` trigger); create Paul's auth user (`paul@digitalsaints.studio`, email confirmed) and his `admin` member row; set `user_id` on the two existing results to Paul; then `set not null`.
- [ ] **Step 4: Apply the migration; run `checks/rls.sql` — every assert passes, transaction rolls back.**
- [ ] **Step 5: Commit** `supabase/migrations/… checks/rls.sql` — "Team accounts: members, ownership, RLS".

### Task 2: Edge function runs as the signed-in user

**Files:**
- Modify: `supabase/functions/wod/index.ts`
- Create: `checks/smoke.sh`

**Interfaces:**
- Consumes: Task 1 tables.
- Produces (HTTP, all require `Authorization: Bearer <user access token>`; 401 without):
  - `POST /parse {image}` → `{model, parts}` (unchanged).
  - `POST /save {results:[…]}`, `GET /list?scope=mine|team`, `PATCH /update?id=`, `DELETE /delete?id=` — run through PostgREST with the anon key + the user's token, so RLS applies. `list?scope=team` returns visible rows of all members joined with `members.name` as `owner_name`.
  - `GET /members` → `[{user_id,name,email,role,private,active,last_day,prs_30d}]` (admin/coach only; athletes get `{user_id,name}` only).
  - `POST /members {email,name,role}` (admin) → creates auth user (email confirmed) + member row.
  - `PATCH /members?id= {role?, active?, name?, private?}` — admin for others; self for `name`/`private`. `active:false` also bans the auth user (`ban_duration: "876000h"`); `active:true` lifts it.
- [ ] **Step 1: Write `checks/smoke.sh`**: uses the service key from `supabase secrets`-independent env (`SUPABASE_SERVICE_ROLE_KEY` exported by the runner) to create two temp users with passwords via the auth admin API, signs them in with password to get tokens, then asserts with `curl` + `jq`: no token → 401; athlete `POST /members` → 403; save + `list?scope=mine` round-trips; second athlete sees the first in `scope=team`; deletes the temp users at the end.
- [ ] **Step 2: Run it — expect 401/`bad token` mismatch failures against the old function.**
- [ ] **Step 3: Implement**: replace the `APP_TOKEN` check with `supabase.auth.getUser(token)`; a per-request PostgREST helper sending `apikey: SUPABASE_ANON_KEY` and the caller's `Authorization`; admin actions use the service role only after checking `my_role()` = admin; keep CORS (add `authorization` to allowed headers).
- [ ] **Step 4: Deploy (`supabase functions deploy wod --project-ref ktotbpvtkaubecmodgyb --no-verify-jwt --use-api`), run `checks/smoke.sh` — all pass.**
- [ ] **Step 5: Commit** — "wod function: per-user auth, team list, members admin".

### Task 3: Email codes through Resend

**Files:** none in the repo (Supabase and Resend settings; record what was set in the spec's sign-in section).

- [ ] **Step 1: In Resend (Paul signed in): add domain `mail.maketheclick.com`; add its DNS records in Cloudflare (`maketheclick.com` zone); wait until Resend shows Verified.**
- [ ] **Step 2: Create a Resend API key `wod-snap`, sending access, domain `mail.maketheclick.com`.**
- [ ] **Step 3: Supabase Auth config (Management API `PATCH /v1/projects/ktotbpvtkaubecmodgyb/config/auth`):** `smtp_host smtp.resend.com`, `smtp_port 465`, `smtp_user resend`, `smtp_pass <key>`, `smtp_admin_email codes@mail.maketheclick.com`, `smtp_sender_name WOD`, `disable_signup true`, `mailer_otp_length 6`, `mailer_otp_exp 600`, magic-link template body showing `{{ .Token }}` with subject "Your WOD code".
- [ ] **Step 4: Verify**: request a code for `paul@digitalsaints.studio` (`POST /auth/v1/otp` with `create_user:false`) — email arrives from `codes@mail.maketheclick.com` with a 6-digit code; a code request for an unknown email does not create a user.

### Task 4: Sign-in and session in the app

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: Task 2 endpoints; supabase-js `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js` with the project URL and publishable/anon key.
- Produces: `sb` client (`persistSession: true, autoRefreshToken: true`); `me = {user_id, name, role, private}` loaded after sign-in; `api()` sends `Authorization: Bearer ${session.access_token}`.

- [ ] **Step 1: Replace the access-code setup screen with Sign in**: email field → `sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })` → 6-digit field (`inputmode="numeric" autocomplete="one-time-code"`) → `sb.auth.verifyOtp({ email, token, type: 'email' })`. Errors inline ("That email isn't on the team yet — ask Paul", "Code didn't match").
- [ ] **Step 2: On load, `sb.auth.getSession()`; no session → Sign in; `onAuthStateChange('SIGNED_OUT')` → Sign in. Remove `#t=` token handling and `wodToken` storage.**
- [ ] **Step 3: Verify in a 390 px browser**: sign in as Paul with a real code; reload keeps you signed in; Today/Progress show only Paul's rows; expired session (clear `sb-…` storage key's access token) refreshes or shows Sign in, never an empty app.
- [ ] **Step 4: Commit** — "App: email-code sign-in".

### Task 5: Team board and Team today

**Files:**
- Create: `rank.js`, `checks/rank.test.mjs`
- Modify: `index.html`

**Interfaces:**
- Produces: `rank(entries) -> [{...entry, place}]` in `rank.js` (ES module, also loaded by the page via `<script type="module">`); entries are `{kind, rx, score_value, owner_name}`.

- [ ] **Step 1: Write `checks/rank.test.mjs`** (`node --test checks/`): Fran entries 8:42 RX, 9:15 RX, 7:50 Scaled, cap 140 RX, cap 150 RX → order 8:42, 9:15, cap 150, cap 140, 7:50 (RX first; capped after finishers; more reps first); two RX 8:42 → both place 1, next place 3; strength 100 vs 95 → 100 first; entries with `score_value null` last, unplaced.
- [ ] **Step 2: Run — fails (no module).**
- [ ] **Step 3: Implement `rank` in `rank.js`** using the existing `CAPPED` convention (`score_value >= CAPPED - 10000` is capped).
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: In `index.html`**: load `list?scope=team`; detail view gets a "Team board" card for the group key on the day of your latest attempt (or the day passed in when opened from Team today), rows ranked by `rank()`, your row bold; Today gets "Team today" listing groups teammates logged today with count, tapping opens detail at today. Verify in browser with two test members.
- [ ] **Step 6: Commit** — "Team board, Team today, ranking".

### Task 6: Team tab, Profile and Members

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `GET/POST/PATCH /members`, `list?scope=team`, `me.role`.

- [ ] **Step 1: Team tab (fourth tab, only when `me.role` is admin or coach)**: members list with last logged day and PRs in 30 days; tap → that member's Progress/detail rendered from their rows, read-only (no swipe-delete, no edit sheet, title "Maria’s progress").
- [ ] **Step 2: Profile sheet (button top-right on Today)**: name field, Private switch (green), Sign out. Admin also sees Members: add (email, name, role select), change role, Remove/Restore.
- [ ] **Step 3: Verify in browser**: as coach test user, Team tab shows everyone incl. a private member; as athlete, no Team tab and private member absent from boards; athlete Profile shows no Members section.
- [ ] **Step 4: Commit** — "Team tab, Profile, member admin".

### Task 7: Rollout

- [ ] **Step 1: Remove the `APP_TOKEN` secret** (`supabase secrets unset APP_TOKEN --project-ref ktotbpvtkaubecmodgyb`) and the Keychain item `wod-snap`.
- [ ] **Step 2: Push to `main`; wait until GitHub Pages serves the new `index.html` (grep for `signInWithOtp`).**
- [ ] **Step 3: Verify live**: sign in as Paul on the live URL; his two existing results are present; `checks/smoke.sh` passes against production; clean up any test members.
- [ ] **Step 4: Log the work in the saints-os wiki Log; tell Paul how to add the coach and teammates.**
