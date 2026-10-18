import { createPrivacyService, validateLegalAcknowledgement, publicLegalConfiguration } from "./privacy-service.js";
import { legalHtml, loyaltyProgramsHtml } from "./legal-documents.js";
import express from "express";
import { createDeliveryTariffs } from "./delivery-tariffs.js";
import { mountOwnerRoutes, ownerBotAuthorized } from "./owner-auth.js";
import cors from "cors";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createPhoneVerificationService } from "./phone-verification.js";
import { createCheckoutService } from "./checkout-service.js";
import { createAvailabilityService } from "./availability-service.js";
import { calculateLoyaltyTransition, formatLoyaltySaleMessage, loyaltyIdempotencyKey } from "./loyalty-engine.js";
import { validateLoyaltyAllocation } from "./loyalty-allocation.js";
import { closedPageHtml, isOrderingOpen, isSiteSleepWindow, millisecondsUntilSiteWake, VENUE_TIME_ZONE } from "./business-hours.js";
import { createTelegramOrderAlerts } from "./telegram-order-alerts.js";
import { createLivePosReports } from "./live-pos-reports.js";
import { query, withTransaction } from "./db/index.js";

import "./public/order-validation.js";
const { validate: validateOrderContact, normalizePhone } = globalThis.OrderValidation;

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use("/api/owner/report", express.json({ limit: "14mb" }));
app.use(express.json({ limit: "2mb" }));
app.use((req,res,next)=>{
  if(req.method==="GET"&&req.path==="/"&&!isSiteSleepWindow()&&!isOrderingOpen()){
    res.setHeader("Cache-Control","no-store");
    return res.type("html").send(closedPageHtml({ordering:true}));
  }
  next();
});
app.use((req,res,next)=>{
  if(!isSiteSleepWindow())return next();
  const retrySeconds=Math.ceil(millisecondsUntilSiteWake()/1000),path=String(req.path||"");
  if(req.method==="GET"&&(path==="/"||path==="/menu"||path==="/menu/")){res.setHeader("Cache-Control","no-store");res.setHeader("Retry-After",String(retrySeconds));return res.status(503).type("html").send(closedPageHtml())}
  if(req.method==="GET"&&(path==="/api/menu"||path==="/api/menu/availability")){res.setHeader("Cache-Control","no-store");res.setHeader("Retry-After",String(retrySeconds));return res.status(503).json({error:"Сайт доступен с 06:00",opensAt:"06:00",timeZone:VENUE_TIME_ZONE})}
  return next();
});
app.use(express.static("public",{setHeaders(res,filePath){
  if(filePath.endsWith(".html"))res.setHeader("Cache-Control","no-cache");
  else res.setHeader("Cache-Control","public, max-age=3600, stale-while-revalidate=86400");
}}));

const port = process.env.PORT || 3000;
const deliveryFee = Number(process.env.DELIVERY_FEE || 0);
const mediaRoot = process.env.PRODUCT_IMAGES_DIR || "/data/product-images";
const siteSleepingNow=()=>typeof isSiteSleepWindow==="function"&&isSiteSleepWindow();
const orderingOpenNow=()=>typeof isOrderingOpen!=="function"||isOrderingOpen();

const newRevisionId=()=>typeof randomUUID==="function"?randomUUID().slice(0,8):"test";
let catalogRevision=`boot-${Date.now().toString(36)}-${newRevisionId()}`;
function advanceCatalogRevision(){catalogRevision=`sync-${Date.now().toString(36)}-${newRevisionId()}`;return catalogRevision}
mountOwnerRoutes(app,{query});
const phoneVerification = createPhoneVerificationService(query, normalizePhone);
const availability = createAvailabilityService({ query });
const deliveryTariffs = createDeliveryTariffs({ query, withTransaction, sourceKey: process.env.DELIVERY_TARIFF_DEVICE_KEY || "" });
const checkout = createCheckoutService({ query, normalizePhone, validateOrderContact, phoneVerification, availability, deliveryFee, deliveryTariffs, validateLegal:validateLegalAcknowledgement });
const telegramOrderAlerts = createTelegramOrderAlerts({ query, botToken: process.env.TELEGRAM_BOT_TOKEN });
const privacy = createPrivacyService({query,phoneVerification,normalizePhone});
const livePosReports = createLivePosReports({ query, createId: () => randomUUID() });

app.get('/privacy/manage',(_req,res)=>res.redirect(302,'/privacy/manage.html'));
app.get('/api/legal',(_req,res)=>{res.set('Cache-Control','no-store');res.json(publicLegalConfiguration());});
app.get('/legal/programs',async(_req,res)=>{try{const programs=await loadLoyaltyPrograms({activeOnly:true});const {rows:products}=await query('SELECT id,name FROM public.products');res.set('Cache-Control','no-store');res.type('html').send(loyaltyProgramsHtml(programs,products));}catch{res.status(503).send('Условия программ временно недоступны. Повторите позже.');}});
app.get('/legal/:slug',(req,res)=>{const html=legalHtml(req.params.slug);if(!html)return res.sendStatus(404);res.set('Cache-Control','no-store');res.type('html').send(html);});
// Tokens are sent in Authorization, never in URLs or browser storage.
const privacyAccessLimits=new Map();
function privacyAccessAllowed(req){const key=String(req.ip||''),now=Date.now();for(const [k,v] of privacyAccessLimits)if(v.until<=now)privacyAccessLimits.delete(k);if(privacyAccessLimits.size>=10000&&!privacyAccessLimits.has(key))return false;const v=privacyAccessLimits.get(key)||{until:now+600000,count:0};v.count++;privacyAccessLimits.set(key,v);return v.count<=10;}
const privacyToken=req=>String(req.header('authorization')||'').replace(/^Bearer /,'');
app.post('/api/privacy/access',async(req,res)=>{if(!privacyAccessAllowed(req))return res.status(429).json({error:'Слишком много попыток. Повторите позже'});try{const r=await privacy.access(req.body?.phone);res.set('Cache-Control','no-store');res.status(r.status||200).json(r);}catch{res.status(503).json({error:'Не удалось начать подтверждение'});}});
app.get('/api/privacy/session',async(req,res)=>{try{const r=await privacy.status(privacyToken(req));res.set('Cache-Control','no-store');res.status(r.status||200).json(r);}catch{res.status(503).json({error:'Не удалось проверить участие'});}});
app.post('/api/privacy/withdraw',async(req,res)=>{try{const r=await privacy.withdraw(privacyToken(req));res.set('Cache-Control','no-store');res.status(r.status||200).json(r);}catch{res.status(503).json({error:'Не удалось прекратить участие'});}});
app.get('/api/device/privacy/tasks',async(req,res)=>{try{const device=await requireDevice(req,res);if(!device)return;const {rows}=await query(`SELECT t.id,t.order_external_id,t.order_id,t.customer_id,t.membership_version,t.task_type FROM public.privacy_pos_tasks t WHERE t.id>$2::bigint AND $1::uuid IS NOT NULL ORDER BY t.id LIMIT 200`,[device.id, /^\d{1,18}$/.test(String(req.query?.after||'0'))?String(req.query?.after||'0'):'0']);res.set('Cache-Control','no-store');res.json({tasks:rows,nextCursor:rows.at(-1)?.id||req.query?.after||'0',hasMore:rows.length===200});}catch{res.status(503).json({error:'Не удалось получить задания очистки'});}});
app.post('/api/device/privacy/tasks/:id/ack',async(req,res)=>{try{const device=await requireDevice(req,res);if(!device)return;await query(`INSERT INTO public.privacy_pos_task_receipts(device_id,task_id) SELECT $1,id FROM public.privacy_pos_tasks WHERE id=$2 ON CONFLICT DO NOTHING`,[device.id,req.params.id]);res.json({ok:true});}catch{res.status(503).json({error:'Не удалось подтвердить очистку'});}});
app.post('/api/device/privacy/orders/:id/closed',async(req,res)=>{try{if(!await requireDevice(req,res))return;const {rows}=await query(`UPDATE public.orders SET privacy_closed_at=coalesce(privacy_closed_at,now()) WHERE id=$1::uuid AND status<>'new' RETURNING id`,[req.params.id]);if(!rows.length)return res.status(409).json({error:'Заказ ещё не принят'});res.json({ok:true});}catch{res.status(503).json({error:'Не удалось сохранить завершение заказа'});}});
app.post('/api/device/privacy/ready',async(req,res)=>{try{const device=await requireDevice(req,res);if(!device)return;await query('INSERT INTO public.privacy_devices(device_id,protocol_version) VALUES($1,1) ON CONFLICT(device_id) DO UPDATE SET protocol_version=1,last_seen_at=now()',[device.id]);res.json({ok:true});}catch{res.status(503).json({error:'Не удалось подтвердить версию устройства'});}});
app.get('/api/device/privacy/report',async(req,res)=>{try{if(!await requireDevice(req,res))return;res.json(await privacy.retentionReport());}catch{res.status(503).json({error:'Не удалось получить отчёт'});}});
// Daily application maintenance; destructive order-contact stage remains report-only
// until the local-copy and backup recovery audit is complete.
setTimeout(()=>{void privacy.maintain({apply:true}).catch(()=>console.error('Privacy maintenance failed'));},30000);
const privacyMaintenance=setInterval(()=>{void privacy.maintain({apply:true}).catch(()=>console.error('Privacy maintenance failed'));},24*60*60*1000);privacyMaintenance?.unref?.();
app.get("/health", (_req, res) => res.json({ ok: true, service: "prilavok-backend" }));

