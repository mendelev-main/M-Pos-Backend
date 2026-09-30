import express from "express";
import { mountOwnerRoutes, ownerBotAuthorized } from "./owner-auth.js";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { createPhoneVerificationService } from "./phone-verification.js";
import { createCheckoutService } from "./checkout-service.js";

import "./public/order-validation.js";
const { validate: validateOrderContact, normalizePhone } = globalThis.OrderValidation;

const app = express();
app.use(cors());
app.use("/api/owner/report", express.json({ limit: "14mb" }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const port = process.env.PORT || 3000;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const deliveryFee = Number(process.env.DELIVERY_FEE || 0);

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
mountOwnerRoutes(app,{db:supabase});
const phoneVerification = createPhoneVerificationService(supabase, normalizePhone);
const checkout = createCheckoutService({ supabase, normalizePhone, validateOrderContact, phoneVerification, deliveryFee });

app.get("/health", (_req, res) => res.json({ ok: true, service: "prilavok-backend" }));

app.post("/api/checkout", async (req, res) => {
  try {
    const returnBaseUrl = `${req.protocol}://${req.get("host")}`;
    const result = await checkout.create(req.body, returnBaseUrl);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    return res.status(201).json(result);
  } catch (error) {
    console.error("POST /api/checkout:", error);
    return res.status(500).json({ error: "Не удалось начать оформление заказа" });
  }
});

app.get("/api/checkout/:token", async (req, res) => {
  try {
    const session = await checkout.get(String(req.params.token || ""));
    if (!session) return res.status(404).json({ error: "Оформление не найдено" });
    return res.json({ status: session.status, expiresAt: session.expires_at, trackingToken: session.tracking_token || null, orderId: session.order_id || null });
  } catch (error) {
    console.error("GET /api/checkout/:token:", error);
    return res.status(500).json({ error: "Не удалось проверить оформление" });
  }
});

app.post("/api/phone-verification", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").trim();
    const returnUrl = req.body?.returnUrl ? String(req.body.returnUrl).trim() : null;
    const result = await phoneVerification.create(phone, returnUrl);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    return res.status(201).json(result);
  } catch (error) {
    console.error("POST /api/phone-verification:", error);
    return res.status(500).json({ error: "Не удалось начать подтверждение номера" });
  }
});

app.get("/api/phone-verification/:token", async (req, res) => {
  try {
    const verification = await phoneVerification.get(req.params.token);
    if (!verification) return res.status(404).json({ error: "Подтверждение не найдено" });
    return res.json({ status: verification.status, phone: verification.phone, expiresAt: verification.expires_at, verifiedAt: verification.verified_at });
  } catch (error) {
    console.error("GET /api/phone-verification/:token:", error);
    return res.status(500).json({ error: "Не удалось проверить статус" });
  }
});

app.post("/api/phone-verification/:token/confirm", async (req, res) => {
  if (process.env.OWNER_AUTH_ENABLED === "true" && !ownerBotAuthorized(req.header("x-owner-bot-secret"), process.env.OWNER_BOT_SHARED_SECRET)) {
    return res.status(403).json({ ok: false, error: "Подтверждение доступно только через бота" });
  }
  try {
    const phone = String(req.body?.phone || "").trim();
    const telegramUserId = req.body?.telegramUserId;
    const result = await phoneVerification.confirm(req.params.token, phone, telegramUserId);
    if (!result.ok) return res.status(409).json(result);

    const finalized = await checkout.finalizeByVerificationToken(req.params.token);
    if (finalized && !finalized.ok) {
      return res.status(409).json({ ok: false, error: "Не удалось завершить оформление заказа", reason: finalized.reason });
    }
    return res.json({ ...result, orderCreated: Boolean(finalized?.ok), trackingToken: finalized?.trackingToken || null });
  } catch (error) {
    console.error("POST /api/phone-verification/:token/confirm:", error);
    return res.status(500).json({ ok: false, error: "Не удалось подтвердить номер" });
  }
});

