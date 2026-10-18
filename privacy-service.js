import { createHash, randomBytes } from 'node:crypto';
import { LEGAL_DOCUMENTS, LEGAL_VERSION } from './legal-documents.js';
const hash = value => createHash('sha256').update(String(value)).digest('hex');
export function validateLegalAcknowledgement(payload) {
  const legal=payload?.legal;
  if(legal?.version!==LEGAL_VERSION || legal?.acknowledged!==true)
    return {status:409,code:'LEGAL_VERSION_REQUIRED',error:'Ознакомьтесь с актуальными условиями оформления заказа'};
  if(typeof payload.loyaltyOptIn!=='boolean')return {status:400,error:'Укажите выбор участия в программе лояльности'};
  return null;
}
export function createPrivacyService({query,phoneVerification,normalizePhone}) {
  async function access(phone) {
    const normalized=normalizePhone(phone);if(!normalized)return {status:400,error:'Введите корректный телефон'};
    const verification=await phoneVerification.create(normalized);if(verification.error)return verification;
    const token=randomBytes(32).toString('base64url');
    const verificationToken=new URL(verification.telegramUrl).searchParams.get('start');
    await query(`INSERT INTO public.privacy_access_sessions(token_hash,verification_token_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')`,[hash(token),hash(verificationToken)]);
    return {token,telegramUrl:verification.telegramUrl,expiresAt:verification.expiresAt};
  }
  async function session(token) {
    if(typeof token!=='string'||token.length<40||token.length>100)return null;
    const {rows}=await query(`SELECT s.id,v.phone,v.telegram_user_id,v.status,v.verified_at FROM public.privacy_access_sessions s JOIN public.phone_verifications v ON v.token_hash=s.verification_token_hash WHERE s.token_hash=$1 AND s.expires_at>now()`,[hash(token)]);
    return rows?.[0]||null;
  }
  async function status(token) {
    const identity=await session(token);if(!identity)return {status:410,error:'Ссылка истекла. Подтвердите телефон заново'};
    if(!['VERIFIED','CONSUMED'].includes(identity.status))return {verified:false};
    const {rows}=await query(`SELECT c.id,public.loyalty_membership_active(c.id) AS active,m.expires_at,m.status AS membership_status FROM public.customers c LEFT JOIN public.loyalty_memberships m ON m.customer_id=c.id WHERE c.normalized_phone=$1`,[identity.phone]);
    return {verified:true,canWithdraw:Boolean(rows?.[0]?.id)&&rows?.[0]?.membership_status!=='withdrawn',active:rows?.[0]?.active===true,expiresAt:rows?.[0]?.expires_at||null};
  }
  async function withdraw(token) {
    const {rows}=await query('SELECT public.withdraw_loyalty_membership($1) AS result',[hash(token)]);
    return rows?.[0]?.result||{status:410,error:'Подтвердите телефон заново'};
  }
  async function retentionReport() {
    const {rows}=await query('SELECT public.privacy_retention_report() AS report');return rows?.[0]?.report||{};
  }
  async function maintain({apply=false}={}) {
    const {rows}=await query('SELECT public.run_privacy_retention($1) AS report',[apply]);return rows?.[0]?.report||{};
  }
  return {access,status,withdraw,retentionReport,maintain};
}
export function publicLegalConfiguration(){return {version:LEGAL_VERSION,documents:Object.entries(LEGAL_DOCUMENTS).map(([slug,d])=>({slug,title:d.title,version:LEGAL_VERSION,sha256:hash(d.text),url:'/legal/'+slug}))};}
