-- Sound Garden — STEP 1 of 2: application schema.
--
-- Paste this whole file into the Supabase SQL editor and run it.
-- Safe to re-run. Run STEP 2 (realtime policies) afterwards, separately —
-- the editor runs a file as one transaction, so keeping them apart means a
-- permissions problem in step 2 cannot roll back your schema.

-- ===== 0001_personal_sync.sql ========================================
-- Sound Garden — Phase 1: personal sync.
--
-- SCOPE OF WHAT THIS SERVER MAY EVER HOLD
--
--   * SHA-256 content hashes of PDFs
--   * annotation stroke geometry, in 0..1 page space
--   * setlist structure (ordered content hashes + titles)
--   * per-score display preferences
--
-- It must NEVER hold: PDF bytes, filenames, page images, thumbnails, or text
-- extracted from a score. Scores are usually licensed to the holder and not to
-- anyone else, so transmitting one is redistribution whatever the intent. There
-- is deliberately no column anywhere below that could carry a file. If a future
-- feature appears to need the document server-side, that feature is wrong.
--
-- Everything is scoped to auth.uid() by row level security. A user reads and
-- writes their own rows and nothing else.

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
-- Deliberately minimal: a display name and nothing more. No avatar, no bio, no
-- date of birth, no phone. Phase 2 adds ensembles, where directors see only
-- this display name.

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy profiles_select_own on public.profiles
  for select using (id = auth.uid());
create policy profiles_insert_own on public.profiles
  for insert with check (id = auth.uid());
create policy profiles_update_own on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_delete_own on public.profiles
  for delete using (id = auth.uid());

-- ---------------------------------------------------------------------------
-- Strokes
-- ---------------------------------------------------------------------------
-- One row per stroke, mirroring the client. `id` is generated client-side so a
-- stroke keeps its identity across devices without a round trip.
--
-- `content_hash` identifies the *document*. It is a hash, not a file, and is
-- the only thing about a PDF that ever reaches this table.

create table if not exists public.strokes (
  id            uuid primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  content_hash  text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  page_number   int  not null check (page_number >= 1),
  layer         text not null default 'personal' check (layer in ('personal', 'ensemble')),
  tool          text not null check (tool in ('pen', 'highlighter')),
  color         text not null check (char_length(color) <= 32),
  width         double precision not null check (width > 0 and width <= 1),
  -- Flat [x0,y0,x1,y1,...] in 0..1 uncropped page space. Device-independent by
  -- construction, which is why it can be shared at all.
  points        double precision[] not null,
  created_at    bigint not null,
  updated_at    bigint not null,
  -- Soft delete. A hard delete cannot survive sync: the peer still holds the
  -- row and would push it back on its next drain.
  deleted_at    bigint
);

-- The provisional `local:<id>` hashes the client uses before backfill are
-- rejected by the check constraint above, on purpose: they are device-local and
-- must never be uploaded.

create index if not exists strokes_user_updated_idx
  on public.strokes (user_id, updated_at);
create index if not exists strokes_user_content_idx
  on public.strokes (user_id, content_hash, page_number);

alter table public.strokes enable row level security;

create policy strokes_select_own on public.strokes
  for select using (user_id = auth.uid());
create policy strokes_insert_own on public.strokes
  for insert with check (user_id = auth.uid());
create policy strokes_update_own on public.strokes
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy strokes_delete_own on public.strokes
  for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Setlists
-- ---------------------------------------------------------------------------
-- Structure only: an ordered list of content hashes with the titles the owner
-- gave them, so a device without the file can still show what is missing.

create table if not exists public.setlists (
  id          uuid primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 200),
  -- [{ "contentHash": "...", "title": "..." }]
  items       jsonb not null default '[]'::jsonb,
  created_at  bigint not null,
  updated_at  bigint not null,
  deleted_at  bigint
);

create index if not exists setlists_user_updated_idx
  on public.setlists (user_id, updated_at);

alter table public.setlists enable row level security;

create policy setlists_select_own on public.setlists
  for select using (user_id = auth.uid());
create policy setlists_insert_own on public.setlists
  for insert with check (user_id = auth.uid());
create policy setlists_update_own on public.setlists
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy setlists_delete_own on public.setlists
  for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Per-score display preferences
