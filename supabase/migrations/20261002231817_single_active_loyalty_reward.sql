-- Loyalty programs expose one active reward at a time. Existing balances are
-- normalized with append-only audit entries before the invariant is enforced.
update public.loyalty_programs
set reward_quantity = 1, updated_at = now()
where reward_quantity <> 1;

with balances as (
  select customer_id, program_id,
    coalesce(sum(progress_delta), 0)::integer as progress,
    coalesce(sum(reward_delta), 0)::integer as rewards
  from public.loyalty_ledger
  group by customer_id, program_id
), corrections as (
  select customer_id, program_id,
    case when rewards > 0 then -progress else 0 end as progress_delta,
    case when rewards > 1 then 1 - rewards else 0 end as reward_delta,
    progress as previous_progress,
    rewards as previous_rewards
  from balances
  where rewards > 1 or (rewards > 0 and progress <> 0)
)
insert into public.loyalty_ledger(
  customer_id, program_id, operation_type, progress_delta, reward_delta,
  idempotency_key, metadata
)
select customer_id, program_id, 'MANUAL_ADJUSTMENT', progress_delta, reward_delta,
  'single-active-reward:' || customer_id::text || ':' || program_id::text,
  jsonb_build_object(
    'reason', 'Переход на один активный подарок',
    'previousProgress', previous_progress,
    'previousRewards', previous_rewards
  )
from corrections
where progress_delta <> 0 or reward_delta <> 0
on conflict (idempotency_key) do nothing;

alter table public.loyalty_programs
  drop constraint if exists loyalty_programs_single_reward;
alter table public.loyalty_programs
  add constraint loyalty_programs_single_reward check (reward_quantity = 1);

create or replace function public.apply_loyalty_sale(
  p_customer_id uuid, p_program_id uuid, p_idempotency_key text, p_pos_order_id text,
  p_earned integer, p_redeem integer, p_required integer, p_reward_each integer
)
returns table(duplicate boolean, progress bigint, rewards bigint, granted integer, redeemed integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cur_progress bigint;
  cur_rewards bigint;
  redeem_count integer;
  remaining_rewards bigint;
  combined bigint;
  new_progress bigint;
  grant_count integer;
  progress_change bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_customer_id::text || ':' || p_program_id::text, 0));

  if exists (
    select 1 from public.loyalty_ledger
    where idempotency_key in (
      p_idempotency_key,
      p_idempotency_key || ':earn',
      p_idempotency_key || ':grant',
      p_idempotency_key || ':redeem'
    )
  ) then
    select coalesce(sum(progress_delta), 0), coalesce(sum(reward_delta), 0)
      into cur_progress, cur_rewards
    from public.loyalty_ledger
    where customer_id = p_customer_id and program_id = p_program_id;
    return query select true, cur_progress, cur_rewards, 0, 0;
    return;
  end if;

  select coalesce(sum(progress_delta), 0), coalesce(sum(reward_delta), 0)
    into cur_progress, cur_rewards
  from public.loyalty_ledger
  where customer_id = p_customer_id and program_id = p_program_id;

  redeem_count := greatest(p_redeem, 0);
  if redeem_count > cur_rewards or redeem_count > 1 then
    raise exception 'INSUFFICIENT_LOYALTY_REWARDS' using errcode = 'P0001';
  end if;

  remaining_rewards := cur_rewards - redeem_count;
  combined := greatest(cur_progress, 0) + greatest(p_earned, 0);

  if remaining_rewards > 0 then
    new_progress := 0;
    grant_count := 0;
  elsif combined >= greatest(p_required, 1) then
    new_progress := 0;
    grant_count := 1;
  else
    new_progress := combined;
    grant_count := 0;
  end if;
  progress_change := new_progress - cur_progress;

  if greatest(p_earned, 0) > 0 then
    insert into public.loyalty_ledger(
      customer_id, program_id, operation_type, progress_delta, reward_delta,
      idempotency_key, metadata
    ) values (
      p_customer_id, p_program_id, 'EARN', progress_change, 0,
      p_idempotency_key || ':earn',
      jsonb_build_object(
        'posOrderId', p_pos_order_id,
        'earned', greatest(p_earned, 0),
        'frozen', remaining_rewards > 0
      )
    );
  end if;

  if grant_count > 0 then
    insert into public.loyalty_ledger(
      customer_id, program_id, operation_type, progress_delta, reward_delta,
      idempotency_key, metadata
    ) values (
      p_customer_id, p_program_id, 'REWARD_GRANTED', 0, 1,
      p_idempotency_key || ':grant',
      jsonb_build_object('posOrderId', p_pos_order_id, 'granted', 1)
    );
  end if;

  if redeem_count > 0 then
    insert into public.loyalty_ledger(
      customer_id, program_id, operation_type, progress_delta, reward_delta,
      idempotency_key, metadata
    ) values (
      p_customer_id, p_program_id, 'REWARD_REDEEMED', 0, -redeem_count,
      p_idempotency_key || ':redeem',
      jsonb_build_object('posOrderId', p_pos_order_id, 'redeemed', redeem_count)
    );
  end if;

  return query select false, new_progress, least(1::bigint, remaining_rewards + grant_count), grant_count, redeem_count;
end
$$;

revoke all on function public.apply_loyalty_sale(uuid,uuid,text,text,integer,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.apply_loyalty_sale(uuid,uuid,text,text,integer,integer,integer,integer) to service_role;
