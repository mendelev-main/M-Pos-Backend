create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_phone text not null unique,
  telegram_user_id text,
  telegram_username text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_purchase_at timestamptz
);

create unique index if not exists customers_telegram_user_id_uidx
  on public.customers (telegram_user_id)
  where telegram_user_id is not null;

create index if not exists customers_name_idx on public.customers (lower(name));

alter table public.customers enable row level security;

alter table public.orders
  add column if not exists customer_id uuid references public.customers(id) on delete set null;

create index if not exists orders_customer_id_idx on public.orders(customer_id);

revoke all on table public.customers from anon, authenticated;
grant select, insert, update, delete on table public.customers to service_role;
