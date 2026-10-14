import { createHash, randomBytes, randomUUID } from "node:crypto";

export const CHECKOUT_TTL_MS = 5 * 60 * 1000;

export function createCheckoutService({ query, normalizePhone, validateOrderContact, phoneVerification, availability = null, deliveryFee = 0, deliveryTariffs = null }) {
  const hash = value => createHash("sha256").update(String(value)).digest("hex");

  async function prepareOrder(payload) {
    const orderType=String(payload?.orderType||"Самовывоз").trim(),customerName=String(payload?.customerName||"").trim(),rawPhone=String(payload?.phone||"").trim(),phone=normalizePhone(rawPhone),address=String(payload?.address||"").trim(),comment=String(payload?.comment||"").trim(),requestedItems=Array.isArray(payload?.items)?payload.items:[];
    if(!["Самовывоз","Доставка"].includes(orderType))return {error:"Некорректный способ получения",status:400};
    if(!customerName||!phone||!requestedItems.length)return {error:"Заполните данные заказа и добавьте товары",status:400};
    if(orderType==="Доставка"&&!address)return {error:"Укажите адрес доставки",status:400};
    const contactError=validateOrderContact({customerName,phone:rawPhone,address,comment,items:requestedItems});if(contactError)return {error:contactError,status:400};
    const ids=requestedItems.map(x=>String(x.productId||"").trim()).filter(Boolean),uniqueIds=[...new Set(ids)];
    if(!uniqueIds.length||uniqueIds.length!==ids.length)return {error:"Некорректные товары в заказе",status:400};
    const {rows:products}=await query(`SELECT id,external_id,name,price FROM public.products WHERE id=ANY($1::uuid[]) AND is_active=TRUE AND available_online=TRUE`,[uniqueIds]);
    const productMap=new Map((products||[]).map(p=>[p.id,p]));
    if(productMap.size!==uniqueIds.length)return {error:"Один из товаров больше недоступен для заказа",status:400};
    if(availability){const availabilityError=await availability.validateOrder(products,requestedItems);if(availabilityError)return {error:availabilityError,status:409}}
    const items=[];let subtotal=0;
    for(const raw of requestedItems){const product=productMap.get(String(raw.productId)),quantity=Number(raw.quantity);if(!Number.isFinite(quantity)||quantity<=0||quantity>99)return {error:"Некорректное количество товара",status:400};subtotal+=Number(product.price||0)*quantity;items.push({product_id:product.id,external_product_id:product.external_id,product_name:product.name,price:Number(product.price||0),quantity,comment:raw.comment?String(raw.comment).trim().slice(0,500):null});}
    let deliveryTariff=null, tariffCents=0, legacyTariffs=!deliveryTariffs;
    if(orderType==="Доставка"&&deliveryTariffs){const resolved=await deliveryTariffs.resolve(payload);if(resolved.error)return resolved;legacyTariffs=resolved.legacy===true;deliveryTariff=resolved.tariff||null;tariffCents=resolved.cents||0;}
    const fee=!legacyTariffs?(orderType==="Доставка"?tariffCents/100:0):orderType==="Доставка"?(Number.isFinite(Number(deliveryFee))?Number(deliveryFee):0):0;
    return {order:{orderType,customerName,phone,address:orderType==="Доставка"?address:"",comment,items,subtotal,fee,deliveryTariff,total:(Math.round(subtotal*100)+Math.round(fee*100))/100}};
  }

  async function create(payload) {
    const prepared=await prepareOrder(payload);if(prepared.error)return prepared;
    const checkoutToken=randomBytes(32).toString("base64url"),expiresAt=new Date(Date.now()+CHECKOUT_TTL_MS).toISOString(),verification=await phoneVerification.create(prepared.order.phone);
    if(verification.error)return verification;
    await query(`INSERT INTO public.checkout_sessions (token_hash,phone,status,order_payload,verification_token_hash,expires_at) VALUES ($1,$2,'PENDING',$3::jsonb,$4,$5::timestamptz)`,[hash(checkoutToken),prepared.order.phone,JSON.stringify(prepared.order),hash(verification.token),expiresAt]);
    return {checkoutToken,status:"PENDING",expiresAt,telegramUrl:verification.telegramUrl,deliveryTariff:prepared.order.deliveryTariff,deliveryFee:prepared.order.fee,total:prepared.order.total};
  }

  async function get(checkoutToken) {
    const {rows}=await query(`SELECT id,status,expires_at,tracking_token,order_id FROM public.checkout_sessions WHERE token_hash=$1 LIMIT 1`,[hash(checkoutToken)]);
    const data=rows?.[0];if(!data)return null;
    if((data.status==="PENDING"||data.status==="VERIFIED")&&new Date(data.expires_at).getTime()<=Date.now()){await query(`UPDATE public.checkout_sessions SET status='EXPIRED',updated_at=now() WHERE id=$1::uuid`,[data.id]);data.status="EXPIRED";}
    return data;
  }

  async function finalizeByVerificationToken(verificationToken) {
    const externalId=`WEB-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`,trackingToken=randomUUID().replace(/-/g,"");
    try {
      const {rows}=await query(`SELECT public.finalize_verified_checkout($1,$2,$3) AS result`,[hash(verificationToken),externalId,trackingToken]);
      return rows?.[0]?.result||null;
    } catch(error) {
      const message=String(error.message||"");
      if(message.includes("CHECKOUT_EXPIRED"))return {ok:false,reason:"EXPIRED"};
      if(message.includes("VERIFICATION_NOT_READY"))return {ok:false,reason:"NOT_VERIFIED"};
      if(message.includes("OUT_OF_STOCK"))return {ok:false,reason:"OUT_OF_STOCK"};
      if(message.includes("AVAILABILITY_UNAVAILABLE"))return {ok:false,reason:"AVAILABILITY_UNAVAILABLE"};
      throw error;
    }
  }
  return {create,get,finalizeByVerificationToken};
}
