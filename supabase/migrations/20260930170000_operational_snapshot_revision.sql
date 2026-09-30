-- Reject delayed operational snapshots atomically by durable POS revision.
alter table public.operational_states
  add column if not exists snapshot_revision bigint not null default 0;

create or replace function public.store_operational_snapshot(
  p_device_id uuid,
  p_schema_version integer,
  p_engine_version integer,
  p_revision bigint,
  p_sampled_at timestamptz,
  p_received_at timestamptz,
  p_snapshot jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  applied boolean := false;
begin
  insert into public.operational_states(
    device_id,schema_version,engine_version,heartbeat_at,
    snapshot_sampled_at,snapshot_received_at,snapshot_revision,snapshot,updated_at
  ) values (
    p_device_id,p_schema_version,p_engine_version,p_received_at,
    p_sampled_at,p_received_at,p_revision,p_snapshot,p_received_at
  )
  on conflict (device_id) do update set
    schema_version=excluded.schema_version,
    engine_version=excluded.engine_version,
    heartbeat_at=excluded.heartbeat_at,
    snapshot_sampled_at=excluded.snapshot_sampled_at,
    snapshot_received_at=excluded.snapshot_received_at,
    snapshot_revision=excluded.snapshot_revision,
    snapshot=excluded.snapshot,
    updated_at=excluded.updated_at
  where operational_states.snapshot_revision < excluded.snapshot_revision;
  get diagnostics applied = row_count;
  return applied;
end;
$$;

revoke all on function public.store_operational_snapshot(uuid,integer,integer,bigint,timestamptz,timestamptz,jsonb) from public;
grant execute on function public.store_operational_snapshot(uuid,integer,integer,bigint,timestamptz,timestamptz,jsonb) to service_role;
