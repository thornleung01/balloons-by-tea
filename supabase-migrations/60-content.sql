-- ==========================================================================
-- 60-content.sql — content editing upgrades (admin Settings / FAQ / Library)
-- ==========================================================================
-- Adds two tables:
--   content_history  "revert content" versions of the Settings form and the
--                    FAQ list (admin-only). Written by js/admin-content-history.js
--                    after every successful save; the newest 50 per kind are
--                    kept (older rows are pruned by a trigger on insert).
--   photo_meta       per-photo alt text, keyed by the photo's public URL.
--                    Public read (the site uses it to fill in <img alt>),
--                    admin write.
--
-- New page-level SEO settings (seo_<page>_title / seo_<page>_description /
-- seo_og_image) live in the existing site_settings table as ordinary
-- key/value rows, so they need no schema change.
--
-- Safe to re-run: if-not-exists / drop-then-create throughout, nothing is
-- dropped or altered on existing tables. Run it after supabase-setup.sql
-- (it needs public.is_admin() from there).
--
-- Until this has been run: the admin History buttons say history isn't set
-- up yet, the alt-text editor says the same, and the public site keeps its
-- current alt text. Nothing else changes.

-- --------------------------------------------------------------------------
-- content_history
-- --------------------------------------------------------------------------
create table if not exists public.content_history (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  -- Filled in by the database from the signed-in session, so a client
  -- can't claim to be someone else.
  actor_email text default auth.email(),
  kind text not null,
  snapshot jsonb not null,
  note text
);

alter table public.content_history enable row level security;

alter table public.content_history drop constraint if exists content_history_kind_check;
alter table public.content_history add constraint content_history_kind_check check (kind in ('settings', 'faq')) not valid;
alter table public.content_history drop constraint if exists content_history_note_length_check;
alter table public.content_history add constraint content_history_note_length_check check (note is null or char_length(note) <= 300) not valid;

create index if not exists content_history_kind_created_idx on public.content_history (kind, created_at desc);

-- Internal version history: admin only, never public.
drop policy if exists "Admin can read content history" on public.content_history;
create policy "Admin can read content history"
  on public.content_history for select
  to authenticated
  using (public.is_admin());

drop policy if exists "Admin can add content history" on public.content_history;
create policy "Admin can add content history"
  on public.content_history for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "Admin can prune content history" on public.content_history;
create policy "Admin can prune content history"
  on public.content_history for delete
  to authenticated
  using (public.is_admin());

-- Keep only the newest 50 versions per kind. Runs as the inserting admin
-- (security invoker), so it's subject to the delete policy above.
create or replace function public.content_history_prune()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.content_history h
  where h.kind = new.kind
    and h.id in (
      select id from public.content_history
      where kind = new.kind
      order by created_at desc, id desc
      offset 50
    );
  return null;
end;
$$;

drop trigger if exists content_history_prune on public.content_history;
create trigger content_history_prune
  after insert on public.content_history
  for each row execute function public.content_history_prune();

-- --------------------------------------------------------------------------
-- photo_meta (alt text)
-- --------------------------------------------------------------------------
create table if not exists public.photo_meta (
  url text primary key,
  alt text,
  updated_at timestamptz not null default now()
);

alter table public.photo_meta enable row level security;

alter table public.photo_meta drop constraint if exists photo_meta_alt_length_check;
alter table public.photo_meta add constraint photo_meta_alt_length_check check (alt is null or char_length(alt) <= 300) not valid;
alter table public.photo_meta drop constraint if exists photo_meta_url_check;
alter table public.photo_meta add constraint photo_meta_url_check check (trim(url) <> '') not valid;

drop policy if exists "Public can read photo meta" on public.photo_meta;
create policy "Public can read photo meta"
  on public.photo_meta for select
  to anon, authenticated
  using (true);

drop policy if exists "Admin can manage photo meta" on public.photo_meta;
create policy "Admin can manage photo meta"
  on public.photo_meta for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create or replace function public.photo_meta_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists photo_meta_touch on public.photo_meta;
create trigger photo_meta_touch
  before update on public.photo_meta
  for each row execute function public.photo_meta_touch();
