-- Production ETA operational state from POS.
-- One durable latest state per registered device; history is intentionally not stored here.
create table if not exists public.operational_states (
  device_id uuid primary key references public.devices(id) on delete cascade,
  schema_version integer not null,
  engine_version integer,
  heartbeat_at timestamptz,
  snapshot_sampled_at timestamptz,
  snapshot_received_at timestamptz,
  snapshot jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists operational_states_heartbeat_at_idx
  on public.operational_states (heartbeat_at desc);

comment on table public.operational_states is
  'Latest coalesced POS production heartbeat/snapshot used for ETA freshness.';

alter table public.operational_states enable row level security;
