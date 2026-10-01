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
  select * into checkout
  from public.checkout_sessions
  where verification_token_hash = p_verification_token_hash
  for update;

  if not found then return null; end if;
  if checkout.status = 'ORDER_CREATED' then
    return jsonb_build_object('ok',true,'orderId',checkout.order_id,'customerId',
      (select customer_id from public.orders where id=checkout.order_id),'duplicate',true);
  end if;
  if checkout.status <> 'PENDING' or checkout.expires_at <= now() then
    raise exception 'CHECKOUT_EXPIRED' using errcode='P0001';
  end if;

  select * into verification
  from public.phone_verifications
  where token_hash = p_verification_token_hash
  for update;
  if not found or verification.status <> 'VERIFIED' or verification.phone <> checkout.phone or verification.expires_at <= now() then
    raise exception 'VERIFICATION_NOT_READY' using errcode='P0001';
  end if;

  payload := checkout.order_payload;
  if jsonb_typeof(payload->'items') <> 'array' or jsonb_array_length(payload->'items') = 0 then
    raise exception 'ORDER_ITEMS_REQUIRED' using errcode='P0001';
  end if;

  insert into public.customers(name,normalized_phone,telegram_user_id,updated_at)
  values(coalesce(nullif(trim(payload->>'customerName'),''),'Гость'),checkout.phone,verification.telegram_user_id,now())
  on conflict(normalized_phone) do update set
    name=excluded.name,
    telegram_user_id=coalesce(excluded.telegram_user_id,public.customers.telegram_user_id),
    updated_at=now()
  returning * into customer;

  insert into public.orders(external_id,tracking_token,status,order_type,customer_name,phone,customer_id,address,comment,total,delivery_fee)
  values(
    p_external_id,p_tracking_token,'new',payload->>'orderType',payload->>'customerName',checkout.phone,customer.id,
    nullif(payload->>'address',''),nullif(payload->>'comment',''),
    coalesce((payload->>'total')::numeric,0),coalesce((payload->>'fee')::numeric,0)
  ) returning * into created_order;

  for item in select value from jsonb_array_elements(payload->'items') loop
    insert into public.order_items(order_id,product_id,external_product_id,product_name,price,quantity,comment)
    values(
      created_order.id,nullif(item->>'product_id','')::uuid,item->>'external_product_id',item->>'product_name',
      (item->>'price')::numeric,(item->>'quantity')::numeric,nullif(item->>'comment','')
    );
  end loop;

  update public.phone_verifications
  set status='CONSUMED',consumed_at=now()
  where id=verification.id;

  update public.checkout_sessions
  set status='ORDER_CREATED',verified_at=verification.verified_at,order_id=created_order.id,
      tracking_token=p_tracking_token,telegram_user_id=verification.telegram_user_id,updated_at=now()
  where id=checkout.id;

  return jsonb_build_object('ok',true,'orderId',created_order.id,'customerId',customer.id,'duplicate',false);
end;
$$;

revoke all on function public.finalize_verified_checkout(text,text,text) from public,anon,authenticated;
grant execute on function public.finalize_verified_checkout(text,text,text) to service_role;

create or replace function public.replace_loyalty_program(
  p_program_id uuid,
  p_name text,
  p_required integer,
  p_reward integer,
  p_is_active boolean,
  p_earning_ids text[],
  p_reward_ids text[]
) returns public.loyalty_programs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated public.loyalty_programs;
begin
  if nullif(trim(p_name),'') is null or p_required < 1 or p_reward < 1
     or coalesce(array_length(p_earning_ids,1),0)=0 or coalesce(array_length(p_reward_ids,1),0)=0 then
    raise exception 'INVALID_LOYALTY_PROGRAM' using errcode='P0001';
  end if;

  perform 1 from public.loyalty_programs where id=p_program_id for update;
  if not found then raise exception 'LOYALTY_PROGRAM_NOT_FOUND' using errcode='P0001'; end if;

  update public.loyalty_programs
  set name=trim(p_name),required_quantity=p_required,reward_quantity=p_reward,is_active=p_is_active,updated_at=now()
  where id=p_program_id returning * into updated;

  delete from public.loyalty_earning_products where program_id=p_program_id;
  delete from public.loyalty_reward_products where program_id=p_program_id;
  insert into public.loyalty_earning_products(program_id,product_id)
    select p_program_id,value from unnest(p_earning_ids) value;
  insert into public.loyalty_reward_products(program_id,product_id)
    select p_program_id,value from unnest(p_reward_ids) value;

  return updated;
end;
$$;

revoke all on function public.replace_loyalty_program(uuid,text,integer,integer,boolean,text[],text[]) from public,anon,authenticated;
grant execute on function public.replace_loyalty_program(uuid,text,integer,integer,boolean,text[],text[]) to service_role;