app.get("/api/delivery-tariffs", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(await deliveryTariffs.list()); }
  catch { res.status(503).json({ error: "Тарифы доставки временно недоступны" }); }
});
app.get("/api/device/delivery-tariffs", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const auth = await deliveryTariffs.authorize(req.header("x-device-key"));
    if (auth.error) return res.status(auth.status).json(auth);
    res.json(await deliveryTariffs.list());
  } catch { res.status(503).json({ error: "Не удалось проверить публикацию тарифов" }); }
});
app.put("/api/device/delivery-tariffs", async (req, res) => {
  try {
    const result = await deliveryTariffs.publish(req.header("x-device-key"), req.body);
    res.status(result.status || 200).json(result);
  } catch { res.status(503).json({ error: "Не удалось сохранить тарифы доставки" }); }
});

app.post("/api/checkout", async (req, res) => {
  try {
    if(!orderingOpenNow())return res.status(503).json({error:"Онлайн-заказы принимаются с 10:00 до 22:30",opensAt:"10:00",closesAt:"22:30",timeZone:VENUE_TIME_ZONE});
    const result = await checkout.create(req.body);
    if (result.error) return res.status(result.status || 400).json({ error: result.error, code: result.code, fieldErrors: globalThis.OrderValidation.validateFields(req.body || {}) });
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
    return res.json({ status: session.status, expiresAt: session.expires_at, orderId: session.order_id || null });
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
  if (!ownerBotAuthorized(req.header("x-owner-bot-secret"), process.env.OWNER_BOT_SHARED_SECRET)) {
    console.warn("Phone verification rejected", { stage: "authorization", status: 403, reason: "BOT_UNAUTHORIZED" });
    return res.status(403).json({ ok: false, error: "Подтверждение доступно только через бота" });
  }
  try {
    const phone = String(req.body?.phone || "").trim();
    const telegramUserId = req.body?.telegramUserId;
    const result = await phoneVerification.confirm(req.params.token, phone, telegramUserId, ownerBotAuthorized(req.header("x-owner-bot-secret"), process.env.OWNER_BOT_SHARED_SECRET) ? req.body?.telegramUsername : undefined);
    if (!result.ok) {
      console.warn("Phone verification rejected", { stage: "confirmation", status: 409, reason: result.reason });
      return res.status(409).json(result);
    }

    const finalized = await checkout.finalizeByVerificationToken(req.params.token);
    if (finalized && !finalized.ok) {
      console.warn("Phone verification rejected", { stage: "finalization", status: 409, reason: finalized.reason });
      const stockError=finalized.reason==="OUT_OF_STOCK"?"Товар закончился или его осталось недостаточно":finalized.reason==="AVAILABILITY_UNAVAILABLE"?"Актуальные остатки временно недоступны":"Не удалось завершить оформление заказа";
      return res.status(409).json({ ok: false, error: stockError, reason: finalized.reason });
    }
    if (finalized?.ok && finalized.duplicate !== true) {
      void telegramOrderAlerts.notifyNewOrder().catch(error => console.error("Telegram POS order alert:", error));
    }
    return res.json({ ...result, orderCreated: Boolean(finalized?.ok) });
  } catch (error) {
    console.error("POST /api/phone-verification/:token/confirm:", error);
    return res.status(500).json({ ok: false, error: "Не удалось подтвердить номер" });
  }
});

app.use("/media/products", express.static(mediaRoot, { immutable: true, maxAge: "7d" }));
app.post("/api/media/upload", async (req, res) => {
  try {
    const deviceKey=String(req.header("x-device-key")||req.body?.deviceKey||"").trim(),productId=String(req.body?.productId||"").trim(),dataUrl=String(req.body?.dataUrl||"").trim();
    if(!deviceKey||!productId||!dataUrl)return res.status(400).json({error:"Missing upload data"});
    const {rows:deviceRows}=await query(`SELECT id FROM public.devices WHERE device_key=$1 AND is_active=TRUE LIMIT 1`,[deviceKey]);
    if(!deviceRows?.[0])return res.status(401).json({error:"Invalid device key"});
    const match=dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i);
    if(!match)return res.status(400).json({error:"Only JPEG, PNG or WebP images are supported"});
    const mime=match[1].toLowerCase(),buffer=Buffer.from(match[2],"base64");
    if(!buffer.length||buffer.length>1500000)return res.status(400).json({error:"Image is too large"});
    const ext=mime==="image/png"?"png":mime==="image/webp"?"webp":"jpg",fileName=`${encodeURIComponent(productId)}.${ext}`;
    await mkdir(mediaRoot,{recursive:true});
    await writeFile(`${mediaRoot}/${fileName}`,buffer);
    const imageVersion=createHash("sha256").update(buffer).digest("hex").slice(0,16);
    const publicBase=String(process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get("host")}`).replace(/\/$/,"");
    return res.json({ok:true,url:`${publicBase}/media/products/${fileName}?v=${imageVersion}`});
  } catch(error){console.error("POST /api/media/upload:",error);return res.status(500).json({error:"Failed to upload image"});}
});

app.post("/api/menu/sync", async (req, res) => {
  try {
    const deviceKey = String(req.header("x-device-key") || req.body?.deviceKey || "").trim();
    const deviceName = String(req.body?.deviceName || "Прилавок iPad").trim();
    const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
    const products = Array.isArray(req.body?.products) ? req.body.products : [];
    if (!deviceKey) return res.status(401).json({ error: "Missing device key" });

    const result = await withTransaction(async client => {
      const syncedAt = new Date().toISOString();
      const { rows: deviceRows } = await client.query(
        `INSERT INTO public.devices (device_key, name, is_active, last_sync_at)
         VALUES ($1, $2, TRUE, $3::timestamptz)
         ON CONFLICT (device_key) DO UPDATE SET
           name = EXCLUDED.name,
           is_active = TRUE,
           last_sync_at = EXCLUDED.last_sync_at
         RETURNING id`,
        [deviceKey, deviceName || "Прилавок iPad", syncedAt]
      );
      const device = deviceRows[0];

      const categoryRows = categories
        .map((c, index) => ({
          external_id: String(c.externalId || `category:${String(c.name || "").trim()}`),
          name: String(c.name || "").trim(),
          color: c.color ? String(c.color) : null,
          sort_order: Number.isFinite(Number(c.sortOrder)) ? Number(c.sortOrder) : index,
          is_active: c.isActive !== false,
          available_online: c.availableOnline !== false,
          visible_in_menu: c.visibleInOnlineMenu !== false
        }))
        .filter(c => c.name && c.external_id);

      for (const category of categoryRows) {
        await client.query(
          `INSERT INTO public.categories
             (external_id, name, color, sort_order, is_active, available_online, visible_in_menu, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (external_id) DO UPDATE SET
             name = EXCLUDED.name,
             color = EXCLUDED.color,
             sort_order = EXCLUDED.sort_order,
             is_active = EXCLUDED.is_active,
             available_online = EXCLUDED.available_online,
             visible_in_menu = EXCLUDED.visible_in_menu,
             updated_at = now()`,
          [category.external_id, category.name, category.color, category.sort_order, category.is_active, category.available_online, category.visible_in_menu]
        );
      }

      const externalIds = categoryRows.map(c => c.external_id);
      await client.query(
        `UPDATE public.categories
         SET is_active = FALSE, updated_at = now()
         WHERE external_id IS NOT NULL
           AND NOT (external_id = ANY($1::text[]))`,
        [externalIds]
      );

      const categoryMap = new Map();
      if (externalIds.length) {
        const { rows: dbCategories } = await client.query(
          `SELECT id, external_id
           FROM public.categories
           WHERE external_id = ANY($1::text[])`,
          [externalIds]
        );
        for (const category of dbCategories) categoryMap.set(category.external_id, category.id);
      }

      const productRows = products
        .map((p, index) => {
          const categoryName = String(p.category || "Без категории").trim() || "Без категории";
          return {
            external_id: String(p.externalId || ""),
            name: String(p.name || "").trim(),
            description: p.description ? String(p.description) : null,
            price: Number(p.price || 0),
            category_id: categoryMap.get(`category:${categoryName}`) || null,
            sort_order: Number.isFinite(Number(p.sortOrder)) ? Number(p.sortOrder) : index,
            is_active: p.isActive !== false,
            available_online: p.availableOnline !== false,
            visible_in_menu: p.visibleInOnlineMenu !== false,
            image_url: p.imageUrl ? String(p.imageUrl) : null
          };
        })
        .filter(p => p.external_id && p.name);

      for (const product of productRows) {
        await client.query(
          `INSERT INTO public.products
             (external_id, name, description, price, category_id, sort_order, is_active, available_online, visible_in_menu, image_url, updated_at)
           VALUES ($1, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10, now())
           ON CONFLICT (external_id) DO UPDATE SET
             name = EXCLUDED.name,
             description = EXCLUDED.description,
             price = EXCLUDED.price,
             category_id = EXCLUDED.category_id,
             sort_order = EXCLUDED.sort_order,
             is_active = EXCLUDED.is_active,
             available_online = EXCLUDED.available_online,
             visible_in_menu = EXCLUDED.visible_in_menu,
             image_url = EXCLUDED.image_url,
             updated_at = now()`,
          [product.external_id, product.name, product.description, product.price, product.category_id, product.sort_order, product.is_active, product.available_online, product.visible_in_menu, product.image_url]
        );
      }

      const productExternalIds = productRows.map(p => p.external_id);
      await client.query(
        `UPDATE public.products
         SET is_active = FALSE, available_online = FALSE, updated_at = now()
         WHERE external_id IS NOT NULL
           AND NOT (external_id = ANY($1::text[]))`,
        [productExternalIds]
      );

      return { device, categoryCount: categoryRows.length, productCount: productRows.length, syncedAt };
    });

    const revision = advanceCatalogRevision();
    return res.json({
      ok: true,
      deviceId: result.device?.id || null,
      categories: result.categoryCount,
      products: result.productCount,
      syncedAt: result.syncedAt,
      catalogRevision: revision
    });
  } catch (error) {
    console.error("POST /api/menu/sync:", error);
    return res.status(500).json({ error: "Failed to sync menu" });
  }
});

app.post("/api/availability/snapshot",async(req,res)=>{
  try{
    const result=await availability.store(req.header("x-device-key")||req.body?.deviceKey,req.body);
    if(result.error)return res.status(result.status||400).json({error:result.error});
    return res.json(result);
  }catch(error){console.error("POST /api/availability/snapshot:",error);return res.status(500).json({error:"Failed to store availability snapshot"})}
});


const OPERATIONAL_SCHEMA_VERSION = 1;
const OPERATIONAL_FRESH_MS = Number(process.env.OPERATIONAL_FRESH_MS || 45000);
async function operationalDevice(req) {
  const deviceKey = String(req.header("x-device-key") || "").trim();
  if (!deviceKey) return { error: "Missing device key", status: 401 };
  const { rows } = await query(
    `SELECT id, device_key, name, is_active
     FROM public.devices
     WHERE device_key = $1
       AND is_active = TRUE
     LIMIT 1`,
    [deviceKey]
  );
  const device = rows?.[0];
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
    await query(
      `INSERT INTO public.operational_states
         (device_id, schema_version, engine_version, heartbeat_at, updated_at)
       VALUES ($1::uuid, $2::integer, NULL, $3::timestamptz, $3::timestamptz)
       ON CONFLICT (device_id) DO UPDATE SET
         schema_version = EXCLUDED.schema_version,
         engine_version = EXCLUDED.engine_version,
         heartbeat_at = EXCLUDED.heartbeat_at,
         updated_at = EXCLUDED.updated_at`,
      [auth.device.id, OPERATIONAL_SCHEMA_VERSION, receivedAt]
    );
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
    const { rows } = await query(
      `SELECT public.store_operational_snapshot(
         $1::uuid,
         $2::integer,
         NULL::integer,
         $3::bigint,
         $4::timestamptz,
         $5::timestamptz,
         $6::jsonb
       ) AS applied`,
      [auth.device.id, OPERATIONAL_SCHEMA_VERSION, revision, sampledAt.toISOString(), receivedAt, JSON.stringify(req.body)]
    );
    const applied = rows?.[0]?.applied === true;
    return res.json({ ok: true, applied, ignoredAsStale: !applied, revision, receivedAt });
  } catch (error) {
    console.error("POST /api/operational/snapshot:", error);
    return res.status(500).json({ error: "Failed to store operational snapshot" });
  }
});
app.get("/api/operational/state", async (req, res) => {
  try {
    const auth = await operationalDevice(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    const { rows } = await query(
      `SELECT schema_version, heartbeat_at, snapshot_sampled_at, snapshot_received_at,
              snapshot_revision, snapshot, updated_at
       FROM public.operational_states
       WHERE device_id = $1::uuid
       LIMIT 1`,
      [auth.device.id]
    );
    const data = rows?.[0];
    if (!data) return res.json({ available: false, fresh: false, reason: "missing", freshnessMs: null, state: null });
    const now=Date.now(),heartbeatAt=data.heartbeat_at?new Date(data.heartbeat_at).getTime():0,sampledAt=data.snapshot_sampled_at?new Date(data.snapshot_sampled_at).getTime():0,receivedAt=data.snapshot_received_at?new Date(data.snapshot_received_at).getTime():0;
    const freshnessMs=heartbeatAt?Math.max(0,now-heartbeatAt):null,snapshotAgeMs=sampledAt?now-sampledAt:null,snapshotReceivedAgeMs=receivedAt?Math.max(0,now-receivedAt):null;
    const compatible=Number(data.schema_version)===OPERATIONAL_SCHEMA_VERSION&&Number(data.snapshot?.schemaVersion)===OPERATIONAL_SCHEMA_VERSION&&typeof data.snapshot?.demand?.overload==='boolean';
    const clockValid=snapshotAgeMs!==null&&snapshotAgeMs>=-30000;
    const fresh=compatible&&!!data.snapshot&&freshnessMs!==null&&freshnessMs<=OPERATIONAL_FRESH_MS&&clockValid&&snapshotAgeMs<=OPERATIONAL_FRESH_MS&&snapshotReceivedAgeMs!==null&&snapshotReceivedAgeMs<=OPERATIONAL_FRESH_MS;
    const reason=!compatible?"incompatible":!data.snapshot?"missing_snapshot":!clockValid?"invalid_snapshot_clock":!fresh?"stale":null;
    return res.json({available:fresh,fresh,compatible,reason,freshnessMs,snapshotAgeMs,snapshotReceivedAgeMs,maxFreshnessMs:OPERATIONAL_FRESH_MS,state:fresh?data.snapshot:null});
  } catch (error) {
    console.error("GET /api/operational/state:", error);
    return res.status(500).json({ error: "Failed to read operational state" });
  }
});


const DEMAND_STATUS_VALID_FOR_SECONDS = 45;
async function latestStoredDemandState() {
  const { rows: devices } = await query(
    `SELECT id
     FROM public.devices
     WHERE is_active = TRUE
     ORDER BY id`
  );
  const ids = (devices || []).map(x=>x.id);
  if (!ids.length) return { available:false, reason:"missing" };
  // v1 has one location/POS identity. Never guess between multiple active devices.
  if (ids.length !== 1) return { available:false, reason:"ambiguous_location" };
  const { rows } = await query(
    `SELECT device_id, schema_version, snapshot_received_at, snapshot
     FROM public.operational_states
     WHERE device_id = $1::uuid
     ORDER BY snapshot_received_at DESC NULLS LAST
     LIMIT 10`,
    [ids[0]]
  );
  for (const row of (rows || [])) {
    const compatible = Number(row.schema_version) === OPERATIONAL_SCHEMA_VERSION
      && Number(row.snapshot?.schemaVersion) === OPERATIONAL_SCHEMA_VERSION
      && typeof row.snapshot?.demand?.overload === "boolean";
    if (compatible) return { available:true, state:row.snapshot, storedAt:row.snapshot_received_at || null };
  }
  return { available:false, reason:(rows || []).length ? "incompatible" : "missing" };
}

async function demandStatusResponse(res) {
  try {
    const stateResult=await latestStoredDemandState();
    if (!stateResult.available) return res.json({available:false,demandState:"UNAVAILABLE"});
    const overload=stateResult.state?.demand?.overload===true;
    return res.json({
      available:true,
      demandState:overload?"OVERLOAD":"NORMAL",
      overload,
      storedAt:stateResult.storedAt,
      calculatedAt:new Date().toISOString(),
      validForSeconds:DEMAND_STATUS_VALID_FOR_SECONDS
    });
  } catch(error) {
    console.error("Demand status:",error);
    return res.json({available:false,demandState:"UNAVAILABLE"});
  }
}

app.get("/api/demand/status", async (_req,res) => demandStatusResponse(res));
// Temporary compatibility route for already cached/older web clients. It performs no ETA calculation.
app.post("/api/eta/estimate", async (_req,res) => demandStatusResponse(res));

app.get("/api/menu/availability",async(_req,res)=>{
  try{
    const items=(await availability.list()).map(row=>({external_id:row.externalId,availability_known:true,available_quantity:row.quantity}));
    res.setHeader?.("Cache-Control","no-store");
    return res.json({catalog_revision:catalogRevision,items});
  }catch(error){console.error("GET /api/menu/availability:",error);return res.status(500).json({error:"Failed to load availability"})}
});

app.get("/api/menu", async (req, res) => {
  try {
    const menuSurface = String(req.query?.surface || "").toLowerCase() === "menu";
    const visibilityColumn = menuSurface ? "visible_in_menu" : "available_online";

    const { rows: categories } = await query(`
      SELECT id, name, color, sort_order, is_active, external_id
      FROM categories
      WHERE is_active = TRUE
        AND ${visibilityColumn} = TRUE
      ORDER BY sort_order ASC, name ASC
    `);

    const { rows: products } = await query(`
      SELECT id, name, description, price, category_id, image_url,
             sort_order, is_active, available_online, external_id
      FROM products
      WHERE is_active = TRUE
        AND ${visibilityColumn} = TRUE
      ORDER BY sort_order ASC, name ASC
    `);
    const allowedCategoryIds = new Set((categories ?? []).map(c => c.id));
    const surfaceProducts = (products ?? []).filter(p => !p.category_id || allowedCategoryIds.has(p.category_id));
    const onlineCategoryIds = new Set(surfaceProducts.map(p => p.category_id).filter(Boolean));
    const availableProducts=await availability.attachToProducts(surfaceProducts);
    const versioned=String(req.query?.revision||"")===catalogRevision;
    res.setHeader?.("Cache-Control",versioned?(menuSurface?"public, max-age=604800, immutable":"private, max-age=604800, immutable"):(menuSurface?"public, max-age=1800":"private, max-age=120"));
    res.setHeader?.("X-Catalog-Revision",catalogRevision);
    res.json({ catalog_revision:catalogRevision,categories: (categories ?? []).filter(c => onlineCategoryIds.has(c.id)), products: availableProducts });
  } catch (error) { console.error("GET /api/menu:", error); res.status(500).json({ error: "Failed to load menu" }); }
});

const eventClients = new Set(); let eventPollBusy = false;
async function pushNewOrders(){
  if(typeof isSiteSleepWindow==="function"&&isSiteSleepWindow()){
    const retry=Math.ceil(millisecondsUntilSiteWake());
    for(const client of eventClients){try{client.res.write(`retry: ${retry}\nevent: sleeping\ndata: {}\n\n`);client.res.end()}catch(_error){}}
    eventClients.clear();return;
  }
  if(eventPollBusy || !eventClients.size) return; eventPollBusy = true;
  try {
    const {rows}=await query(`SELECT o.id,o.external_id,o.status,o.order_type,o.customer_id,o.customer_name,o.phone,o.address,o.comment,o.total,o.delivery_fee,o.delivery_tariff_id,o.delivery_tariff_name,o.delivery_tariff_version,o.created_at,o.updated_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'product_id',i.product_id,'external_product_id',i.external_product_id,'product_name',i.product_name,'price',i.price,'quantity',i.quantity,'comment',i.comment) ORDER BY i.created_at,i.id) FROM public.order_items i WHERE i.order_id=o.id),'[]'::jsonb) AS order_items
      FROM public.orders o WHERE o.status='new' ORDER BY o.created_at DESC LIMIT 20`);
    const payload=JSON.stringify({type:"orders",orders:rows||[]});for(const client of eventClients){try{client.res.write(`data: ${payload}\n\n`);}catch(e){}}
  }
  catch(error){ console.error("order event poll:", error); } finally { eventPollBusy = false; }
}
setInterval(pushNewOrders, 2000);

app.get("/api/orders/events", async (req, res) => {
  try {
    if(siteSleepingNow()){res.setHeader("Content-Type","text/event-stream; charset=utf-8");res.setHeader("Cache-Control","no-store");res.write(`retry: ${Math.ceil(millisecondsUntilSiteWake())}\nevent: sleeping\ndata: {}\n\n`);return res.end()}
    const deviceKey = String(req.header("x-device-key") || req.query.deviceKey || "").trim();
    if(!deviceKey) return res.status(401).json({error:"Missing device key"});
    const { rows: deviceRows } = await query(
      `SELECT id
       FROM public.devices
       WHERE device_key=$1
         AND is_active=TRUE
       LIMIT 1`,
      [deviceKey]
    );
    const device=deviceRows?.[0];
    if(!device) return res.status(401).json({error:"Invalid device key"});
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8"); res.setHeader("Cache-Control", "no-cache, no-transform"); res.setHeader("Connection", "keep-alive"); res.setHeader("X-Accel-Buffering", "no"); res.flushHeaders?.();
    const client={res,deviceKey,deviceId:device.id}; eventClients.add(client); res.write(`event: ready\ndata: ${JSON.stringify({ok:true})}\n\n`); const heartbeat=setInterval(()=>{ try{res.write(`: ping\n\n`);}catch(e){} }, 15000); req.on("close",()=>{clearInterval(heartbeat);eventClients.delete(client);}); pushNewOrders();
  } catch(error) { console.error("GET /api/orders/events:", error); if(!res.headersSent) return res.status(500).json({error:"Failed to open order stream"}); res.end(); }
});

async function requireDevice(req,res){
  const deviceKey=String(req.header("x-device-key")||req.body?.deviceKey||"").trim();
  if(!deviceKey){res.status(401).json({error:"Missing device key"});return null}
  const {rows}=await query(
    `SELECT id
     FROM public.devices
     WHERE device_key=$1
       AND is_active=TRUE
     LIMIT 1`,
    [deviceKey]
  );
  const device=rows?.[0];
  if(!device){res.status(401).json({error:"Invalid device key"});return null}
  return device;
}
async function saveDeviceTelegramSettings(req, res) {
  try {
    const device = await requireDevice(req, res);
    if (!device) return;
    const result = await telegramOrderAlerts.configure(device.id, {
      chatId: req.body?.chatId,
      ownerChatId: req.body?.ownerChatId,
      enabled: req.body?.enabled === true,
    });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
  } catch (error) {
    console.error("PUT device Telegram settings:", error);
    return res.status(500).json({ error: "Не удалось сохранить настройки Telegram" });
  }
}
app.put("/api/device/telegram-settings", saveDeviceTelegramSettings);
// Compatibility for POS builds that only knew the order-notification setting.
app.put("/api/device/telegram-order-notifications", saveDeviceTelegramSettings);

function deliverLiveReportRequest(deviceId, payload) {
  const clients = [...eventClients].filter(client => client.deviceId === deviceId);
  let delivered = false;
  for (const client of clients) {
    try {
      client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
      delivered = true;
    } catch (_error) {
      eventClients.delete(client);
    }
  }
  return delivered;
}
function liveReportError(res, error) {
  return res.status(error.status || 503).json({
    error: error.status ? error.message : "Сервис отчётов временно недоступен",
    code: error.code || "LIVE_REPORT_UNAVAILABLE",
  });
}
function requireOwnerBot(req, res) {
  if (ownerBotAuthorized(req.header("x-owner-bot-secret"), process.env.OWNER_BOT_SHARED_SECRET)) return true;
  res.status(403).json({ error: "Доступ запрещён", code: "OWNER_FORBIDDEN" });
  return false;
}
app.post("/api/owner/live-report/access", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!requireOwnerBot(req, res)) return;
    return res.json(await livePosReports.access(req.body?.telegramId));
  } catch (error) {
    return liveReportError(res, error);
  }
});
app.post("/api/owner/live-report", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!requireOwnerBot(req, res)) return;
    return res.json(await livePosReports.request(req.body?.telegramId, deliverLiveReportRequest));
  } catch (error) {
    return liveReportError(res, error);
  }
});
app.post("/api/device/live-report/:requestId", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const device = await requireDevice(req, res);
    if (!device) return;
    if (!livePosReports.submit(device.id, req.params.requestId, req.body?.report)) {
      return res.status(404).json({ error: "Запрос отчёта завершён", code: "LIVE_REPORT_EXPIRED" });
    }
    return res.json({ ok: true });
  } catch (error) {
    return liveReportError(res, error);
  }
});
async function loadLoyaltyPrograms({ activeOnly = false } = {}) {
  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.required_quantity,
       p.reward_quantity,
       p.is_active,
       p.created_at,
       COALESCE(
         jsonb_agg(DISTINCT jsonb_build_object('product_id', e.product_id))
           FILTER (WHERE e.product_id IS NOT NULL),
         '[]'::jsonb
       ) AS loyalty_earning_products,
       COALESCE(
         jsonb_agg(DISTINCT jsonb_build_object('product_id', r.product_id))
           FILTER (WHERE r.product_id IS NOT NULL),
         '[]'::jsonb
       ) AS loyalty_reward_products
     FROM public.loyalty_programs p
     LEFT JOIN public.loyalty_earning_products e ON e.program_id = p.id
     LEFT JOIN public.loyalty_reward_products r ON r.program_id = p.id
     WHERE ($1::boolean = FALSE OR p.is_active = TRUE)
     GROUP BY p.id
     ORDER BY p.created_at ASC`,
    [activeOnly]
  );
  return rows || [];
}

