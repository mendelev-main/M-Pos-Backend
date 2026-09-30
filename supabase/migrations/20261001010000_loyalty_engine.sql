create table if not exists public.loyalty_programs (
 id uuid primary key default gen_random_uuid(), name text not null, required_quantity integer not null check(required_quantity>0),
 reward_quantity integer not null default 1 check(reward_quantity>0), is_active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.loyalty_earning_products (
 program_id uuid not null references public.loyalty_programs(id) on delete cascade,
 product_id uuid not null references public.products(id) on delete cascade,
 primary key(program_id,product_id)
);
create table if not exists public.loyalty_reward_products (
 program_id uuid not null references public.loyalty_programs(id) on delete cascade,
 product_id uuid not null references public.products(id) on delete cascade,
 primary key(program_id,product_id)
);
create table if not exists public.loyalty_ledger (
 id uuid primary key default gen_random_uuid(),
 customer_id uuid not null references public.customers(id) on delete restrict,
 program_id uuid not null references public.loyalty_programs(id) on delete restrict,
 order_id uuid references public.orders(id) on delete set null,
 operation_type text not null check(operation_type in ('EARN','REWARD_GRANTED','REWARD_REDEEMED','REVERSAL','MANUAL_ADJUSTMENT')),
 progress_delta integer not null default 0, reward_delta integer not null default 0,
 idempotency_key text not null unique, metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index if not exists loyalty_ledger_customer_program_idx on public.loyalty_ledger(customer_id,program_id,created_at);
alter table public.loyalty_programs enable row level security;
alter table public.loyalty_earning_products enable row level security;
alter table public.loyalty_reward_products enable row level security;
alter table public.loyalty_ledger enable row level security;
revoke all on public.loyalty_programs,public.loyalty_earning_products,public.loyalty_reward_products,public.loyalty_ledger from anon,authenticated;
grant select,insert,update,delete on public.loyalty_programs,public.loyalty_earning_products,public.loyalty_reward_products,public.loyalty_ledger to service_role;

create or replace function public.loyalty_balance(p_customer_id uuid,p_program_id uuid)
returns table(progress bigint,rewards bigint)
language sql stable security invoker set search_path=public
as $$ select coalesce(sum(progress_delta),0)::bigint,coalesce(sum(reward_delta),0)::bigint from public.loyalty_ledger where customer_id=p_customer_id and program_id=p_program_id $$;
revoke all on function public.loyalty_balance(uuid,uuid) from public,anon,authenticated;
grant execute on function public.loyalty_balance(uuid,uuid) to service_role;