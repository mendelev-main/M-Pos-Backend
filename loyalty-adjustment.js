// Absolute UI corrections share the same transaction locks as sales and withdrawals.
export function createLoyaltyBalanceAdjustment({withTransaction}){
 return async function adjust(customerId,payload){
  const {programId,requestId,expectedBalance,targetBalance,consentVersion}=payload;
  const integers=x=>x&&Number.isSafeInteger(x.progress)&&Number.isSafeInteger(x.rewards)&&x.progress>=0&&[0,1].includes(x.rewards);
  if(!/^[-\w]{8,100}$/.test(String(requestId||''))||!integers(expectedBalance)||!integers(targetBalance)||!consentVersion)return {status:400,error:'Некорректные данные корректировки'};
  return withTransaction(async client=>{
   const q=client.query.bind(client),key=`manual-ui:${customerId}:${programId}:${requestId}`;
   await q("SELECT pg_advisory_xact_lock(hashtextextended('privacy:'||$1::text,0))",[customerId]);
   await q("SELECT pg_advisory_xact_lock(hashtextextended($1::text||':'||$2::text,0))",[customerId,programId]);
   const prior=(await q('SELECT metadata FROM public.loyalty_ledger WHERE idempotency_key=$1',[key])).rows[0];
   if(prior){const t=prior.metadata?.targetBalance;if(t?.progress!==targetBalance.progress||t?.rewards!==targetBalance.rewards)return {status:409,error:'Запрос уже использован с другими значениями'};return {ok:true,duplicate:true};}
   const membership=(await q('SELECT version,public.loyalty_membership_active(customer_id) AS active FROM public.loyalty_memberships WHERE customer_id=$1::uuid',[customerId])).rows[0];
   if(!membership?.active||String(membership.version)!==String(consentVersion))return {status:409,code:'LOYALTY_CONSENT_REQUIRED',error:'Участие изменилось. Обновите карточку клиента'};
   const program=(await q('SELECT required_quantity FROM public.loyalty_programs WHERE id=$1::uuid AND is_active=true FOR SHARE',[programId])).rows[0];
   if(!program)return {status:409,error:'Программа больше не активна'};
   if(targetBalance.progress>=Number(program.required_quantity)||(targetBalance.rewards===1&&targetBalance.progress!==0))return {status:400,error:'При доступном подарке прогресс должен быть равен нулю'};
   const balance=(await q('SELECT * FROM public.loyalty_balance($1::uuid,$2::uuid)',[customerId,programId])).rows[0];
   if(Number(balance.progress)!==expectedBalance.progress||Number(balance.rewards)!==expectedBalance.rewards)return {status:409,code:'LOYALTY_BALANCE_CHANGED',error:'Баланс изменился после открытия карточки. Обновите данные перед корректировкой'};
   const pd=targetBalance.progress-expectedBalance.progress,rd=targetBalance.rewards-expectedBalance.rewards;
   if(!pd&&!rd)return {status:400,error:'Значения не изменились'};
   await q('SELECT * FROM public.apply_single_reward_adjustment($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb)',[customerId,programId,pd,rd,key,JSON.stringify({reason:payload.reason,adminEmployeeId:payload.adminEmployeeId,adminEmployeeName:payload.adminEmployeeName,targetBalance,expectedBalance,consentVersion})]);
   return {ok:true};
  });
 };
}