async function membershipFor(customerId){const {rows}=await query(`SELECT public.loyalty_membership_active($1::uuid) AS active,version,expires_at FROM public.loyalty_memberships WHERE customer_id=$1::uuid`,[customerId]);return rows?.[0]||{active:false,version:null};}
async function customerLoyalty(customerId){
  const programs = await loadLoyaltyPrograms({ activeOnly: true });
  const result = [];
  for (const program of programs) {
    const { rows } = await query(
      `SELECT progress, rewards
       FROM public.loyalty_balance($1::uuid, $2::uuid)`,
      [customerId, program.id]
    );
    const balance = rows?.[0] || {};
    result.push({
      ...program,
      progress: Number(balance.progress || 0),
      rewards: Number(balance.rewards || 0)
    });
  }
  return result;
}
function customerSearchFilter(value) {
  const q = String(value || "").trim();
  const compact = q.replace(/[\s()-]/g, "");
  if (/^\+375\d{4,9}$/.test(compact)) return { column: "normalized_phone", pattern: compact + "%" };
  if (/^\d{4}$/.test(compact)) return { column: "normalized_phone", pattern: "%" + compact };
  const phone = normalizePhone(q);
  return phone ? { column: "normalized_phone", pattern: "%" + phone + "%" } : { column: "name", pattern: "%" + q + "%" };
}
app.get("/api/customers/search",async(req,res)=>{try{if(!await requireDevice(req,res))return;const q=String(req.query.q||"").trim();if(q.length<2)return res.json({customers:[]});const filter=customerSearchFilter(q);const column=filter.column==="normalized_phone"?"normalized_phone":"name";const {rows}=await query(`SELECT id,name,normalized_phone,telegram_user_id,telegram_username,last_purchase_at FROM public.customers WHERE ${column} ILIKE $1 ORDER BY name ASC LIMIT 20`,[filter.pattern]);res.json({customers:rows||[]});}catch(e){console.error("customer search",e);res.status(500).json({error:"Failed to search customers"})}});
app.post("/api/customers",async(req,res)=>{try{if(!await requireDevice(req,res))return;const name=String(req.body?.name||"").trim(),phone=normalizePhone(req.body?.phone);if(!name||!phone)return res.status(400).json({error:"Name and phone are required"});try{const {rows}=await query(`INSERT INTO public.customers (name,normalized_phone) VALUES ($1,$2) RETURNING id,name,normalized_phone,telegram_user_id,telegram_username,last_purchase_at`,[name,phone]);res.status(201).json({customer:rows[0]});}catch(error){if(error?.code==="23505")return res.status(409).json({error:"Customer already exists"});throw error}}catch(e){console.error("customer create",e);res.status(500).json({error:"Failed to create customer"})}});
app.get("/api/customers/:id/loyalty",async(req,res)=>{try{if(!await requireDevice(req,res))return;const {rows}=await query(`SELECT id,name,normalized_phone,telegram_user_id,telegram_username,last_purchase_at FROM public.customers WHERE id=$1::uuid LIMIT 1`,[req.params.id]);const customer=rows?.[0];if(!customer)return res.status(404).json({error:"Customer not found"});const membership=await membershipFor(customer.id);res.json({customer,membership,programs:membership.active?await customerLoyalty(customer.id):[]});}catch(e){console.error("customer loyalty",e);res.status(500).json({error:"Failed to load loyalty"})}});
app.get("/api/loyalty/programs",async(req,res)=>{try{if(!await requireDevice(req,res))return;res.json({programs:await loadLoyaltyPrograms()});}catch(e){res.status(500).json({error:"Failed to load programs"})}});
app.post("/api/loyalty/programs",async(req,res)=>{try{if(!await requireDevice(req,res))return;const name=String(req.body?.name||"").trim(),required=Math.trunc(Number(req.body?.requiredQuantity)),earningIds=[...new Set((req.body?.earningProductIds||[]).map(String))],rewardIds=[...new Set((req.body?.rewardProductIds||[]).map(String))];if(!name||required<1)return res.status(400).json({error:"Invalid loyalty program"});const program=await withTransaction(async client=>{const {rows}=await client.query(`INSERT INTO public.loyalty_programs(name,required_quantity,reward_quantity,is_active) VALUES($1,$2,1,$3) RETURNING *`,[name,required,req.body?.isActive!==false]);const p=rows[0];for(const id of earningIds)await client.query(`INSERT INTO public.loyalty_earning_products(program_id,product_id) VALUES($1::uuid,$2)`,[p.id,id]);for(const id of rewardIds)await client.query(`INSERT INTO public.loyalty_reward_products(program_id,product_id) VALUES($1::uuid,$2)`,[p.id,id]);return p;});res.status(201).json({program});}catch(e){console.error("loyalty program",e);res.status(500).json({error:"Failed to create program"})}});
app.put("/api/loyalty/programs/:id",async(req,res)=>{try{if(!await requireDevice(req,res))return;const id=String(req.params.id||"").trim(),name=String(req.body?.name||"").trim(),required=Math.trunc(Number(req.body?.requiredQuantity)),earningIds=[...new Set((req.body?.earningProductIds||[]).map(String))],rewardIds=[...new Set((req.body?.rewardProductIds||[]).map(String))];if(!id||!name||required<1||!earningIds.length||!rewardIds.length)return res.status(400).json({error:"Invalid loyalty program"});const {rows}=await query(`SELECT (public.replace_loyalty_program($1::uuid,$2,$3,1,$4,$5::text[],$6::text[])).*`,[id,name,required,req.body?.isActive!==false,earningIds,rewardIds]);res.json({program:rows?.[0]||null});}catch(e){console.error("loyalty program update",e);res.status(500).json({error:"Failed to update program"})}});
app.patch("/api/loyalty/programs/:id/active",async(req,res)=>{try{if(!await requireDevice(req,res))return;const {rows}=await query(`UPDATE public.loyalty_programs SET is_active=$2,updated_at=now() WHERE id=$1::uuid RETURNING *`,[req.params.id,Boolean(req.body?.isActive)]);if(!rows?.[0])return res.status(404).json({error:"Program not found"});res.json({program:rows[0]});}catch(e){console.error("loyalty program active",e);res.status(500).json({error:"Failed to update program state"})}});
app.delete("/api/loyalty/programs/:id",async(req,res)=>{try{if(!await requireDevice(req,res))return;const id=String(req.params.id||"").trim();if(!id)return res.status(400).json({error:"Missing loyalty program"});const {rows:counts}=await query(`SELECT count(*)::integer AS count FROM public.loyalty_ledger WHERE program_id=$1::uuid`,[id]);if(Number(counts?.[0]?.count||0)>0)return res.status(409).json({error:"Program has loyalty history and cannot be deleted. Disable it instead."});await query(`DELETE FROM public.loyalty_programs WHERE id=$1::uuid`,[id]);res.json({ok:true});}catch(e){console.error("loyalty program delete",e);res.status(500).json({error:"Failed to delete program"})}});


