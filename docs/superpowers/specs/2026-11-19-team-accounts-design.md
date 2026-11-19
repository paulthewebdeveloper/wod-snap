# WOD snap — team accounts design

Date: 2026-11-19 · Status: draft for Paul's approval

## Intent

WOD snap is a phone app that reads a photo of the CrossFit gym whiteboard, lets you log your score, and tracks
progress. Today it is single-user: one shared access code, every result belongs to nobody in particular.

It is now going to be used by a small team: Paul, his coach, and a few teammates (about five people). Each needs
their own login. Paul and the coach need to follow everyone's progress; teammates should be able to compare
results on the same workout, because comparison is part of what keeps people logging. It is early, so it must stay
an app on the phone without committing to the App Store.

## Goals

- Each person has their own account and their own log.
- Three roles:
  - **admin** (Paul): logs his own; sees everyone's results; adds and removes members; sets roles.
  - **coach**: logs their own; sees everyone's results, including private members.
  - **athlete**: logs their own; sees teammates' results unless a teammate is private.
- **Team board** per workout: everyone who logged the same workout on the same day, ranked.
- **Private switch** per person: hides your results from athletes. Admin and coach still see them.
- Admin and coach can open any member's Progress / detail views read-only.
- Sign-in survives for months; people should almost never see the sign-in screen again.

## Non-goals (for now)

- Native app or App Store / TestFlight distribution.
- More than one team or gym.
- Coach editing or deleting other people's results (read-only by design: each log stays its owner's record).
- Coach posting the board once for everyone (each person snaps or types their own; the board can be shared later).
- Comments, likes, chat, notifications.

## Anti-goals

- Anyone who finds the URL being able to join or read data. Membership is by admin invite only.
- A permission rule that lives only in the front end. Who-sees-what must be enforced by the database itself.
- Login friction that stops people logging (passwords to remember, links that open in the wrong place).
- Losing Paul's existing two entries.

## Constraints

- Free tiers only (Supabase free, GitHub Pages, Google AI Studio free tier for board reading).
- Stays a home-screen web app: one `index.html`, no build step, hosted on GitHub Pages
  (`paulthewebdeveloper/wod-snap`).
- **iOS home-screen apps keep their own storage, separate from Safari.** A tap-the-link email would sign the person
  in inside Safari, not inside the app. Sign-in therefore uses a **6-digit code typed into the app**.
- Supabase free projects pause after a week with no traffic; acceptable at this size.
- Existing backend: Supabase project `wod-snap` (`ktotbpvtkaubecmodgyb`), table `results`, edge function `wod`
  (parse / save / list / update / delete), Gemini 3.5 Flash-Lite first with OpenRouter free models as fallback.

## Approaches considered

1. **Keep the current stack, add Supabase Auth and database-enforced roles.** *Chosen.* Keeps everything that
   works, free, about a day of work, and the database, function and data model carry over unchanged if a native
   app comes later.
2. **Native app via Expo + TestFlight.** Most app-like (haptics, camera, offline), but needs Apple's $99/year
   developer account and Apple's build pipeline for every update — the commitment Paul wants to avoid now.
3. **Rebuild on Next.js + Vercel.** Proper server code, useful at many teams and features; for five people it adds
   moving parts with no visible gain.

Paul picked 1.

## Design

### Accounts and sign-in

- Supabase Auth, **email one-time code**: the app asks for an email, Supabase emails a 6-digit code, the person
  types it in the app. The session is kept in the app's storage and refreshed automatically.
- Supabase's email template is changed to send the code (not a magic link).
- **Codes need a custom mail sender.** Supabase's built-in sender only delivers to members of the Supabase
  organisation and only a couple of emails an hour, so teammates would never get a code. Custom SMTP is configured
  in Supabase Auth: **Resend** (Paul's pick, free tier 3,000 emails a month), SMTP `smtp.resend.com:465`, user
  `resend`, password = a Resend API key. Sender `WOD <codes@mail.maketheclick.com>` *(builder's call: a subdomain of
  a domain already on Cloudflare, so the app's mail reputation stays apart from Paul's own mailboxes)*. Paul
  creates the Resend account and adds Resend's DNS records in Cloudflare; the key goes into Supabase's settings
  form, never into the repo.
- **Invite-only:** public sign-up is switched off in Supabase. The admin adds a member by email (and role) from
  the app; that creates their account. Only listed emails can receive a code.
- The supabase-js client is loaded in the page from a CDN (pinned version) for auth and session handling.

### Data

- New table `members`: `user_id` (auth user), `email`, `name`, `role` (`admin` | `coach` | `athlete`),
  `private` (bool, default false), `created_at`.
- `results` gains `user_id` (not null after migration), indexed.
- **Row-level security** on both tables:
  - Insert / update / delete a result: only its owner.
  - Read a result: its owner; any admin or coach; any athlete when the owner is not private.
  - Read members: any signed-in member can read names and the private flag (needed for the team board);
    only admin can insert / update / delete members (role changes, removal).
  - A person can update their own `name` and `private`, never their own `role`.
- **Removing a member** *(builder's call)*: deactivates, never deletes. `members` gains `active` (default true);
  removal sets it false and bans the auth user from signing in. Their results stay, visible to admin and coach
  only (read rules for athletes require the owner to be an active, non-private member). Reversible by re-activating.
- **Migration:** Paul's account (paul@digitalsaints.studio) is created as admin; the two existing results are
  assigned to him.

### Server function

- Keeps one function `wod`. It stops checking the shared `APP_TOKEN` and instead requires a valid Supabase user
  token; reads and writes run **as that user**, so the database rules above apply to everything.
- `parse` (board reading) is unchanged apart from requiring a signed-in member.
- New admin action: add a member (creates the auth user and the `members` row) and change role / remove; checks the
  caller is admin.
- The `APP_TOKEN` secret and the `#t=` link are retired once everyone is moved over.

### App screens (Apple style, as built today)

- **Sign in:** email → 6-digit code. Shown only when there is no session.
- **Today / Progress / Benchmarks:** unchanged, but show only *your* results.
- **Today tab gains "Team today"** *(builder's call)*: the workouts teammates logged today, so you can open a board
  even for a workout you skipped or titled differently.
- **Detail view:** adds a **Team board** card for the workout *(builder's call: it shows the day of your most recent
  attempt; a workout opened from "Team today" shows today)*: everyone visible to you who logged the same workout
  title on the same day, ranked — RX above Scaled; for time: finished times ascending, capped results after all
  finishers ordered by reps; lifts and AMRAPs: higher is better; ties share a place.
  ```
  Fran · 19 Nov
  1  Paul    8:42    RX
  2  Maria   9:15    RX
  3  Luke    7:50    Scaled
  4  Sam     cap 140 RX
  ```
- **Team tab** (admin and coach only, a fourth tab): members with last logged date and PRs this month; tap one to
  open their Progress and detail views read-only (no edit, no swipe-delete).
- **Profile** (from a button on Today): your name, the Private switch, sign out. Admin additionally sees
  **Members**: add by email + name + role, change role, remove.

## Left to the builder

- Exact RLS policy SQL and whether role checks use a helper function.
- How "same workout" is matched for the team board: the existing normalised title key plus the same day is the
  starting point.
- Session refresh details, loading and empty states, error copy.
- Whether members' names come from the admin when inviting or from the person on first sign-in (default: admin
  types it when inviting; the person can change it in Profile).
