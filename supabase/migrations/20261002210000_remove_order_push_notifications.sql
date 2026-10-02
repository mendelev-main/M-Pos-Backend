-- APNs notifications are not used because the POS is distributed without
-- an Apple Developer Program membership. Remove only push-specific data.
drop trigger if exists orders_enqueue_push on public.orders;

drop function if exists public.enqueue_new_order_push();
drop function if exists public.register_device_push_token(uuid,text,text,boolean);
drop function if exists public.claim_order_push_notifications(integer);

drop table if exists public.order_push_outbox;
drop table if exists public.device_push_tokens;