app.post("/api/loyalty/sales",async(req,res)=>{
  try{
    if(!await requireDevice(req,res))return;
    const orderId=String(req.body?.orderId||"").trim(),customerId=String(req.body?.customerId||"").trim();
    const items=Array.isArray(req.body?.items)?req.body.items:[],redemptions=req.body?.redemptions||{},rewardAllocations=req.body?.rewardAllocations||{};
    if(!orderId||!customerId)return res.status(400).json({error:"Missing loyalty sale identity"});
    const membership=await membershipFor(customerId);
    if(!membership.active||String(membership.version)!==String(req.body?.consentVersion)){
      if(Object.values(redemptions).some(x=>Number(x)>0))return res.status(409).json({error:'Участие в лояльности не подтверждено',code:'LOYALTY_CONSENT_REQUIRED'});
      return res.json({ok:true,events:[],programs:[],skipped:'consent_required'});
    }
    const programs=await customerLoyalty(customerId),events=[];
    let allocation;
    try{allocation=validateLoyaltyAllocation({items,programs,redemptions,rewardAllocations})}
    catch(e){return res.status(409).json({error:"Invalid loyalty reward allocation",reason:String(e.message||e)})}
    await withTransaction(async client=>{
    const query=client.query.bind(client);
    await query("SELECT pg_advisory_xact_lock(hashtextextended('privacy:'||$1::text,0))",[customerId]);
    for(const p of programs){
      const earningIds=new Set((p.loyalty_earning_products||[]).map(x=>String(x.product_id)));
      const earned=[...allocation.paidByProduct].filter(([productId])=>earningIds.has(productId)).reduce((sum,[,quantity])=>sum+quantity,0);
      const redeem=allocation.allocatedByProgram.get(String(p.id))||0;
      if(!earned&&!redeem)continue;
      const key=loyaltyIdempotencyKey(orderId,p.id,"sale");
      const {rows}=await query(`SELECT * FROM public.apply_loyalty_sale($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::bigint,$10::timestamptz)`,[customerId,p.id,key,orderId,earned,redeem,p.required_quantity,p.reward_quantity,membership.version,req.body?.occurredAt||null]);const x=rows?.[0];
      events.push({programId:p.id,earned,redeemed:Number(x?.redeemed||0),granted:Number(x?.granted||0),progress:Number(x?.progress||0),rewards:Number(x?.rewards||0),duplicate:Boolean(x?.duplicate)});
    }
    await query(`UPDATE public.customers SET last_purchase_at=now(),updated_at=now() WHERE id=$1::uuid`,[customerId]);
    });
    const finalPrograms=await customerLoyalty(customerId);
    const {rows:customerRows}=await query(`SELECT telegram_user_id FROM public.customers WHERE id=$1::uuid LIMIT 1`,[customerId]);const customer=customerRows?.[0];
    res.json({ok:true,events,programs:finalPrograms,telegramUserId:customer?.telegram_user_id||null,loyaltyMessage:formatLoyaltySaleMessage(events,finalPrograms)});
  }catch(e){for(const code of ["LOYALTY_CONSENT_REQUIRED","LOYALTY_EVENT_TIME_INVALID","INSUFFICIENT_LOYALTY_REWARDS"]){if(String(e.message||"").includes(code))return res.status(409).json({error:"Операция лояльности отклонена: обновите данные клиента",code});}console.error("loyalty sale",e);res.status(500).json({error:"Failed to apply loyalty"})}
});