app.post("/api/media/upload", async (req, res) => {
  try {
    const deviceKey = String(req.header("x-device-key") || req.body?.deviceKey || "").trim();
    const productId = String(req.body?.productId || "").trim();
    const dataUrl = String(req.body?.dataUrl || "").trim();
    if (!deviceKey || !productId || !dataUrl) return res.status(400).json({ error: "Missing upload data" });
    const { data: device, error: deviceError } = await supabase.from("devices").select("id").eq("device_key", deviceKey).eq("is_active", true).maybeSingle();
    if (deviceError) throw deviceError;
    if (!device) return res.status(401).json({ error: "Invalid device key" });
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i);
    if (!match) return res.status(400).json({ error: "Only JPEG, PNG or WebP images are supported" });
    const mime = match[1].toLowerCase();
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 1500000) return res.status(400).json({ error: "Image is too large" });
    const bucket = "product-images";
    const createBucket = await fetch(`${supabaseUrl}/storage/v1/bucket`, { method: "POST", headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, "Content-Type": "application/json" }, body: JSON.stringify({ id: bucket, name: bucket, public: true }) });
    if (!createBucket.ok) {
      const txt = await createBucket.text(); let duplicate = createBucket.status === 409;
      try { const body = JSON.parse(txt); duplicate = duplicate || body?.code === "BucketAlreadyExists" || Number(body?.statusCode) === 409; } catch (_) {}
      if (!duplicate) throw new Error(`Storage bucket: ${createBucket.status} ${txt}`);
    }
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const path = `products/${encodeURIComponent(productId)}.${ext}`;
    const upload = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey, "Content-Type": mime, "x-upsert": "true" }, body: buffer });
    if (!upload.ok) throw new Error(`Storage upload: ${upload.status} ${await upload.text()}`);
    return res.json({ ok: true, url: `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}` });
  } catch (error) {
    console.error("POST /api/media/upload:", error);
    return res.status(500).json({ error: "Failed to upload image" });
  }
});

app.post("/api/menu/sync", async (req, res) => {
  try {
    const deviceKey = String(req.header("x-device-key") || req.body?.deviceKey || "").trim();
    const deviceName = String(req.body?.deviceName || "Прилавок iPad").trim();
    const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
    const products = Array.isArray(req.body?.products) ? req.body.products : [];
    if (!deviceKey) return res.status(401).json({ error: "Missing device key" });
    const { data: device, error: deviceError } = await supabase.from("devices").upsert({ device_key: deviceKey, name: deviceName || "Прилавок iPad", is_active: true, last_sync_at: new Date().toISOString() }, { onConflict: "device_key" }).select("id").single();
    if (deviceError) throw deviceError;
    const categoryRows = categories.map((c, index) => ({ external_id: String(c.externalId || `category:${String(c.name || "").trim()}`), name: String(c.name || "").trim(), color: c.color ? String(c.color) : null, sort_order: Number.isFinite(Number(c.sortOrder)) ? Number(c.sortOrder) : index, is_active: c.isActive !== false })).filter(c => c.name && c.external_id);
    if (categoryRows.length) { const { error } = await supabase.from("categories").upsert(categoryRows, { onConflict: "external_id" }); if (error) throw error; }
    const { data: existingCategories, error: existingCategoriesError } = await supabase.from("categories").select("id,external_id");
    if (existingCategoriesError) throw existingCategoriesError;
    const externalIds = categoryRows.map(c => c.external_id); const categoryExternalIdSet = new Set(externalIds);
    const staleCategoryIds = (existingCategories || []).filter(c => c.external_id && !categoryExternalIdSet.has(c.external_id)).map(c => c.id);
    if (staleCategoryIds.length) { const { error } = await supabase.from("categories").update({ is_active: false }).in("id", staleCategoryIds); if (error) throw error; }
    const categoryMap = new Map();
    if (externalIds.length) { const { data: dbCategories, error } = await supabase.from("categories").select("id,external_id").in("external_id", externalIds); if (error) throw error; for (const c of dbCategories || []) categoryMap.set(c.external_id, c.id); }
    const productRows = products.map((p, index) => { const categoryName = String(p.category || "Без категории").trim() || "Без категории"; return { external_id: String(p.externalId || ""), name: String(p.name || "").trim(), description: p.description ? String(p.description) : null, price: Number(p.price || 0), category_id: categoryMap.get(`category:${categoryName}`) || null, sort_order: Number.isFinite(Number(p.sortOrder)) ? Number(p.sortOrder) : index, is_active: p.isActive !== false, available_online: p.availableOnline !== false, image_url: p.imageUrl ? String(p.imageUrl) : null }; }).filter(p => p.external_id && p.name);
    if (productRows.length) { const { error } = await supabase.from("products").upsert(productRows, { onConflict: "external_id" }); if (error) throw error; }
    const { data: existingProducts, error: existingProductsError } = await supabase.from("products").select("id,external_id");
    if (existingProductsError) throw existingProductsError;
    const productExternalIdSet = new Set(productRows.map(p => p.external_id));
    const staleProductIds = (existingProducts || []).filter(p => p.external_id && !productExternalIdSet.has(p.external_id)).map(p => p.id);
    if (staleProductIds.length) { const { error } = await supabase.from("products").update({ is_active: false, available_online: false }).in("id", staleProductIds); if (error) throw error; }
    return res.json({ ok: true, deviceId: device?.id || null, categories: categoryRows.length, products: productRows.length, syncedAt: new Date().toISOString() });
  } catch (error) { console.error("POST /api/menu/sync:", error); return res.status(500).json({ error: "Failed to sync menu" }); }
});