-- ---------------------------------------------------------------------------
-- Crop and fit follow the user between devices; they are properties of how a
-- document reads, not of the hardware. Pedal bindings deliberately do NOT sync
-- — they describe the physical pedal attached to one device.

create table if not exists public.score_prefs (
  user_id       uuid not null references auth.users (id) on delete cascade,
  content_hash  text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- Titles are the user's own metadata, not extracted from the file.
  title         text check (char_length(title) <= 300),
  artist        text check (char_length(artist) <= 300),
  crop          jsonb,
  fit_mode      text check (fit_mode in ('width', 'page')),
  spread        boolean,
  updated_at    bigint not null,
  primary key (user_id, content_hash)
);

alter table public.score_prefs enable row level security;

create policy score_prefs_select_own on public.score_prefs
  for select using (user_id = auth.uid());
create policy score_prefs_insert_own on public.score_prefs
  for insert with check (user_id = auth.uid());
create policy score_prefs_update_own on public.score_prefs
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy score_prefs_delete_own on public.score_prefs
  for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Account deletion
-- ---------------------------------------------------------------------------
-- Real deletes, not soft flags. Every table above cascades from auth.users, so
-- removing the user removes the rows; this function exists so a signed-in user
-- can erase their content without deleting the account itself.

create or replace function public.delete_my_data()
returns void
language plpgsql
security invoker
as $$
begin
  delete from public.strokes     where user_id = auth.uid();
  delete from public.setlists    where user_id = auth.uid();
  delete from public.score_prefs where user_id = auth.uid();
end;
$$;

-- ===== 0002_ensembles.sql ========================================
-- Sound Garden — Phase 2: ensembles.
--
-- THIS SCHEMA IS USED BY CHILDREN. Everything below is shaped by that.
--
--   * A member is a DISPLAY NAME. No email is required, no real name, no date
--     of birth, no phone number, no photo, no free-text bio. Students sign in
--     anonymously — the credential is a refresh token held on their device —
--     and choose a name to appear as.
--   * There is no messaging table, and there will not be one. Directors
--     communicate through assignments, which are addressed to one member and
--     are about a piece of music.
--   * A director sees display names, roles and assignment status. They cannot
--     see a member's email, IP, device identifier, login times, or personal
--     annotation layer. That is enforced by the policies here, not by the UI.
--   * Leaving really deletes. Deleting an ensemble really deletes. No soft
--     flags anywhere in this file.
--
-- The no-PDF rule from 0001 still holds absolutely: nothing here can carry a
-- file. Scores are referred to by SHA-256 hash and by the title the director
-- typed, and by nothing else.

-- ---------------------------------------------------------------------------
-- Ensembles
-- ---------------------------------------------------------------------------

