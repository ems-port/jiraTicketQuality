-- ThingsBoard Hub telemetry history table for Supabase/Postgres.
-- Stores one snapshot row per hub per ingest run.

create table if not exists public.hub_telemetry_history (
  id bigserial primary key,
  ingest_run_id uuid not null,
  snapshot_at timestamptz not null,
  inserted_at timestamptz not null default now(),
  source text not null default 'thingsboard',

  hub_id text not null,
  hub_name text not null,
  hub_type text,
  hub_label text,

  pass_sold_count numeric,
  subscriptions_sold_count numeric,

  pass_sold_ts_ms bigint,
  subscriptions_sold_ts_ms bigint,
  latest_ts_ms bigint,

  pass_sold_at timestamptz,
  subscriptions_sold_at timestamptz,
  latest_at timestamptz,

  constraint hub_telemetry_history_ingest_hub_unique unique (ingest_run_id, hub_id)
);

create index if not exists hub_telemetry_history_hub_id_idx
  on public.hub_telemetry_history (hub_id);

create index if not exists hub_telemetry_history_latest_at_idx
  on public.hub_telemetry_history (latest_at desc nulls last);

create index if not exists hub_telemetry_history_snapshot_at_idx
  on public.hub_telemetry_history (snapshot_at desc);

create index if not exists hub_telemetry_history_label_idx
  on public.hub_telemetry_history (hub_label);

-- Convenience view: latest snapshot row per hub.
create or replace view public.hub_telemetry_latest as
select distinct on (hub_id)
  id,
  ingest_run_id,
  snapshot_at,
  inserted_at,
  source,
  hub_id,
  hub_name,
  hub_type,
  hub_label,
  pass_sold_count,
  subscriptions_sold_count,
  pass_sold_ts_ms,
  subscriptions_sold_ts_ms,
  latest_ts_ms,
  pass_sold_at,
  subscriptions_sold_at,
  latest_at
from public.hub_telemetry_history
order by hub_id, coalesce(latest_at, snapshot_at) desc, id desc;