const OPERATIONAL_SCHEMA_VERSION = 1;
const OPERATIONAL_FRESH_MS = Number(process.env.OPERATIONAL_FRESH_MS || 45000);
async function operationalDevice(req) {
  const deviceKey = String(req.header("x-device-key") || "").trim();
  if (!deviceKey) return { error: "Missing device key", status: 401 };
  const { data: device, error } = await supabase.from("devices").select("id,device_key,name,is_active").eq("device_key", deviceKey).eq("is_active", true).maybeSingle();
  if (error) throw error;
  if (!device) return { error: "Invalid device key", status: 401 };
  return { device };
}
function validateOperationalVersion(body) {
  return Number(body?.schemaVersion) === OPERATIONAL_SCHEMA_VERSION;
}
app.post("/api/operational/heartbeat", async (req, res) => {
  try {
    const auth = await operationalDevice(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    if (!validateOperationalVersion(req.body)) return res.status(409).json({ error: "Unsupported operational schema version", expected: OPERATIONAL_SCHEMA_VERSION });
    const receivedAt = new Date().toISOString();
    const sampledAt = new Date(req.body?.sampledAt || receivedAt);
    if (Number.isNaN(sampledAt.getTime())) return res.status(400).json({ error: "Invalid sampledAt" });
    const row = { device_id: auth.device.id, schema_version: OPERATIONAL_SCHEMA_VERSION, engine_version: Number(req.body?.engineVersion) || null, heartbeat_at: receivedAt, updated_at: receivedAt };
    const { error } = await supabase.from("operational_states").upsert(row, { onConflict: "device_id" });
    if (error) throw error;
    return res.json({ ok: true, receivedAt });
  } catch (error) {
    console.error("POST /api/operational/heartbeat:", error);
    return res.status(500).json({ error: "Failed to store operational heartbeat" });
  }
});
app.post("/api/operational/snapshot", async (req, res) => {
  try {
    const auth = await operationalDevice(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    if (!validateOperationalVersion(req.body)) return res.status(409).json({ error: "Unsupported operational schema version", expected: OPERATIONAL_SCHEMA_VERSION });
    if (!req.body?.demand || typeof req.body.demand !== "object" || typeof req.body.demand.overload !== "boolean") return res.status(400).json({ error: "Missing demand snapshot" });
    const receivedAt = new Date().toISOString(),sampledAt = new Date(req.body?.sampledAt || receivedAt),revision=Number(req.body?.revision);
    if (Number.isNaN(sampledAt.getTime())) return res.status(400).json({ error: "Invalid sampledAt" });
    if (!Number.isSafeInteger(revision) || revision <= 0) return res.status(400).json({ error: "Invalid snapshot revision" });
    const { data: applied, error } = await supabase.rpc("store_operational_snapshot",{p_device_id:auth.device.id,p_schema_version:OPERATIONAL_SCHEMA_VERSION,p_engine_version:Number(req.body?.engineVersion)||null,p_revision:revision,p_sampled_at:sampledAt.toISOString(),p_received_at:receivedAt,p_snapshot:req.body});
    if (error) throw error;
    return res.json({ ok: true, applied: applied===true, ignoredAsStale: applied!==true, revision, receivedAt });
  } catch (error) {
    console.error("POST /api/operational/snapshot:", error);
    return res.status(500).json({ error: "Failed to store operational snapshot" });
  }
});
app.get("/api/operational/state", async (req, res) => {
  try {
    const auth = await operationalDevice(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    const { data, error } = await supabase.from("operational_states").select("schema_version,engine_version,heartbeat_at,snapshot_sampled_at,snapshot_received_at,snapshot_revision,snapshot,updated_at").eq("device_id", auth.device.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.json({ available: false, fresh: false, reason: "missing", freshnessMs: null, state: null });
    const now=Date.now(),heartbeatAt=data.heartbeat_at?new Date(data.heartbeat_at).getTime():0,sampledAt=data.snapshot_sampled_at?new Date(data.snapshot_sampled_at).getTime():0,receivedAt=data.snapshot_received_at?new Date(data.snapshot_received_at).getTime():0;
    const freshnessMs=heartbeatAt?Math.max(0,now-heartbeatAt):null,snapshotAgeMs=sampledAt?now-sampledAt:null,snapshotReceivedAgeMs=receivedAt?Math.max(0,now-receivedAt):null;
    const compatible=Number(data.schema_version)===OPERATIONAL_SCHEMA_VERSION&&Number(data.engine_version)===ETA_ENGINE_VERSION&&Number(data.snapshot?.schemaVersion)===OPERATIONAL_SCHEMA_VERSION&&Number(data.snapshot?.engineVersion)===ETA_ENGINE_VERSION;
    const clockValid=snapshotAgeMs!==null&&snapshotAgeMs>=-30000;
    const fresh=compatible&&!!data.snapshot&&freshnessMs!==null&&freshnessMs<=OPERATIONAL_FRESH_MS&&clockValid&&snapshotAgeMs<=OPERATIONAL_FRESH_MS&&snapshotReceivedAgeMs!==null&&snapshotReceivedAgeMs<=OPERATIONAL_FRESH_MS;
    const reason=!compatible?"incompatible":!data.snapshot?"missing_snapshot":!clockValid?"invalid_snapshot_clock":!fresh?"stale":null;
    return res.json({available:fresh,fresh,compatible,reason,freshnessMs,snapshotAgeMs,snapshotReceivedAgeMs,maxFreshnessMs:OPERATIONAL_FRESH_MS,state:fresh?data.snapshot:null});
  } catch (error) {
    console.error("GET /api/operational/state:", error);
    return res.status(500).json({ error: "Failed to read operational state" });
  }
});


const ETA_ENGINE_VERSION = 1;
const ETA_STATIONS = ["bar", "kitchen"];
const ETA_VALID_FOR_SECONDS = 45;
const ETA_DELAYING_WINDOW_MINUTES = 3;
function etaBatchFactor(qty) {
  const q = Math.max(0, Number(qty) || 0);
  return q <= 1 ? q : 1 + (q - 1) * 0.72;
}
function etaDifficultyMultiplier(value) {
  const d = Math.max(1, Math.min(5, Number(value) || 1));
  return [0, 0.80, 0.95, 1.10, 1.30, 1.55][d];
}
function etaLoadLevel(waitMinutes) {
  const n = Math.max(0, Number(waitMinutes) || 0);
  return n >= 30 ? "HIGH" : n >= 15 ? "ELEVATED" : "NORMAL";
}
function etaFindSlot(startAt, durationMinutes, reservations) {
  let start = Math.max(0, Number(startAt) || 0), duration = Math.max(0, Number(durationMinutes) || 0) * 60000;
  for (const r of (reservations || []).slice().sort((a,b)=>a.startAt-b.startAt)) {
    if (start + duration <= r.startAt) break;
    if (start < r.endAt && start + duration > r.startAt) start = r.endAt;
  }
  return start;
}
function etaRange(minutes) {
  const n = Math.max(0, Number(minutes) || 0);
  const buckets = [[0,10,15],[15,15,20],[20,20,30],[30,30,40],[40,40,50],[50,50,60]];
  for (const [,min,max] of buckets) if (n <= max) return { minMinutes:min, maxMinutes:max };
  return { minMinutes:60, maxMinutes:null };
}
function etaUnavailable(reason="POS_STATE_UNAVAILABLE") {
  return { available:false, reason, message:"Не смогли рассчитать примерное время приготовления" };
}
async function latestFreshOperationalState() {
  const { data: devices, error: deviceError } = await supabase.from("devices").select("id").eq("is_active", true);
  if (deviceError) throw deviceError;
  const ids = (devices || []).map(x=>x.id);
  if (!ids.length) return { available:false, reason:"missing" };
  // v1 has one location/POS identity. Never guess between multiple active devices.
  if (ids.length !== 1) return { available:false, reason:"ambiguous_location" };
  const { data: rows, error } = await supabase.from("operational_states").select("device_id,schema_version,engine_version,heartbeat_at,snapshot_sampled_at,snapshot_received_at,snapshot").in("device_id", ids).order("heartbeat_at",{ascending:false}).limit(10);
  if (error) throw error;
  const now = Date.now();
  for (const row of (rows || [])) {
    const heartbeatAt = row.heartbeat_at ? new Date(row.heartbeat_at).getTime() : 0;
    const sampledAt = row.snapshot_sampled_at ? new Date(row.snapshot_sampled_at).getTime() : 0;
    const receivedAt = row.snapshot_received_at ? new Date(row.snapshot_received_at).getTime() : 0;
    const queueContract=ETA_STATIONS.every(st=>Number.isFinite(Number(row.snapshot?.production?.currentQueueMinutes?.[st])));
    const compatible = Number(row.schema_version) === OPERATIONAL_SCHEMA_VERSION && Number(row.engine_version) === ETA_ENGINE_VERSION && Number(row.snapshot?.schemaVersion) === OPERATIONAL_SCHEMA_VERSION && Number(row.snapshot?.engineVersion) === ETA_ENGINE_VERSION && Number(row.snapshot?.prepCatalog?.version) === 1 && queueContract;
    const heartbeatAge = heartbeatAt ? Math.max(0, now-heartbeatAt) : Infinity;
    const snapshotAge = sampledAt ? now-sampledAt : Infinity;
    const receivedAge = receivedAt ? Math.max(0, now-receivedAt) : Infinity;
    const clockValid = Number.isFinite(snapshotAge) && snapshotAge >= -30000;
    if (compatible && row.snapshot && clockValid && snapshotAge <= OPERATIONAL_FRESH_MS && receivedAge <= OPERATIONAL_FRESH_MS && heartbeatAge <= OPERATIONAL_FRESH_MS) return { available:true, state:row.snapshot };
  }
  return { available:false, reason:(rows || []).length ? "stale_or_incompatible" : "missing" };
}
function etaPrepWork(lines, prepByExternalId) {
  const result = {bar:{durationMinutes:0,workPoints:0},kitchen:{durationMinutes:0,workPoints:0}};
  const add = (externalId, qty) => {
    const prep = prepByExternalId.get(String(externalId));
    if (!prep) throw new Error("PREP_MISSING");
    const station = prep.station;
    if (station === "none") return;
    if (!ETA_STATIONS.includes(station)) throw new Error("PREP_INCOMPATIBLE");
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0 || q > 99) throw new Error("INVALID_QTY");
    result[station].durationMinutes += Math.max(1,Number(prep.basePrepMinutes)||1) * etaBatchFactor(q);
    result[station].workPoints += q * etaDifficultyMultiplier(prep.difficulty);
  };
  for (const line of lines) {
    add(line.externalId, line.qty);
    for (const mod of (line.modifiers || [])) add(mod.externalId, Number(line.qty) * Number(mod.qty));
  }
  for (const row of Object.values(result)) {
    row.durationMinutes=Math.round(row.durationMinutes*100)/100;
    row.workPoints=Math.round(row.workPoints*100)/100;
  }
  return result;
}
function etaFromSnapshot(snapshot, work, now=Date.now(), requestedReadyAt=null) {
  const stations={}, cartStations=ETA_STATIONS.filter(st=>work[st].durationMinutes>0);
  for (const station of ETA_STATIONS) {
    const currentWait=Math.max(0,Number(snapshot?.production?.currentQueueMinutes?.[station])||0);
    const reservations=(snapshot?.scheduled||[]).map(o=>{
      const duration=Math.max(0,Number(o?.work?.[station]?.durationMinutes)||0),ready=Number(o?.requestedReadyAt)||0;
      return duration&&ready ? {startAt:ready-duration*60000,endAt:ready} : null;
    }).filter(Boolean);
    const duration=work[station].durationMinutes;
    const requested=Number(requestedReadyAt)||0;
    const desiredStart=requested>now&&duration ? Math.max(now,requested-duration*60000) : now;
    const queueReadyAt=now+currentWait*60000;
    const queueStart=Math.max(desiredStart,queueReadyAt);
    const start=duration ? etaFindSlot(queueStart,duration,reservations) : now;
    const wait=duration ? Math.max(0,(start-now)/60000) : 0;
    const scheduleWait=duration ? Math.max(0,(desiredStart-now)/60000) : 0;
    const loadWait=duration ? Math.max(0,(start-Math.max(now,desiredStart))/60000) : 0;
    const completion=duration ? wait+duration : 0;
    stations[station]={waitMinutes:Math.round(wait*100)/100,scheduleWaitMinutes:Math.round(scheduleWait*100)/100,loadWaitMinutes:Math.round(loadWait*100)/100,durationMinutes:duration,completionMinutes:Math.round(completion*100)/100,loadState:etaLoadLevel(loadWait)};
  }
  const criticalStation=cartStations.length?cartStations.slice().sort((a,b)=>stations[b].completionMinutes-stations[a].completionMinutes)[0]:null;
  const criticalMinutes=criticalStation?stations[criticalStation].completionMinutes:0;
  const delayingStations=cartStations.filter(st=>stations[st].loadWaitMinutes>0&&stations[st].completionMinutes>=criticalMinutes-ETA_DELAYING_WINDOW_MINUTES);
  const loadedStations=delayingStations.filter(st=>stations[st].loadState!=="NORMAL").map(st=>({station:st,loadState:stations[st].loadState}));
  const customerLoadState=loadedStations.some(x=>x.loadState==="HIGH")?"HIGH":loadedStations.length?"ELEVATED":"NORMAL";
  const safetyMinutes=criticalMinutes>0?Math.max(2,criticalMinutes*0.10):0;
  const ranged=etaRange(criticalMinutes+safetyMinutes);
  return {criticalStation,delayingStations,loadedStations,customerLoadState,waitIncreasedByLoad:delayingStations.length>0,estimatedMinutes:Math.round((criticalMinutes+safetyMinutes)*100)/100,...ranged};
}
app.post("/api/eta/estimate", async (_req, res) => {
  try {
    const stateResult=await latestFreshOperationalState();
    if (!stateResult.available) return res.json({available:false,demandState:"UNAVAILABLE"});
    const overload=stateResult.state?.demand?.overload===true;
    return res.json({available:true,demandState:overload?"OVERLOAD":"NORMAL",overload,calculatedAt:new Date().toISOString(),validForSeconds:ETA_VALID_FOR_SECONDS});
  } catch(error) {
    console.error("POST /api/eta/estimate:",error);
    return res.json({available:false,demandState:"UNAVAILABLE"});
  }
});

app.get("/api/menu", async (_req, res) => {
  try {
    const { data: categories, error: categoriesError } = await supabase.from("categories").select("id,name,color,sort_order,is_active,external_id").eq("is_active", true).order("sort_order", { ascending: true }).order("name", { ascending: true });
    if (categoriesError) throw categoriesError;
    const { data: products, error: productsError } = await supabase.from("products").select("id,name,description,price,category_id,image_url,sort_order,is_active,available_online,external_id").eq("is_active", true).eq("available_online", true).order("sort_order", { ascending: true }).order("name", { ascending: true });
    if (productsError) throw productsError;
    const onlineCategoryIds = new Set((products ?? []).map(p => p.category_id).filter(Boolean));
    res.json({ categories: (categories ?? []).filter(c => onlineCategoryIds.has(c.id)), products: products ?? [] });
  } catch (error) { console.error("GET /api/menu:", error); res.status(500).json({ error: "Failed to load menu" }); }
});

const eventClients = new Set(); let eventPollBusy = false;
async function pushNewOrders(){
  if(eventPollBusy || !eventClients.size) return; eventPollBusy = true;
  try { const { data, error } = await supabase.from("orders").select("id,external_id,status,order_type,customer_name,phone,address,comment,total,delivery_fee,created_at,updated_at,order_items(id,product_id,external_product_id,product_name,price,quantity,comment)").eq("status", "new").order("created_at", { ascending: false }).limit(20); if(error) throw error; const payload = JSON.stringify({type:"orders",orders:data||[]}); for(const client of eventClients){ try { client.res.write(`data: ${payload}\n\n`); } catch(e) {} } }
  catch(error){ console.error("order event poll:", error); } finally { eventPollBusy = false; }
}
setInterval(pushNewOrders, 2000);

app.get("/api/orders/events", async (req, res) => {
  try {
    const deviceKey = String(req.header("x-device-key") || req.query.deviceKey || "").trim();
    if(!deviceKey) return res.status(401).json({error:"Missing device key"});
    const { data: device, error } = await supabase.from("devices").select("id").eq("device_key", deviceKey).eq("is_active", true).maybeSingle();
    if(error) throw error;
    if(!device) return res.status(401).json({error:"Invalid device key"});
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8"); res.setHeader("Cache-Control", "no-cache, no-transform"); res.setHeader("Connection", "keep-alive"); res.setHeader("X-Accel-Buffering", "no"); res.flushHeaders?.();
    const client={res,deviceKey,deviceId:device.id}; eventClients.add(client); res.write(`event: ready\ndata: ${JSON.stringify({ok:true})}\n\n`); const heartbeat=setInterval(()=>{ try{res.write(`: ping\n\n`);}catch(e){} }, 15000); req.on("close",()=>{clearInterval(heartbeat);eventClients.delete(client);}); pushNewOrders();
  } catch(error) { console.error("GET /api/orders/events:", error); if(!res.headersSent) return res.status(500).json({error:"Failed to open order stream"}); res.end(); }
});

app.get("/api/config", (_req, res) => res.json({ deliveryFee: Number.isFinite(deliveryFee) ? deliveryFee : 0 }));

app.post("/api/orders", async (req, res) => {
  try {
    const orderType = String(req.body?.orderType || "Самовывоз").trim();
    const customerName = String(req.body?.customerName || "").trim();
    const rawPhone = String(req.body?.phone || "").trim();
    const phone = normalizePhone(rawPhone);
    const verificationToken = String(req.body?.verificationToken || "").trim();
    const address = String(req.body?.address || "").trim();
    const comment = String(req.body?.comment || "").trim();
    const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!customerName || !phone || !requestedItems.length) return res.status(400).json({ error: "Заполните данные заказа и добавьте товары" });
    if (orderType === "Доставка" && !address) return res.status(400).json({ error: "Укажите адрес доставки" });
    if (!verificationToken) return res.status(403).json({ error: "Подтвердите номер телефона через Telegram" });

    const verification = await phoneVerification.get(verificationToken);
    if (!verification || verification.status !== "VERIFIED" || verification.phone !== phone) return res.status(403).json({ error: "Номер телефона не подтверждён" });

    const contactError = validateOrderContact({ phone: rawPhone, comment, items: requestedItems });
    if (contactError) return res.status(400).json({ error: contactError });
    const ids = requestedItems.map(x => String(x.productId || "").trim()).filter(Boolean); const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length || uniqueIds.length !== ids.length) return res.status(400).json({ error: "Некорректные товары в заказе" });
    const { data: products, error: productsError } = await supabase.from("products").select("id,external_id,name,price").in("id", uniqueIds).eq("is_active", true).eq("available_online", true);
    if (productsError) throw productsError;
    const productMap = new Map((products || []).map(p => [p.id, p]));
    if (productMap.size !== uniqueIds.length) return res.status(400).json({ error: "Один из товаров больше недоступен для заказа" });
    const items = []; let subtotal = 0;
    for (const raw of requestedItems) { const product = productMap.get(String(raw.productId)); const quantity = Number(raw.quantity); if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 99) return res.status(400).json({ error: "Некорректное количество товара" }); subtotal += Number(product.price || 0) * quantity; items.push({ product_id: product.id, external_product_id: product.external_id, product_name: product.name, price: Number(product.price || 0), quantity, comment: raw.comment ? String(raw.comment).trim().slice(0, 500) : null }); }

    const consumed = await phoneVerification.consume(verificationToken, phone);
    if (!consumed) return res.status(409).json({ error: "Подтверждение уже использовано. Подтвердите номер ещё раз" });

    const fee = orderType === "Доставка" ? (Number.isFinite(deliveryFee) ? deliveryFee : 0) : 0; const total = subtotal + fee;
    const externalId = `WEB-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`; const trackingToken = randomUUID().replace(/-/g, "");
    const { data: order, error: orderError } = await supabase.rpc("create_web_order",{p_external_id:externalId,p_tracking_token:trackingToken,p_order_type:orderType,p_customer_name:customerName,p_phone:phone,p_address:orderType==="Доставка"?address:null,p_comment:comment||null,p_total:total,p_delivery_fee:fee,p_items:items});
    if (orderError) throw orderError;
    const created=Array.isArray(order)?order[0]:order;
    if(!created?.id)throw new Error("Atomic order creation returned no order");
    res.status(201).json({ ok: true, orderId: created.id, externalId, trackingToken, total, deliveryFee: fee });
  } catch (error) { console.error("POST /api/orders:", error); res.status(500).json({ error: "Не удалось создать заказ" }); }
});

