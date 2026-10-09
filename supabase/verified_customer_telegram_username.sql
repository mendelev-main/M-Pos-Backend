alter table public.phone_verifications add column if not exists telegram_username text;
alter table public.phone_verifications add column if not exists telegram_username_observed boolean not null default false;
alter table public.customers add column if not exists telegram_username text;

create or replace function public.sync_verified_customer_telegram_username()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $$
declare observed boolean; username text;
begin
  select v.telegram_username_observed, v.telegram_username into observed, username
  from public.phone_verifications v
  where v.phone = new.normalized_phone and v.telegram_user_id = new.telegram_user_id
    and v.status in ('VERIFIED','CONSUMED')
  order by v.verified_at desc nulls last, v.created_at desc
  limit 1;
  if observed then
    new.telegram_username := case when username ~ '^[A-Za-z][A-Za-z0-9_]{3,31}$' then username else null end;
  elsif tg_op = 'INSERT' or new.telegram_user_id is distinct from old.telegram_user_id then
    new.telegram_username := null;
  end if;
  return new;
end;
$$;
revoke all on function public.sync_verified_customer_telegram_username() from public, anon, authenticated;
drop trigger if exists sync_verified_customer_telegram_username on public.customers;
create trigger sync_verified_customer_telegram_username
before insert or update of telegram_user_id on public.customers
for each row execute function public.sync_verified_customer_telegram_username();
