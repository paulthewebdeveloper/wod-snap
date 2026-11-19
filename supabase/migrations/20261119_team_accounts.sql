-- Team accounts: each result has an owner, members have a role, and row-level security decides who sees what.
-- Spec: docs/superpowers/specs/2026-11-19-team-accounts-design.md

create table public.members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null unique,
  name       text not null default '',
  role       text not null default 'athlete' check (role in ('admin', 'coach', 'athlete')),
  private    boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.members enable row level security;

-- The caller's role while they are an active member, else null. Security definer so policies can read members
-- without recursing through members' own policies.
create function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from members where user_id = auth.uid() and active
$$;

-- Whether an owner's results are visible to teammates: active and not private.
create function public.is_visible_owner(owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = owner and active and not private)
$$;

-- Paul is the admin; his existing results become his.
insert into public.members (user_id, email, name, role)
select id, email, 'Paul', 'admin' from auth.users where email = 'paul@digitalsaints.studio';

alter table public.results add column user_id uuid references auth.users(id) default auth.uid();
update public.results set user_id = (select id from auth.users where email = 'paul@digitalsaints.studio')
 where user_id is null;
alter table public.results alter column user_id set not null;
create index results_user_day_idx on public.results (user_id, day);

-- results: owners write their own; admin and coach read all; teammates read active, non-private owners.
create policy results_select on public.results for select to authenticated using (
  user_id = auth.uid() or my_role() in ('admin', 'coach') or (my_role() is not null and is_visible_owner(user_id)));
create policy results_insert on public.results for insert to authenticated
  with check (user_id = auth.uid() and my_role() is not null);
create policy results_update on public.results for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy results_delete on public.results for delete to authenticated using (user_id = auth.uid());

-- members: any active member reads the list; admin manages it; anyone may edit their own row,
-- but only name and private (the trigger below guards the rest).
create policy members_select on public.members for select to authenticated using (my_role() is not null);
create policy members_insert on public.members for insert to authenticated with check (my_role() = 'admin');
create policy members_delete on public.members for delete to authenticated using (my_role() = 'admin');
create policy members_update on public.members for update to authenticated
  using (my_role() = 'admin' or user_id = auth.uid()) with check (my_role() = 'admin' or user_id = auth.uid());

create function public.members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'authenticated' and my_role() is distinct from 'admin'
     and (new.role, new.active, new.email, new.user_id) is distinct from (old.role, old.active, old.email, old.user_id) then
    raise exception 'only the admin can change role, status or email' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger members_guard before update on public.members for each row execute function public.members_guard();