app.get("/api/orders/:token", async (req, res) => {
  try { const token = String(req.params.token || "").trim(); if (!token) return res.status(400).json({ error: "Missing token" }); const { data: order, error } = await supabase.from("orders").select("id,external_id,status,order_type,customer_name,phone,address,comment,total,delivery_fee,created_at,updated_at,order_items(product_name,price,quantity,comment)").eq("tracking_token", token).maybeSingle(); if (error) throw error; if (!order) return res.status(404).json({ error: "Заказ не найден" }); res.json({ order }); }
  catch (error) { console.error("GET /api/orders/:token:", error); res.status(500).json({ error: "Не удалось загрузить заказ" }); }
});

app.post("/api/orders/:id/accept", async (req, res) => {
  try {
    const deviceKey = String(req.header("x-device-key") || req.body?.deviceKey || "").trim();
    const id = String(req.params.id || "").trim();
    if (!deviceKey) return res.status(401).json({ error: "Missing device key" });
    if (!id) return res.status(400).json({ error: "Invalid order id" });

    const { data: device, error: deviceError } = await supabase.from("devices").select("id").eq("device_key", deviceKey).eq("is_active", true).maybeSingle();
    if (deviceError) throw deviceError;
    if (!device) return res.status(401).json({ error: "Invalid device key" });

    const { data: existing, error: existingError } = await supabase.from("orders").select("id,status,updated_at").eq("id", id).maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return res.status(404).json({ error: "Заказ не найден" });

    if (existing.status === "accepted") return res.json({ ok: true, order: existing, alreadyAccepted: true });
    if (existing.status !== "new") return res.status(409).json({ error: "Заказ уже изменил статус", order: existing });

    const { data: order, error } = await supabase.from("orders").update({ status: "accepted", updated_at: new Date().toISOString() }).eq("id", id).eq("status", "new").select("id,status,updated_at").maybeSingle();
    if (error) throw error;
    if (!order) {
      const { data: current, error: currentError } = await supabase.from("orders").select("id,status,updated_at").eq("id", id).maybeSingle();
      if (currentError) throw currentError;
      if (current?.status === "accepted") return res.json({ ok: true, order: current, alreadyAccepted: true });
      return res.status(409).json({ error: "Заказ уже изменил статус", order: current || null });
    }

    return res.json({ ok: true, order });
  } catch (error) {
    console.error("POST /api/orders/:id/accept:", error);
    return res.status(500).json({ error: "Не удалось принять заказ" });
  }
});

app.patch("/api/orders/:id/status", async (req, res) => {
  try { const deviceKey = String(req.header("x-device-key") || "").trim(); const id = String(req.params.id || "").trim(); const status = String(req.body?.status || "").trim(); const allowed = new Set(["new", "accepted", "preparing", "ready", "cancelled"]); if (!deviceKey) return res.status(401).json({ error: "Missing device key" }); if (!id || !allowed.has(status)) return res.status(400).json({ error: "Invalid status" }); const { data: device, error: deviceError } = await supabase.from("devices").select("id").eq("device_key", deviceKey).eq("is_active", true).maybeSingle(); if (deviceError) throw deviceError; if (!device) return res.status(401).json({ error: "Invalid device key" }); const { data: order, error } = await supabase.from("orders").update({ status, updated_at: new Date().toISOString() }).eq("id", id).select("id,status,updated_at").single(); if (error) throw error; res.json({ ok: true, order }); }
  catch (error) { console.error("PATCH /api/orders/:id/status:", error); res.status(500).json({ error: "Не удалось обновить статус заказа" }); }
});

app.listen(port, () => console.log(`Prilavok backend listening on ${port}`));
