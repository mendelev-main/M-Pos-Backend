const AVAILABILITY_VERSION=1;

function normalizeQuantity(value){
  if(value===null)return null;
  const quantity=Number(value);
  return Number.isFinite(quantity)&&quantity>=0?quantity:0;
}

export function createAvailabilityService({supabase}){
  async function list(){
    const {data,error}=await supabase.rpc("get_web_availability");
    if(error)throw error;
    return (data||[]).map(row=>({externalId:String(row.external_product_id||""),quantity:normalizeQuantity(row.quantity)})).filter(row=>row.externalId);
  }

  async function attachToProducts(products){
    const availability=await list(),byExternalId=new Map(availability.map(row=>[row.externalId,row.quantity]));
    return (products||[]).map(product=>{
      const known=byExternalId.has(String(product.external_id||""));
      return {...product,availability_known:known,available_quantity:known?byExternalId.get(String(product.external_id)):0};
    });
  }

  async function validateOrder(products,requestedItems){
    const availability=await list(),byExternalId=new Map(availability.map(row=>[row.externalId,row.quantity]));
    const productsById=new Map((products||[]).map(product=>[String(product.id),product]));
    for(const raw of requestedItems||[]){
      const product=productsById.get(String(raw.productId||""));
      if(!product)return "Один из товаров больше недоступен для заказа";
      const externalId=String(product.external_id||"");
      if(!byExternalId.has(externalId))return `Остаток товара «${product.name}» пока не подтверждён`;
      const available=byExternalId.get(externalId),requested=Number(raw.quantity);
      if(available!==null&&requested>available)return available>0?`Товара «${product.name}» осталось: ${Math.floor(available)}`:`Товар «${product.name}» закончился`;
    }
    return null;
  }

  async function store(deviceKey,body){
    const key=String(deviceKey||"").trim(),revision=Number(body?.revision),sampledAt=new Date(body?.sampledAt||""),rawItems=Array.isArray(body?.items)?body.items:null;
    if(!key)return {error:"Missing device key",status:401};
    if(Number(body?.version)!==AVAILABILITY_VERSION)return {error:"Unsupported availability version",status:409};
    if(!Number.isSafeInteger(revision)||revision<=0||Number.isNaN(sampledAt.getTime())||!rawItems||rawItems.length>10000)return {error:"Invalid availability snapshot",status:400};
    const seen=new Set(),items=[];
    for(const raw of rawItems){
      const externalId=String(raw?.externalId||"").trim(),quantity=raw?.quantity===null?null:Number(raw?.quantity);
      if(!externalId||seen.has(externalId)||(quantity!==null&&(!Number.isFinite(quantity)||quantity<0)))return {error:"Invalid availability item",status:400};
      seen.add(externalId);items.push({externalId,quantity});
    }
    const settledWebOrderIds=[...new Set((Array.isArray(body?.settledWebOrderIds)?body.settledWebOrderIds:[]).map(String).map(value=>value.trim()).filter(Boolean))].slice(0,100);
    const {data:device,error:deviceError}=await supabase.from("devices").select("id").eq("device_key",key).eq("is_active",true).maybeSingle();
    if(deviceError)throw deviceError;
    if(!device)return {error:"Invalid device key",status:401};
    const {data:applied,error}=await supabase.rpc("store_availability_snapshot",{p_device_id:device.id,p_revision:revision,p_sampled_at:sampledAt.toISOString(),p_items:items,p_settled_order_ids:settledWebOrderIds});
    if(error)throw error;
    return {ok:true,applied:applied===true,ignoredAsStale:applied!==true,revision};
  }

  return {list,attachToProducts,validateOrder,store};
}
