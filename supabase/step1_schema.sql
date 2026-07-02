-- RouteWing — Step 1 schema (routes table + RLS + triggers)
-- Run once in the Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run).
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE / drop-then-create for policies & triggers.

-- ── Table ──────────────────────────────────────────────────────────────────
create table if not exists public.routes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  distance_m  double precision not null,
  elevations  double precision[] not null default '{}',
  waypoints   jsonb not null,
  laps        smallint not null default 1,
  share_slug  text unique,               -- NULL until first shared (Step 4); NULLs are non-unique in PG
  is_public   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists routes_user_id_idx on public.routes (user_id);

-- ── updated_at auto-bump (Postgres has no built-in; use moddatetime) ─────────
create extension if not exists moddatetime schema extensions;
drop trigger if exists routes_set_updated_at on public.routes;
create trigger routes_set_updated_at
  before update on public.routes
  for each row execute procedure extensions.moddatetime(updated_at);

-- ── Write-abuse guard: cap saved routes per user (default 200) ───────────────
create or replace function public.routes_enforce_cap()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.routes where user_id = new.user_id) >= 200 then
    raise exception 'route limit reached (max 200 per user)';
  end if;
  return new;
end;
$$;
drop trigger if exists routes_cap_before_insert on public.routes;
create trigger routes_cap_before_insert
  before insert on public.routes
  for each row execute procedure public.routes_enforce_cap();

-- ── Row-Level Security ───────────────────────────────────────────────────────
alter table public.routes enable row level security;

drop policy if exists routes_select on public.routes;
create policy routes_select on public.routes
  for select using (user_id = auth.uid() or is_public = true);

drop policy if exists routes_insert on public.routes;
create policy routes_insert on public.routes
  for insert with check (user_id = auth.uid());

drop policy if exists routes_update on public.routes;
create policy routes_update on public.routes
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists routes_delete on public.routes;
create policy routes_delete on public.routes
  for delete using (user_id = auth.uid());

-- ── Reminder (not SQL) ───────────────────────────────────────────────────────
-- Enable Anonymous sign-ins: Dashboard → Authentication → Providers → Anonymous → ON.
-- Grab Project URL + anon public key: Dashboard → Project Settings → API.
