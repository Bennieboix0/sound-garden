-- Sound Garden — STEP 2 of 2: Realtime channel authorization.
--
-- Run this AFTER step 1, as a separate query.
--
-- These policies are what stop a member publishing page turns into their own
-- rehearsal with a hand-crafted client. realtime.messages already has row level
-- security enabled by Supabase and is owned by an internal role, so this file
-- only creates policies on it — it does not try to alter the table.

-- Sound Garden — live page follow: channel authorization.
--
-- Page turns during a rehearsal are Realtime *broadcast* messages, never
-- database writes. A conductor turning pages for forty minutes must not leave
-- forty minutes of rows behind, and the server has no business knowing which
-- page any particular student is looking at.
--
-- Broadcast permission therefore cannot be a client-side check. Supabase
-- Realtime Authorization applies row level security to `realtime.messages`, so
-- the policies below are what actually stop a hand-crafted client from
-- publishing page turns into a school's rehearsal. The client additionally
-- opens the channel as private, which is what makes Realtime consult these at
-- all.
--
-- Topic format:  ensemble:<uuid>:follow

-- Extracts the ensemble id from the topic, returning null for anything that is
-- not a well-formed follow topic. Null then fails every policy below, so a
-- malformed topic is refused rather than falling through to allowed.
create or replace function public.follow_topic_ensemble(topic text)
returns uuid language plpgsql immutable as $$
declare
  candidate text;
begin
  if topic is null then return null; end if;
  if topic !~ '^ensemble:[0-9a-fA-F-]{36}:follow$' then return null; end if;
  candidate := split_part(topic, ':', 2);
  return candidate::uuid;
exception
  when others then return null;
end;
$$;

-- Note: row level security is already enabled on realtime.messages by Supabase,
-- and the table is owned by an internal role — `alter table ... enable row level
-- security` here fails with "must be owner of table messages". Creating
-- policies on it is the supported path; enabling RLS is not ours to do.

-- Receiving: any member of the ensemble.
drop policy if exists sound_garden_follow_read on realtime.messages;
create policy sound_garden_follow_read on realtime.messages
  for select to authenticated
  using (
    public.follow_topic_ensemble(realtime.topic()) is not null
    and public.is_ensemble_member(public.follow_topic_ensemble(realtime.topic()))
  );

-- Broadcasting: directors of that specific ensemble, and nobody else. A
-- director of one group has no more right to drive another group's channel
-- than a stranger does.
drop policy if exists sound_garden_follow_broadcast on realtime.messages;
create policy sound_garden_follow_broadcast on realtime.messages
  for insert to authenticated
  with check (
    extension = 'broadcast'
    and public.follow_topic_ensemble(realtime.topic()) is not null
    and public.is_ensemble_director(public.follow_topic_ensemble(realtime.topic()))
  );

-- Deliberately absent: any table recording where a member currently is. The
-- director's position is broadcast and then forgotten; a member's position is
-- never transmitted at all.


-- Verification: should return two rows.
select policyname, cmd
from pg_policies
where schemaname = 'realtime' and tablename = 'messages'
  and policyname like 'sound_garden%';
