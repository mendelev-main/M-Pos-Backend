create or replace function public.apply_single_reward_adjustment(
  p_customer_id uuid,
  p_program_id uuid,
  p_progress_delta integer,
  p_reward_delta integer,
  p_idempotency_key text,
  p_metadata jsonb default '{}'::jsonb
)
returns table(progress bigint, rewards bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cur_progress bigint;
  cur_rewards bigint;
  next_progress bigint;
  next_rewards bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_customer_id::text || ':' || p_program_id::text, 0));
  select coalesce(sum(progress_delta), 0), coalesce(sum(reward_delta), 0)
    into cur_progress, cur_rewards
  from public.loyalty_ledger
  where customer_id = p_customer_id and program_id = p_program_id;

  next_progress := cur_progress + p_progress_delta;
  next_rewards := cur_rewards + p_reward_delta;
  if next_rewards < 0 or next_rewards > 1 or next_progress < 0 or (next_rewards = 1 and next_progress <> 0) then
    raise exception 'INVALID_SINGLE_REWARD_BALANCE' using errcode = 'P0001';
  end if;

  insert into public.loyalty_ledger(
    customer_id, program_id, operation_type, progress_delta, reward_delta,
    idempotency_key, metadata
  ) values (
    p_customer_id, p_program_id, 'MANUAL_ADJUSTMENT', p_progress_delta, p_reward_delta,
    p_idempotency_key, coalesce(p_metadata, '{}'::jsonb)
  );
  return query select next_progress, next_rewards;
end
$$;

revoke all on function public.apply_single_reward_adjustment(uuid,uuid,integer,integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.apply_single_reward_adjustment(uuid,uuid,integer,integer,text,jsonb) to service_role;

create or replace function public.apply_single_reward_reversal(
  p_customer_id uuid,
  p_pos_order_id text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_row record;
  program_row record;
  inserted_rows integer;
  reversed_count integer := 0;
  cur_progress bigint;
  cur_rewards bigint;
  correction_progress bigint;
  correction_rewards bigint;
begin
  for source_row in
    select id, program_id, operation_type, progress_delta, reward_delta
    from public.loyalty_ledger
    where customer_id = p_customer_id
      and metadata->>'posOrderId' = p_pos_order_id
      and coalesce(metadata->>'reversalOf', '') = ''
    order by created_at, id
  loop
    perform pg_advisory_xact_lock(hashtextextended(p_customer_id::text || ':' || source_row.program_id::text, 0));
    insert into public.loyalty_ledger(
      customer_id, program_id, operation_type, progress_delta, reward_delta,
      idempotency_key, metadata
    ) values (
      p_customer_id, source_row.program_id, 'REVERSAL', -source_row.progress_delta, -source_row.reward_delta,
      'order:' || p_pos_order_id || ':program:' || source_row.program_id::text || ':reversal:' || source_row.id::text,
      jsonb_build_object('posOrderId', p_pos_order_id, 'reversalOf', source_row.id, 'reversalType', source_row.operation_type)
    ) on conflict (idempotency_key) do nothing;
    get diagnostics inserted_rows = row_count;
    reversed_count := reversed_count + inserted_rows;
  end loop;

  for program_row in
    select distinct program_id
    from public.loyalty_ledger
    where customer_id = p_customer_id and metadata->>'posOrderId' = p_pos_order_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(p_customer_id::text || ':' || program_row.program_id::text, 0));
    select coalesce(sum(progress_delta), 0), coalesce(sum(reward_delta), 0)
      into cur_progress, cur_rewards
    from public.loyalty_ledger
    where customer_id = p_customer_id and program_id = program_row.program_id;

    correction_rewards := case when cur_rewards > 1 then 1 - cur_rewards when cur_rewards < 0 then -cur_rewards else 0 end;
    correction_progress := case when cur_rewards + correction_rewards > 0 then -cur_progress else 0 end;
    if correction_progress <> 0 or correction_rewards <> 0 then
      insert into public.loyalty_ledger(
        customer_id, program_id, operation_type, progress_delta, reward_delta,
        idempotency_key, metadata
      ) values (
        p_customer_id, program_row.program_id, 'MANUAL_ADJUSTMENT', correction_progress, correction_rewards,
        'order:' || p_pos_order_id || ':program:' || program_row.program_id::text || ':reversal-normalize',
        jsonb_build_object('posOrderId', p_pos_order_id, 'reason', 'Нормализация одного подарка после возврата')
      ) on conflict (idempotency_key) do nothing;
    end if;
  end loop;

  return reversed_count;
end
$$;

revoke all on function public.apply_single_reward_reversal(uuid,text) from public, anon, authenticated;
grant execute on function public.apply_single_reward_reversal(uuid,text) to service_role;
