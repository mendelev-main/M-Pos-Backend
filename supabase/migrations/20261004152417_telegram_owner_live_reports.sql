alter table public.devices
  add column if not exists telegram_owner_chat_id text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'devices_telegram_owner_chat_id_format'
      and conrelid = 'public.devices'::regclass
  ) then
    alter table public.devices
      add constraint devices_telegram_owner_chat_id_format
      check (telegram_owner_chat_id is null or telegram_owner_chat_id ~ '^[0-9]{1,20}$');
  end if;
end
$$;
