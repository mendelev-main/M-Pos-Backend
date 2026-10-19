import { LEGAL_VERSION, LEGAL_DOCUMENTS } from './legal-documents.js';
export function posLoyaltyTerms(){return {version:LEGAL_VERSION,documents:['privacy','loyalty','consent'].map(slug=>({slug,...LEGAL_DOCUMENTS[slug]}))};}
export function createPosLoyaltyConsent({withTransaction}){
 return async function enroll({customerId,deviceId,payload}){
  const staff=payload?.staff,requestId=String(payload?.requestId||'');
  if(payload?.acknowledged!==true||payload?.phoneChecked!==true)return {status:400,error:'Подтвердите полученное личное согласие и проверку телефона'};
  if(payload.documentVersion!==LEGAL_VERSION)return {status:409,code:'LEGAL_VERSION_REQUIRED',error:'Условия обновились. Откройте подтверждение заново'};
  if(!staff?.id||!staff?.name||String(staff.id).length>128||String(staff.name).length>128||!/^[-\w]{8,100}$/.test(requestId))return {status:400,error:'Не указан сотрудник или идентификатор подтверждения'};
  return withTransaction(async client=>{
   const q=client.query.bind(client);
   await q("SELECT pg_advisory_xact_lock(hashtextextended('privacy:'||$1::text,0))",[customerId]);
   const customer=(await q('SELECT id,privacy_retired_at FROM public.customers WHERE id=$1::uuid FOR UPDATE',[customerId])).rows[0];
   if(!customer||customer.privacy_retired_at)return {status:404,error:'Клиент не найден. Создайте новую карточку'};
   const current=(await q('SELECT *,public.loyalty_membership_active(customer_id) AS active FROM public.loyalty_memberships WHERE customer_id=$1::uuid FOR UPDATE',[customerId])).rows[0];
   const prior=(await q("SELECT evidence FROM public.privacy_events WHERE customer_id=$1::uuid AND event_type='loyalty_consented' AND evidence->>'deviceId'=$2 AND evidence->>'requestId'=$3",[customerId,deviceId,requestId])).rows[0];
   if(prior){if(current?.active&&String(prior.evidence.membershipVersion)===String(current.version))return {membership:{active:true,version:current.version,expires_at:current.expires_at}};return {status:409,error:'Участие изменилось. Получите новое согласие',code:'LOYALTY_CONSENT_REQUIRED'};}
   if(String(current?.version??'')!==String(payload.expectedVersion??''))return {status:409,error:'Статус клиента изменился. Обновите карточку',code:'LOYALTY_CONSENT_REQUIRED'};
   if(current?.active)return {membership:{active:true,version:current.version,expires_at:current.expires_at}};
   // Close expired balances before starting a new membership; old purchases cannot be replayed into it.
   if(current?.status==='active')await q(`INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
    SELECT customer_id,program_id,'MANUAL_ADJUSTMENT',(-sum(progress_delta))::integer,(-sum(reward_delta))::integer,
    'privacy-close:'||customer_id::text||':'||$2::text||':'||program_id::text,jsonb_build_object('reason','membership_terminated','membershipVersion',$2::text)
    FROM public.loyalty_ledger WHERE customer_id=$1::uuid GROUP BY customer_id,program_id HAVING sum(progress_delta)<>0 OR sum(reward_delta)<>0 ON CONFLICT(idempotency_key) DO NOTHING`,[customerId,String(current.version)]);
   const m=(await q(`INSERT INTO public.loyalty_memberships(customer_id,status,consented_at,expires_at,document_version)
    VALUES($1::uuid,'active',now(),now()+interval '24 months',$2)
    ON CONFLICT(customer_id) DO UPDATE SET status='active',version=public.loyalty_memberships.version+1,consented_at=now(),expires_at=now()+interval '24 months',document_version=$2,last_activity_key=NULL
    RETURNING version,expires_at`,[customerId,LEGAL_VERSION])).rows[0];
   await q(`INSERT INTO public.privacy_events(customer_id,event_type,document_version,evidence) VALUES($1::uuid,'loyalty_consented',$2,$3::jsonb)`,[customerId,LEGAL_VERSION,JSON.stringify({source:'pos_in_person',deviceId,staff:{id:String(staff.id),name:String(staff.name)},staffIdentity:'device_reported',requestId,membershipVersion:String(m.version),phoneChecked:true})]);
   return {membership:{active:true,version:m.version,expires_at:m.expires_at}};
  });
 };
}
