-- Teammates may read each other's name and private flag, nothing else: email, role and status are for the admin and
-- coach, who get them through the wod function (service role, after it checks their role). Members may still edit
-- their own name and private flag directly; every other member write goes through the function as admin.
revoke select, insert, update, delete on public.members from authenticated, anon;
grant select (user_id, name, private) on public.members to authenticated;
grant update (name, private) on public.members to authenticated;
