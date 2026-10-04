alter table public.devices
  add column if not exists telegram_order_chat_id text,
  add column if not exists notify_online_orders boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'devices_telegram_order_chat_id_format'
  ) then
    alter table public.devices
      add constraint devices_telegram_order_chat_id_format
      check (telegram_order_chat_id is null or telegram_order_chat_id ~ '^[0-9]{1,20}$');
  end if;
end
$$;
