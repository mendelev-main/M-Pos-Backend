-- Authoritative POS snapshots plus atomic reservations for confirmed WEB orders.
create table if not exists public.availability_states (
  device_id uuid primary key references public.devices(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  sampled_at timestamptz,
  received_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.product_availability (
  device_id uuid not null references public.devices(id) on delete cascade,
  external_product_id text not null,
  quantity numeric check (quantity is null or quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key(device_id,external_product_id)
);

create table if not exists public.web_order_reservations (
  order_id uuid not null references public.orders(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  external_product_id text not null,
  quantity numeric not null check (quantity > 0),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key(order_id,external_product_id)
);

create index if not exists web_order_reservations_open_product_idx
  on public.web_order_reservations(device_id,external_product_id)
  where settled_at is null;

alter table public.availability_states enable row level security;
alter table public.product_availability enable row level security;
alter table public.web_order_reservations enable row level security;
revoke all on table public.availability_states,public.product_availability,public.web_order_reservations from anon,authenticated;
grant select,insert,update,delete on table public.availability_states,public.product_availability,public.web_order_reservations to service_role;

create or replace function public.store_availability_snapshot(
  p_device_id uuid,
  p_revision bigint,
  p_sampled_at timestamptz,
  p_items jsonb,
  p_settled_order_ids text[] default '{}'::text[]
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_revision bigint;
begin
  if p_revision <= 0 or p_sampled_at is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'INVALID_AVAILABILITY_SNAPSHOT' using errcode='P0001';
  end if;
  if exists(
    select 1 from jsonb_array_elements(p_items) item
    where nullif(trim(item->>'externalId'),'') is null
      or not (item ? 'quantity')
      or not (jsonb_typeof(item->'quantity') in ('number','null'))
      or (jsonb_typeof(item->'quantity')='number' and (item->>'quantity')::numeric < 0)
  ) or exists(
    select item->>'externalId' from jsonb_array_elements(p_items) item
    group by item->>'externalId' having count(*) > 1
  ) then
    raise exception 'INVALID_AVAILABILITY_ITEM' using errcode='P0001';
  end if;

  insert into public.availability_states(device_id,revision)
  values(p_device_id,0)
  on conflict(device_id) do nothing;
  select revision into current_revision from public.availability_states where device_id=p_device_id for update;
  if p_revision <= current_revision then return false; end if;

  update public.web_order_reservations
  set settled_at=coalesce(settled_at,now())
  where device_id=p_device_id and settled_at is null and order_id::text=any(coalesce(p_settled_order_ids,'{}'::text[]));

  delete from public.product_availability where device_id=p_device_id;
  insert into public.product_availability(device_id,external_product_id,quantity,updated_at)
  select p_device_id,trim(item->>'externalId'),
    case when jsonb_typeof(item->'quantity')='null' then null else (item->>'quantity')::numeric end,
    now()
  from jsonb_array_elements(p_items) item;

  update public.availability_states
  set revision=p_revision,sampled_at=p_sampled_at,received_at=now(),updated_at=now()
  where device_id=p_device_id;
  return true;
end;
$$;

create or replace function public.get_web_availability()
returns table(external_product_id text,quantity numeric)
language sql
security invoker
set search_path = ''
as $$
  with active_device as (
    select (array_agg(id order by id))[1] device_id
    from public.devices where is_active=true
    having count(*)=1
  ), reserved as (
    select r.device_id,r.external_product_id,sum(r.quantity) quantity
    from public.web_order_reservations r
    where r.settled_at is null
    group by r.device_id,r.external_product_id
  )
  select a.external_product_id,
    case when a.quantity is null then null else greatest(0,a.quantity-coalesce(r.quantity,0)) end
  from public.product_availability a
  join active_device d on d.device_id=a.device_id
  left join reserved r on r.device_id=a.device_id and r.external_product_id=a.external_product_id;
$$;

create or replace function public.reserve_web_order_items(p_order_id uuid,p_items jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  active_device_id uuid;
  active_device_count integer;
  item jsonb;
  requested numeric;
  physical numeric;
  reserved numeric;
begin
  select count(*)::integer,(array_agg(id order by id))[1]
  into active_device_count,active_device_id
  from public.devices where is_active=true;
  if active_device_count <> 1 then raise exception 'AVAILABILITY_UNAVAILABLE' using errcode='P0001'; end if;

  perform 1 from public.availability_states where device_id=active_device_id for update;
  if not found then raise exception 'AVAILABILITY_UNAVAILABLE' using errcode='P0001'; end if;

  for item in select value from jsonb_array_elements(p_items) order by value->>'external_product_id' loop
    requested=(item->>'quantity')::numeric;
    select quantity into physical
    from public.product_availability
    where device_id=active_device_id and external_product_id=item->>'external_product_id'
    for update;
    if not found then raise exception 'AVAILABILITY_UNAVAILABLE' using errcode='P0001'; end if;
    if physical is not null then
      select coalesce(sum(quantity),0) into reserved
      from public.web_order_reservations
      where device_id=active_device_id and external_product_id=item->>'external_product_id' and settled_at is null;
      if requested > greatest(0,physical-reserved) then raise exception 'OUT_OF_STOCK:%',item->>'external_product_id' using errcode='P0001'; end if;
    end if;
    insert into public.web_order_reservations(order_id,device_id,external_product_id,quantity)
    values(p_order_id,active_device_id,item->>'external_product_id',requested);
  end loop;
end;
$$;

create or replace function public.finalize_verified_checkout(
  p_verification_token_hash text,
  p_external_id text,
  p_tracking_token text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  checkout public.checkout_sessions;
  verification public.phone_verifications;
  customer public.customers;
  created_order public.orders;
  payload jsonb;
  item jsonb;
begin
  select * into checkout from public.checkout_sessions where verification_token_hash=p_verification_token_hash for update;
  if not found then return null; end if;
  if checkout.status='ORDER_CREATED' then
    return jsonb_build_object('ok',true,'orderId',checkout.order_id,'customerId',(select customer_id from public.orders where id=checkout.order_id),'duplicate',true);
  end if;
  if checkout.status<>'PENDING' or checkout.expires_at<=now() then raise exception 'CHECKOUT_EXPIRED' using errcode='P0001'; end if;

  select * into verification from public.phone_verifications where token_hash=p_verification_token_hash for update;
  if not found or verification.status<>'VERIFIED' or verification.phone<>checkout.phone or verification.expires_at<=now() then raise exception 'VERIFICATION_NOT_READY' using errcode='P0001'; end if;
  payload=checkout.order_payload;
  if jsonb_typeof(payload->'items')<>'array' or jsonb_array_length(payload->'items')=0 then raise exception 'ORDER_ITEMS_REQUIRED' using errcode='P0001'; end if;

  insert into public.customers(name,normalized_phone,telegram_user_id,updated_at)
  values(coalesce(nullif(trim(payload->>'customerName'),''),'Гость'),checkout.phone,verification.telegram_user_id,now())
  on conflict(normalized_phone) do update set name=excluded.name,telegram_user_id=coalesce(excluded.telegram_user_id,public.customers.telegram_user_id),updated_at=now()
  returning * into customer;

  insert into public.orders(external_id,tracking_token,status,order_type,customer_name,phone,customer_id,address,comment,total,delivery_fee)
  values(p_external_id,p_tracking_token,'new',payload->>'orderType',payload->>'customerName',checkout.phone,customer.id,nullif(payload->>'address',''),nullif(payload->>'comment',''),coalesce((payload->>'total')::numeric,0),coalesce((payload->>'fee')::numeric,0))
  returning * into created_order;

  perform public.reserve_web_order_items(created_order.id,payload->'items');
  for item in select value from jsonb_array_elements(payload->'items') loop
    insert into public.order_items(order_id,product_id,external_product_id,product_name,price,quantity,comment)
    values(created_order.id,nullif(item->>'product_id','')::uuid,item->>'external_product_id',item->>'product_name',(item->>'price')::numeric,(item->>'quantity')::numeric,nullif(item->>'comment',''));
  end loop;
  update public.phone_verifications set status='CONSUMED',consumed_at=now() where id=verification.id;
  update public.checkout_sessions set status='ORDER_CREATED',verified_at=verification.verified_at,order_id=created_order.id,tracking_token=p_tracking_token,telegram_user_id=verification.telegram_user_id,updated_at=now() where id=checkout.id;
  return jsonb_build_object('ok',true,'orderId',created_order.id,'customerId',customer.id,'duplicate',false);
end;
$$;

create or replace function public.create_web_order(
  p_external_id text,p_tracking_token text,p_order_type text,p_customer_name text,p_phone text,
  p_address text,p_comment text,p_total numeric,p_delivery_fee numeric,p_items jsonb
) returns public.orders
language plpgsql
security invoker
set search_path = ''
as $$
declare created public.orders;item jsonb;
begin
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'ORDER_ITEMS_REQUIRED' using errcode='P0001'; end if;
  insert into public.orders(external_id,tracking_token,status,order_type,customer_name,phone,address,comment,total,delivery_fee)
  values(p_external_id,p_tracking_token,'new',p_order_type,p_customer_name,p_phone,p_address,p_comment,p_total,p_delivery_fee) returning * into created;
  perform public.reserve_web_order_items(created.id,p_items);
  for item in select value from jsonb_array_elements(p_items) loop
    insert into public.order_items(order_id,product_id,external_product_id,product_name,price,quantity,comment)
    values(created.id,nullif(item->>'product_id','')::uuid,item->>'external_product_id',item->>'product_name',(item->>'price')::numeric,(item->>'quantity')::numeric,nullif(item->>'comment',''));
  end loop;
  return created;
end;
$$;

revoke all on function public.store_availability_snapshot(uuid,bigint,timestamptz,jsonb,text[]) from public,anon,authenticated;
revoke all on function public.get_web_availability() from public,anon,authenticated;
revoke all on function public.reserve_web_order_items(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.finalize_verified_checkout(text,text,text) from public,anon,authenticated;
revoke all on function public.create_web_order(text,text,text,text,text,text,text,numeric,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.store_availability_snapshot(uuid,bigint,timestamptz,jsonb,text[]) to service_role;
grant execute on function public.get_web_availability() to service_role;
grant execute on function public.reserve_web_order_items(uuid,jsonb) to service_role;
grant execute on function public.finalize_verified_checkout(text,text,text) to service_role;
grant execute on function public.create_web_order(text,text,text,text,text,text,text,numeric,numeric,jsonb) to service_role;
