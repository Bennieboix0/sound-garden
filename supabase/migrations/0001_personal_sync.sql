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
