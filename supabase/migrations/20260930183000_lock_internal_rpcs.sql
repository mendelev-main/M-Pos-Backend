-- Internal backend RPCs must never be callable with public client roles.
revoke execute on function public.store_operational_snapshot(uuid,integer,integer,bigint,timestamptz,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.store_operational_snapshot(uuid,integer,integer,bigint,timestamptz,timestamptz,jsonb) to service_role;

revoke execute on function public.create_web_order(text,text,text,text,text,text,text,numeric,numeric,jsonb) from public, anon, authenticated;
grant execute on function public.create_web_order(text,text,text,text,text,text,text,numeric,numeric,jsonb) to service_role;

revoke all on table public.operational_states from anon, authenticated;
