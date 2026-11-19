-- Who-sees-what check. Everything happens inside one transaction that is rolled back, so it leaves no trace.
-- Run: checks/sql.sh checks/rls.sql   → prints [] on success, the failing assert's message otherwise.
begin;

-- Act as a signed-in user, or (null) as the server's service role.
create function pg_temp.act(uid uuid) returns void language plpgsql as $$
begin
  if uid is null then -- act as the wod function's service role
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    perform set_config('role', 'postgres', true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
end $$;

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000c', 'c@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a1', 'x@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'y@test.invalid', 'authenticated', 'authenticated');
insert into public.members (user_id, email, name, role) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test.invalid', 'A', 'admin'),
  ('00000000-0000-0000-0000-00000000000c', 'c@test.invalid', 'C', 'coach'),
  ('00000000-0000-0000-0000-0000000000a1', 'x@test.invalid', 'X', 'athlete'),
  ('00000000-0000-0000-0000-0000000000a2', 'y@test.invalid', 'Y', 'athlete');
insert into public.results (user_id, title, kind, score, score_value) values
  ('00000000-0000-0000-0000-00000000000a', 'rlscheck', 'other', '1', 1),
  ('00000000-0000-0000-0000-00000000000c', 'rlscheck', 'other', '1', 1),
  ('00000000-0000-0000-0000-0000000000a1', 'rlscheck', 'other', '1', 1),
  ('00000000-0000-0000-0000-0000000000a2', 'rlscheck', 'other', '1', 1);

do $$
declare n int; X uuid := '00000000-0000-0000-0000-0000000000a1'; Y uuid := '00000000-0000-0000-0000-0000000000a2';
        A uuid := '00000000-0000-0000-0000-00000000000a'; C uuid := '00000000-0000-0000-0000-00000000000c';
begin
  -- Athletes see everyone who is active and not private.
  perform pg_temp.act(X);
  select count(*) into n from public.results where title = 'rlscheck';
  assert n = 4, format('athlete should see 4 rows, saw %s', n);

  -- Y goes private (Y may change their own flag).
  perform pg_temp.act(Y);
  update public.members set private = true where user_id = Y;
  get diagnostics n = row_count; assert n = 1, 'member should be able to set own private flag';

  perform pg_temp.act(X);
  select count(*) into n from public.results where title = 'rlscheck' and user_id = Y;
  assert n = 0, format('athlete should not see a private member, saw %s', n);
  perform pg_temp.act(C);
  select count(*) into n from public.results where title = 'rlscheck' and user_id = Y;
  assert n = 1, 'coach should still see a private member';
  perform pg_temp.act(A);
  select count(*) into n from public.results where title = 'rlscheck' and user_id = Y;
  assert n = 1, 'admin should still see a private member';

  -- Athletes see teammates' names, never their email, role or status.
  perform pg_temp.act(X);
  begin
    perform email from public.members where user_id = A;
    assert false, 'athlete read another member''s email';
  exception when insufficient_privilege then null;
  end;
  select count(*) into n from public.members where name = 'A';
  assert n = 1, 'athlete should read teammates'' names';

  -- The admin deactivates Y and makes them public again (admin writes go through the server with the service role).
  perform pg_temp.act(null);
  update public.members set private = false, active = false where user_id = Y;
  perform pg_temp.act(X);
  select count(*) into n from public.results where title = 'rlscheck' and user_id = Y;
  assert n = 0, format('athlete should not see an inactive member, saw %s', n);
  perform pg_temp.act(C);
  select count(*) into n from public.results where title = 'rlscheck' and user_id = Y;
  assert n = 1, 'coach should still see an inactive member';

  -- Athletes cannot touch others' rows or their own role.
  perform pg_temp.act(X);
  update public.results set score = '9' where user_id = A and title = 'rlscheck';
  get diagnostics n = row_count; assert n = 0, 'athlete updated someone else''s result';
  delete from public.results where user_id = A and title = 'rlscheck';
  get diagnostics n = row_count; assert n = 0, 'athlete deleted someone else''s result';
  begin
    update public.members set role = 'admin' where user_id = X;
    assert false, 'athlete promoted themselves';
  exception when insufficient_privilege or raise_exception then null;
  end;
  begin
    update public.members set active = true where user_id = Y;
    assert false, 'athlete restored a removed member';
  exception when insufficient_privilege or raise_exception then null;
  end;
  update public.members set name = 'X2' where user_id = X;
  get diagnostics n = row_count; assert n = 1, 'member should be able to rename themselves';
  insert into public.results (title, kind) values ('rlscheck', 'other');   -- user_id defaults to auth.uid()
  select count(*) into n from public.results where title = 'rlscheck' and user_id = X;
  assert n = 2, 'own insert should default user_id to the caller';

  -- Nobody changes roles directly in the database; the coach cannot touch other members at all.
  perform pg_temp.act(C);
  update public.members set name = 'hacked' where user_id = X;
  get diagnostics n = row_count; assert n = 0, 'coach renamed a member';
  begin
    update public.members set role = 'athlete' where user_id = X;
    assert false, 'coach changed a role';
  exception when insufficient_privilege or raise_exception then null;
  end;
  perform pg_temp.act(null);
end $$;

rollback;