app.post("/api/loyalty/reversal",async(req,res)=>{
  try{
    if(!await requireDevice(req,res))return;
    const orderId=String(req.body?.orderId||"").trim(),customerId=String(req.body?.customerId||"").trim();
    if(!orderId||!customerId)return res.status(400).json({error:"Missing reversal identity"});
    const {rows}=await query(`SELECT public.apply_single_reward_reversal($1::uuid,$2) AS reversed`,[customerId,orderId]);
    res.json({ok:true,reversed:Number(rows?.[0]?.reversed||0),programs:await customerLoyalty(customerId)});
  }catch(e){console.error("loyalty reversal",e);res.status(500).json({error:"Failed to reverse loyalty"})}
});

app.get("/api/analytics/loyalty",async(req,res)=>{try{if(!await requireDevice(req,res))return;const from=String(req.query?.from||"").trim(),to=String(req.query?.to||"").trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to))return res.status(400).json({error:"Invalid analytics range"});const start=from+"T00:00:00.000Z",end=new Date(to+"T00:00:00.000Z");end.setUTCDate(end.getUTCDate()+1);const endIso=end.toISOString();const [{rows:orders},{rows:ledger},{rows:customers}]=await Promise.all([query(`SELECT id,customer_id,total,status,created_at FROM public.orders WHERE customer_id IS NOT NULL AND created_at >= $1::timestamptz AND created_at < $2::timestamptz`,[start,endIso]),query(`SELECT customer_id,operation_type,reward_delta,metadata,created_at FROM public.loyalty_ledger WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`,[start,endIso]),query(`SELECT id,created_at FROM public.customers`)]);const paid=(orders||[]).filter(x=>!["cancelled","canceled"].includes(String(x.status||"").toLowerCase())),customerIds=new Set(paid.map(x=>x.customer_id)),newCustomers=(customers||[]).filter(x=>new Date(x.created_at)>=new Date(start)&&new Date(x.created_at)<new Date(endIso)).length,repeatCustomers=[...customerIds].filter(id=>paid.filter(x=>x.customer_id===id).length>1).length,customerRevenue=paid.reduce((sum,x)=>sum+Number(x.total||0),0),granted=(ledger||[]).filter(x=>x.operation_type==="REWARD_GRANTED").reduce((sum,x)=>sum+Math.max(0,Number(x.reward_delta||0)),0),redeemed=(ledger||[]).filter(x=>x.operation_type==="REWARD_REDEEMED").reduce((sum,x)=>sum+Math.max(0,-Number(x.reward_delta||0)),0),activeLoyalty=new Set((ledger||[]).filter(x=>["EARN","REWARD_GRANTED","REWARD_REDEEMED"].includes(x.operation_type)).map(x=>x.customer_id)).size;res.json({customers:customerIds.size,newCustomers,repeatCustomers,customerOrders:paid.length,customerRevenue,averageCustomerCheck:paid.length?customerRevenue/paid.length:0,activeLoyaltyUsers:activeLoyalty,rewardsGranted:granted,rewardsRedeemed:redeemed});}catch(e){console.error("loyalty analytics",e);res.status(500).json({error:"Failed to load loyalty analytics"})}});

