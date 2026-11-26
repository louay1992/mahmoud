drop policy if exists admins_self on admins;
create policy admins_self on admins for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email'));