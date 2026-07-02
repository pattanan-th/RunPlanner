-- RouteWing — Step 3 schema (route_cache table)
-- Run once in the Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run).
-- Safe to re-run: uses IF NOT EXISTS.

create table if not exists public.route_cache (
  cache_key    text primary key,       -- sha256 of "kind|profile|rounded-waypoints"
  kind         text not null check (kind in ('directions', 'elevation')),
  payload      jsonb not null,          -- normalized response (see Edge Function code)
  hit_count    int not null default 1,
  created_at   timestamptz not null default now(),
  last_hit_at  timestamptz not null default now()
);

-- RLS enabled with ZERO policies for anon/authenticated — only the Edge Functions'
-- service-role client (which bypasses RLS entirely) ever reads/writes this table.
alter table public.route_cache enable row level security;

-- Deferred (not built yet): a 90-day-TTL cleanup job (pg_cron or scheduled Edge
-- Function) evicting rows where last_hit_at < now() - interval '90 days'. Revisit
-- once real usage data shows how large this table actually gets.
