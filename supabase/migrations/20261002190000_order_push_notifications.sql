-- Durable APNs registration and transactional outbox for newly created WEB orders.
create table if not exists public.device_push_tokens (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  token text not null unique,
  environment text not null check (environment in ('development','production')),
  sound_enabled boolean not null default true,
  is_active boolean not null default true,
  failure_count integer not null default 0 check (failure_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists device_push_tokens_active_device_idx
  on public.device_push_tokens(device_id) where is_active=true;

create table if not exists public.order_push_outbox (
  order_id uuid primary key references public.orders(id) on delete cascade,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists order_push_outbox_pending_idx
  on public.order_push_outbox(next_attempt_at) where delivered_at is null;

alter table public.device_push_tokens enable row level security;
alter table public.order_push_outbox enable row level security;
revoke all on table public.device_push_tokens,public.order_push_outbox from anon,authenticated;
grant select,insert,update,delete on table public.device_push_tokens,public.order_push_outbox to service_role;

create or replace function public.enqueue_new_order_push()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.order_push_outbox(order_id) values(new.id) on conflict(order_id) do nothing;
  return new;
end;
$$;

drop trigger if exists orders_enqueue_push on public.orders;
create trigger orders_enqueue_push
after insert on public.orders
for each row execute function public.enqueue_new_order_push();

create or replace function public.register_device_push_token(
  p_device_id uuid,
  p_token text,
  p_environment text,
  p_sound_enabled boolean
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if nullif(trim(p_token),'') is null or p_environment not in ('development','production') then
    raise exception 'INVALID_PUSH_TOKEN' using errcode='P0001';
  end if;
  update public.device_push_tokens
  set is_active=false,updated_at=now()
  where device_id=p_device_id and environment=p_environment and token<>lower(trim(p_token));
  insert into public.device_push_tokens(device_id,token,environment,sound_enabled,is_active,failure_count,updated_at)
  values(p_device_id,lower(trim(p_token)),p_environment,coalesce(p_sound_enabled,true),true,0,now())
  on conflict(token) do update set
    device_id=excluded.device_id,
    environment=excluded.environment,
    sound_enabled=excluded.sound_enabled,
    is_active=true,
    failure_count=0,
    updated_at=now();
end;
$$;

create or replace function public.claim_order_push_notifications(p_limit integer default 10)
returns table(order_id uuid,external_id text,order_type text,total numeric,attempts integer)
language sql
security invoker
set search_path = ''
as $$
  with claimed as (
    select o.order_id
    from public.order_push_outbox o
    where o.delivered_at is null and o.next_attempt_at<=now()
    order by o.next_attempt_at,o.created_at
    for update skip locked
    limit least(greatest(coalesce(p_limit,10),1),50)
  ), leased as (
    update public.order_push_outbox o
    set attempts=o.attempts+1,next_attempt_at=now()+interval '1 minute'
    from claimed c
    where o.order_id=c.order_id
    returning o.order_id,o.attempts
  )
  select r.id,r.external_id,r.order_type,r.total,l.attempts
  from leased l join public.orders r on r.id=l.order_id;
$$;

revoke all on function public.enqueue_new_order_push() from public,anon,authenticated;
revoke all on function public.register_device_push_token(uuid,text,text,boolean) from public,anon,authenticated;
revoke all on function public.claim_order_push_notifications(integer) from public,anon,authenticated;
grant execute on function public.enqueue_new_order_push() to service_role;
grant execute on function public.register_device_push_token(uuid,text,text,boolean) to service_role;
grant execute on function public.claim_order_push_notifications(integer) to service_role;
