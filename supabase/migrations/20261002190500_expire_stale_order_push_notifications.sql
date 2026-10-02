-- Never deliver a backlog of obsolete order alerts after APNs was unavailable.
create or replace function public.claim_order_push_notifications(p_limit integer default 10)
returns table(order_id uuid,external_id text,order_type text,total numeric,attempts integer)
language sql
security invoker
set search_path = ''
as $$
  with expired as (
    update public.order_push_outbox
    set delivered_at=now(),last_error='Push delivery window expired'
    where delivered_at is null and created_at<now()-interval '15 minutes'
    returning order_id
  ), claimed as (
    select o.order_id
    from public.order_push_outbox o
    where o.delivered_at is null
      and o.next_attempt_at<=now()
      and o.created_at>=now()-interval '15 minutes'
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

revoke all on function public.claim_order_push_notifications(integer) from public,anon,authenticated;
grant execute on function public.claim_order_push_notifications(integer) to service_role;
