-- Atomically create a web order and all of its immutable item snapshots.
create or replace function public.create_web_order(
  p_external_id text,
  p_tracking_token text,
  p_order_type text,
  p_customer_name text,
  p_phone text,
  p_address text,
  p_comment text,
  p_total numeric,
  p_delivery_fee numeric,
  p_items jsonb
) returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  created public.orders;
  item jsonb;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items)=0 then
    raise exception 'ORDER_ITEMS_REQUIRED';
  end if;
  insert into public.orders(external_id,tracking_token,status,order_type,customer_name,phone,address,comment,total,delivery_fee)
  values(p_external_id,p_tracking_token,'new',p_order_type,p_customer_name,p_phone,p_address,p_comment,p_total,p_delivery_fee)
  returning * into created;

  for item in select value from jsonb_array_elements(p_items)
  loop
    insert into public.order_items(order_id,product_id,external_product_id,product_name,price,quantity,comment)
    values(
      created.id,
      nullif(item->>'product_id','')::uuid,
      item->>'external_product_id',
      item->>'product_name',
      (item->>'price')::numeric,
      (item->>'quantity')::numeric,
      nullif(item->>'comment','')
    );
  end loop;
  return created;
end;
$$;

revoke all on function public.create_web_order(text,text,text,text,text,text,text,numeric,numeric,jsonb) from public;
grant execute on function public.create_web_order(text,text,text,text,text,text,text,numeric,numeric,jsonb) to service_role;
