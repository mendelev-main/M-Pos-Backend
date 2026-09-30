create or replace function public.apply_loyalty_sale(
 p_customer_id uuid,p_program_id uuid,p_idempotency_key text,p_pos_order_id text,
 p_earned integer,p_redeem integer,p_required integer,p_reward_each integer)
returns table(duplicate boolean,progress bigint,rewards bigint,granted integer,redeemed integer)
language plpgsql security definer set search_path=public
as $$
declare cur_progress bigint;cur_rewards bigint;combined bigint;cycles bigint;new_progress bigint;grant_count integer;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_customer_id::text||':'||p_program_id::text,0));
 if exists(select 1 from loyalty_ledger where idempotency_key=p_idempotency_key) then
  select coalesce(sum(progress_delta),0),coalesce(sum(reward_delta),0) into cur_progress,cur_rewards from loyalty_ledger where customer_id=p_customer_id and program_id=p_program_id;
  return query select true,cur_progress,cur_rewards,0,0;return;
 end if;
 select coalesce(sum(progress_delta),0),coalesce(sum(reward_delta),0) into cur_progress,cur_rewards from loyalty_ledger where customer_id=p_customer_id and program_id=p_program_id;
 if greatest(p_redeem,0)>cur_rewards then raise exception 'INSUFFICIENT_LOYALTY_REWARDS' using errcode='P0001';end if;
 combined:=greatest(cur_progress,0)+greatest(p_earned,0);cycles:=combined/greatest(p_required,1);new_progress:=combined%greatest(p_required,1);grant_count:=cycles*greatest(p_reward_each,1);
 insert into loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
 values(p_customer_id,p_program_id,case when greatest(p_redeem,0)>0 then 'REWARD_REDEEMED' else 'EARN' end,new_progress-cur_progress,grant_count-greatest(p_redeem,0),p_idempotency_key,jsonb_build_object('posOrderId',p_pos_order_id,'earned',greatest(p_earned,0),'redeemed',greatest(p_redeem,0),'granted',grant_count));
 return query select false,new_progress,cur_rewards+grant_count-greatest(p_redeem,0),grant_count,greatest(p_redeem,0);
end $$;
revoke all on function public.apply_loyalty_sale(uuid,uuid,text,text,integer,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.apply_loyalty_sale(uuid,uuid,text,text,integer,integer,integer,integer) to service_role;