app.get("/api/customers/:id/orders",async(req,res)=>{try{if(!await requireDevice(req,res))return;const {rows}=await query(`SELECT o.id,o.external_id,o.status,o.total,o.created_at,COALESCE((SELECT jsonb_agg(jsonb_build_object('product_name',i.product_name,'quantity',i.quantity,'price',i.price) ORDER BY i.created_at,i.id) FROM public.order_items i WHERE i.order_id=o.id),'[]'::jsonb) AS order_items FROM public.orders o WHERE o.customer_id=$1::uuid ORDER BY o.created_at DESC LIMIT 100`,[req.params.id]);res.json({orders:rows||[]});}catch(e){console.error("customer orders",e);res.status(500).json({error:"Failed to load customer orders"})}});
app.get("/api/customers/:id/ledger",async(req,res)=>{try{if(!await requireDevice(req,res))return;const {rows}=await query(`SELECT l.id,l.program_id,l.operation_type,l.progress_delta,l.reward_delta,l.metadata,l.created_at,jsonb_build_object('name',p.name) AS loyalty_programs FROM public.loyalty_ledger l JOIN public.loyalty_programs p ON p.id=l.program_id WHERE l.customer_id=$1::uuid ORDER BY l.created_at DESC LIMIT 100`,[req.params.id]);res.json({ledger:rows||[]});}catch(e){console.error("loyalty ledger",e);res.status(500).json({error:"Failed to load loyalty ledger"})}});
app.post("/api/customers/:id/loyalty-adjustment",async(req,res)=>{
  try{
    if(!await requireDevice(req,res))return;
    const programId=String(req.body?.programId||"").trim(),reason=String(req.body?.reason||"").trim(),adminEmployeeId=String(req.body?.adminEmployeeId||"").trim(),adminEmployeeName=String(req.body?.adminEmployeeName||"").trim(),adminPassword=String(req.body?.adminPassword||""),progressDelta=Math.trunc(Number(req.body?.progressDelta)||0),rewardDelta=Math.trunc(Number(req.body?.rewardDelta)||0);
    if(!process.env.POS_ADMIN_PASSWORD||adminPassword!==process.env.POS_ADMIN_PASSWORD)return res.status(403).json({error:"Administrator authorization required"});
    if(!programId||!reason||!adminEmployeeId||!adminEmployeeName||(!progressDelta&&!rewardDelta))return res.status(400).json({error:"Program, reason, administrator and adjustment are required"});
    if(!(await membershipFor(req.params.id)).active)return res.status(409).json({error:'Участие в лояльности не подтверждено',code:'LOYALTY_CONSENT_REQUIRED'});
    const key=`manual:${req.params.id}:${programId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    try{await query(`SELECT * FROM public.apply_single_reward_adjustment($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb)`,[req.params.id,programId,progressDelta,rewardDelta,key,JSON.stringify({reason,adminEmployeeId,adminEmployeeName})]);}catch(error){if(String(error.message||"").includes("LOYALTY_CONSENT_REQUIRED"))return res.status(409).json({error:"Участие прекращено",code:"LOYALTY_CONSENT_REQUIRED"});if(String(error.message||"").includes("INVALID_SINGLE_REWARD_BALANCE"))return res.status(409).json({error:"Loyalty balance must contain at most one reward and no progress while it is available"});throw error}
    res.json({ok:true,programs:await customerLoyalty(req.params.id)});
  }catch(e){console.error("loyalty adjustment",e);res.status(500).json({error:"Failed to adjust loyalty"})}
});

app.get("/api/config", (_req, res) => res.json({ deliveryFee: Number.isFinite(deliveryFee) ? deliveryFee : 0,orderingOpen:orderingOpenNow(),orderHours:null }));

app.post("/api/orders", async (req, res) => {
  return res.status(410).json({error:"Используйте актуальную форму оформления заказа",code:"USE_CHECKOUT"});

});

app.get("/api/orders/:token",async(req,res)=>{try{const token=String(req.params.token||"").trim();if(!token)return res.status(400).json({error:"Missing token"});const {rows}=await query(`SELECT o.id,o.external_id,o.status,o.order_type,o.customer_name,o.phone,o.address,o.comment,o.total,o.delivery_fee,o.delivery_tariff_id,o.delivery_tariff_name,o.delivery_tariff_version,o.created_at,o.updated_at,COALESCE((SELECT jsonb_agg(jsonb_build_object('product_name',i.product_name,'price',i.price,'quantity',i.quantity,'comment',i.comment) ORDER BY i.created_at,i.id) FROM public.order_items i WHERE i.order_id=o.id),'[]'::jsonb) AS order_items FROM public.orders o WHERE o.tracking_token=$1 LIMIT 1`,[token]);const order=rows?.[0];if(!order)return res.status(404).json({error:"Заказ не найден"});res.json({order});}catch(error){console.error("GET /api/orders/:token:",error);res.status(500).json({error:"Не удалось загрузить заказ"})}});

app.post("/api/orders/:id/accept",async(req,res)=>{try{if(!await requireDevice(req,res))return;const id=String(req.params.id||"").trim();if(!id)return res.status(400).json({error:"Invalid order id"});const {rows:existingRows}=await query(`SELECT id,status,external_id,updated_at FROM public.orders WHERE id=$1::uuid LIMIT 1`,[id]);const existing=existingRows?.[0];if(!existing)return res.status(404).json({error:"Заказ не найден"});if(existing.status==="accepted")return res.json({ok:true,order:existing,alreadyAccepted:true});if(existing.status!=="new")return res.status(409).json({error:"Заказ уже изменил статус",order:existing});const {rows}=await query(`UPDATE public.orders SET status='accepted',updated_at=now() WHERE id=$1::uuid AND status='new' RETURNING id,status,external_id,updated_at`,[id]);const order=rows?.[0];if(!order){const {rows:currentRows}=await query(`SELECT id,status,external_id,updated_at FROM public.orders WHERE id=$1::uuid LIMIT 1`,[id]);const current=currentRows?.[0];if(current?.status==="accepted")return res.json({ok:true,order:current,alreadyAccepted:true});return res.status(409).json({error:"Заказ уже изменил статус",order:current||null});}return res.json({ok:true,order});}catch(error){console.error("POST /api/orders/:id/accept:",error);return res.status(500).json({error:"Не удалось принять заказ"})}});

app.patch("/api/orders/:id/status",async(req,res)=>{try{if(!await requireDevice(req,res))return;const id=String(req.params.id||"").trim(),status=String(req.body?.status||"").trim(),allowed=new Set(["new","accepted","preparing","ready","cancelled"]);if(!id||!allowed.has(status))return res.status(400).json({error:"Invalid status"});const {rows}=await query(`UPDATE public.orders SET status=$2,updated_at=now() WHERE id=$1::uuid RETURNING id,status,updated_at`,[id,status]);if(!rows?.[0])return res.status(404).json({error:"Заказ не найден"});res.json({ok:true,order:rows[0]});}catch(error){console.error("PATCH /api/orders/:id/status:",error);res.status(500).json({error:"Не удалось обновить статус заказа"})}});

app.listen(port, () => console.log(`Prilavok backend listening on ${port}`));