create table if not exists public.ensembles (
  id           uuid primary key,
  name         text not null check (char_length(name) between 1 and 120),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  -- Six characters, and deliberately drawn from an alphabet with no 0/O or
  -- 1/I/L: this gets read off a whiteboard to a room of teenagers.
  join_code    text not null unique check (join_code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  created_at   bigint not null,
  updated_at   bigint not null
);

create index if not exists ensembles_owner_idx on public.ensembles (owner_id);

alter table public.ensembles enable row level security;

-- ---------------------------------------------------------------------------
-- Membership
-- ---------------------------------------------------------------------------
-- display_name lives here rather than being read from profiles, so a student
-- can appear as "Ben R (cello)" in one group without that name following them
-- anywhere else.

create table if not exists public.ensemble_members (
  ensemble_id  uuid not null references public.ensembles (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  role         text not null default 'member' check (role in ('director', 'member')),
  joined_at    bigint not null,
  primary key (ensemble_id, user_id)
);

create index if not exists ensemble_members_user_idx on public.ensemble_members (user_id);

alter table public.ensemble_members enable row level security;

-- Helper predicates. SECURITY DEFINER so they can consult membership without
-- being caught by the very policies they are used in, which would recurse.
create or replace function public.is_ensemble_member(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ensemble_members
    where ensemble_id = target and user_id = auth.uid()
  );
$$;

create or replace function public.is_ensemble_director(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ensemble_members
    where ensemble_id = target and user_id = auth.uid() and role = 'director'
  );
$$;

-- An ensemble is visible only to people already in it. Critically there is NO
-- policy permitting select by join_code: otherwise anyone could enumerate codes
-- against this table and walk into a school's group. Joining goes through
-- join_ensemble() below, which is the only path that reads a code.
create policy ensembles_select_member on public.ensembles
  for select using (public.is_ensemble_member(id));
create policy ensembles_insert_own on public.ensembles
  for insert with check (owner_id = auth.uid());
create policy ensembles_update_director on public.ensembles
  for update using (public.is_ensemble_director(id)) with check (public.is_ensemble_director(id));
create policy ensembles_delete_owner on public.ensembles
  for delete using (owner_id = auth.uid());

-- A member sees only their own membership row. A director sees the roster.
-- This stops a student enumerating their classmates, which the app has no
-- feature that needs.
create policy members_select_self_or_director on public.ensemble_members
  for select using (user_id = auth.uid() or public.is_ensemble_director(ensemble_id));
create policy members_delete_self_or_director on public.ensemble_members
  for delete using (user_id = auth.uid() or public.is_ensemble_director(ensemble_id));
create policy members_update_self on public.ensemble_members
  for update using (user_id = auth.uid()) with check (user_id = auth.uid() and role = 'member');

-- ---------------------------------------------------------------------------
-- Ensemble strokes
-- ---------------------------------------------------------------------------
-- The ensemble layer lives in the same table as personal markings, scoped by
-- ensemble_id. The policies below are the only thing standing between a
-- director and a student's private annotations, so they are written explicitly.

alter table public.strokes
  add column if not exists ensemble_id uuid references public.ensembles (id) on delete cascade;

create index if not exists strokes_ensemble_idx
  on public.strokes (ensemble_id, content_hash, page_number);

-- A row is either personal (ensemble_id null) or published to exactly one
-- ensemble. Nothing in between.
alter table public.strokes drop constraint if exists strokes_layer_scope;
alter table public.strokes add constraint strokes_layer_scope check (
  (layer = 'personal' and ensemble_id is null) or
  (layer = 'ensemble' and ensemble_id is not null)
);

-- Replace the Phase 1 read policy: own rows, plus the ensemble layers of
-- groups I belong to. A director's own rows are theirs; a member's personal
-- rows have ensemble_id null and are therefore invisible to everyone else,
-- including their director.
drop policy if exists strokes_select_own on public.strokes;
create policy strokes_select_own_or_ensemble on public.strokes
  for select using (
    user_id = auth.uid()
    or (layer = 'ensemble' and public.is_ensemble_member(ensemble_id))
  );

-- Only a director may publish into an ensemble layer. A member writing their
-- own personal rows is unaffected.
drop policy if exists strokes_insert_own on public.strokes;
create policy strokes_insert_own on public.strokes
  for insert with check (
    user_id = auth.uid()
    and (ensemble_id is null or public.is_ensemble_director(ensemble_id))
  );

drop policy if exists strokes_update_own on public.strokes;
create policy strokes_update_own on public.strokes
  for update using (
    user_id = auth.uid()
    and (ensemble_id is null or public.is_ensemble_director(ensemble_id))
  ) with check (
    user_id = auth.uid()
    and (ensemble_id is null or public.is_ensemble_director(ensemble_id))
  );

-- ---------------------------------------------------------------------------
-- Ensemble setlists
-- ---------------------------------------------------------------------------
-- Structure only: ordered content hashes plus the director's titles, so a
-- member without the file still sees what the piece is called.

create table if not exists public.ensemble_setlists (
  id           uuid primary key,
  ensemble_id  uuid not null references public.ensembles (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 200),
  items        jsonb not null default '[]'::jsonb,
  created_at   bigint not null,
  updated_at   bigint not null
);

create index if not exists ensemble_setlists_ensemble_idx
  on public.ensemble_setlists (ensemble_id, updated_at);

alter table public.ensemble_setlists enable row level security;

create policy ensemble_setlists_select_member on public.ensemble_setlists
  for select using (public.is_ensemble_member(ensemble_id));
create policy ensemble_setlists_write_director on public.ensemble_setlists
  for all using (public.is_ensemble_director(ensemble_id))
  with check (public.is_ensemble_director(ensemble_id));

-- ---------------------------------------------------------------------------
-- Assignments
-- ---------------------------------------------------------------------------
-- The only channel from a director to a member, and deliberately narrow: it is
-- about a passage of music, addressed to one person. This is not a message
-- table and must not become one.

create table if not exists public.assignments (
  id            uuid primary key,
  ensemble_id   uuid not null references public.ensembles (id) on delete cascade,
  member_id     uuid not null references auth.users (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 200),
  notes         text not null default '' check (char_length(notes) <= 2000),
  content_hash  text check (content_hash ~ '^[0-9a-f]{64}$'),
  page_number   int check (page_number >= 1),
  bar_reference text check (char_length(bar_reference) <= 60),
  due_date      bigint,
  completed_at  bigint,
  created_at    bigint not null,
  updated_at    bigint not null
);

create index if not exists assignments_member_idx on public.assignments (member_id, updated_at);
create index if not exists assignments_ensemble_idx on public.assignments (ensemble_id, updated_at);

alter table public.assignments enable row level security;

-- A member sees the assignments addressed to them, and no one else's.
create policy assignments_select_own_or_director on public.assignments
  for select using (member_id = auth.uid() or public.is_ensemble_director(ensemble_id));
create policy assignments_write_director on public.assignments
  for insert with check (public.is_ensemble_director(ensemble_id));
create policy assignments_update_director on public.assignments
  for update using (public.is_ensemble_director(ensemble_id))
  with check (public.is_ensemble_director(ensemble_id));
create policy assignments_delete_director on public.assignments
  for delete using (public.is_ensemble_director(ensemble_id));

-- A member may mark their own assignment done, and change nothing else.
create or replace function public.set_assignment_done(target uuid, done boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.assignments
     set completed_at = case when done then extract(epoch from now()) * 1000 else null end,
         updated_at   = extract(epoch from now()) * 1000
   where id = target and member_id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------------------
-- Joining, leaving, deleting
-- ---------------------------------------------------------------------------

create or replace function public.generate_join_code()
returns text language plpgsql as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
begin
  loop
    code := '';
    for _ in 1..6 loop
      code := code || substr(alphabet, floor(random() * length(alphabet) + 1)::int, 1);
    end loop;
    exit when not exists (select 1 from public.ensembles where join_code = code);
  end loop;
  return code;
end;
$$;

create or replace function public.create_ensemble(ensemble_name text, director_name text)
returns public.ensembles language plpgsql security definer set search_path = public as $$
declare
  created public.ensembles;
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.ensembles (id, name, owner_id, join_code, created_at, updated_at)
  values (gen_random_uuid(), ensemble_name, auth.uid(), public.generate_join_code(), now_ms, now_ms)
  returning * into created;

  insert into public.ensemble_members (ensemble_id, user_id, display_name, role, joined_at)
  values (created.id, auth.uid(), director_name, 'director', now_ms);

  return created;
end;
$$;

-- The only path that reads a join code.
--
-- SECURITY DEFINER on purpose: the caller is not yet a member and so cannot see
-- the ensemble at all. Returning nothing on a bad code — rather than an error
-- distinguishing "no such code" — keeps this from being a usable oracle.
create or replace function public.join_ensemble(code text, display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  target uuid;
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;

  select id into target from public.ensembles where join_code = upper(trim(code));
  if target is null then return null; end if;

  insert into public.ensemble_members (ensemble_id, user_id, display_name, role, joined_at)
  values (target, auth.uid(), display_name, 'member', now_ms)
  on conflict (ensemble_id, user_id) do update set display_name = excluded.display_name;

  return target;
end;
$$;

create or replace function public.rotate_join_code(target uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  fresh text;
begin
  if not public.is_ensemble_director(target) then raise exception 'not a director'; end if;
  fresh := public.generate_join_code();
  update public.ensembles set join_code = fresh, updated_at = (extract(epoch from now()) * 1000)::bigint
   where id = target;
  return fresh;
end;
$$;

-- Leaving removes the membership, every assignment addressed to the member in
-- that group, and any ensemble strokes they published. Real deletes.
create or replace function public.leave_ensemble(target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from public.assignments
   where ensemble_id = target and member_id = auth.uid();
  delete from public.strokes
   where ensemble_id = target and user_id = auth.uid();
  delete from public.ensemble_members
   where ensemble_id = target and user_id = auth.uid();
end;
$$;

-- Deleting an ensemble removes it and everything hanging off it, by cascade.
create or replace function public.delete_ensemble(target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.ensembles where id = target and owner_id = auth.uid()
  ) then
    raise exception 'not the owner';
  end if;
  delete from public.ensembles where id = target;
end;
$$;
