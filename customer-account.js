import { createHash, randomBytes } from 'node:crypto';
import { createPhoneVerificationService } from './phone-verification.js';
import QRCode from 'qrcode';

export const ACCOUNT_SESSION_SECONDS = 90 * 24 * 60 * 60;
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export function createCustomerAccount({ query, withTransaction, normalizePhone }) {
  async function start(returnUrl) {
    return withTransaction(async client => {
      const verification = await createPhoneVerificationService(client.query.bind(client), normalizePhone).createAccount(returnUrl);
      if (verification.error) return verification;
      const proof = token();
      await client.query('DELETE FROM public.customer_account_challenges WHERE expires_at <= now()');
      await client.query('DELETE FROM public.customer_account_sessions WHERE expires_at <= now()');
      await client.query(`INSERT INTO public.customer_account_challenges(proof_hash,verification_token_hash,expires_at)
        VALUES($1,$2,$3::timestamptz)`, [hash(proof), hash(verification.token), verification.expiresAt]);
      return { proof, telegramUrl: verification.telegramUrl, expiresAt: verification.expiresAt };
    });
  }
  async function complete(proof) {
    if (!validToken(proof)) return { status: 'MISSING' };
    return withTransaction(async client => {
      const { rows } = await client.query(`SELECT c.expires_at,c.consumed_at,v.status,v.phone,v.telegram_user_id
        FROM public.customer_account_challenges c JOIN public.phone_verifications v ON v.token_hash=c.verification_token_hash
        WHERE c.proof_hash=$1 FOR UPDATE OF c,v`, [hash(proof)]);
      const challenge = rows[0];
      if (!challenge || challenge.consumed_at || new Date(challenge.expires_at) <= new Date()) return { status: 'EXPIRED' };
      if (challenge.status !== 'VERIFIED' || !challenge.telegram_user_id || !/^\+375\d{9}$/.test(challenge.phone || '')) return { status: 'PENDING' };
      const session = token();
      await client.query(`INSERT INTO public.customer_account_sessions(token_hash,phone,telegram_user_id,expires_at)
        VALUES($1,$2,$3,now()+interval '90 days')`, [hash(session), challenge.phone, challenge.telegram_user_id]);
      await client.query('UPDATE public.customer_account_challenges SET consumed_at=now() WHERE proof_hash=$1', [hash(proof)]);
      await client.query(`UPDATE public.phone_verifications SET status='CONSUMED',consumed_at=now()
        WHERE token_hash=(SELECT verification_token_hash FROM public.customer_account_challenges WHERE proof_hash=$1)`, [hash(proof)]);
      return { status: 'AUTHENTICATED', session };
    });
  }
  async function current(session) {
    if (!validToken(session)) return null;
    const { rows } = await query(`SELECT s.phone,COALESCE(p.display_name,c.name) AS name,c.telegram_username,
      c.id AS customer_id,p.delivery_address,
      COALESCE(public.loyalty_membership_active(c.id),FALSE) AS membership_active
      FROM public.customer_account_sessions s
      LEFT JOIN public.customers c ON c.normalized_phone=s.phone AND c.privacy_retired_at IS NULL
      LEFT JOIN public.customer_account_profiles p ON p.phone=s.phone
      WHERE s.token_hash=$1 AND s.expires_at>now()`, [hash(session)]);
    const user = rows[0];
    if (!user) return null;
    let programs = [];
    if (user.customer_id && user.membership_active) {
      const result = await query(`SELECT p.id,p.name,p.required_quantity,
        b.progress::integer AS progress,b.rewards::integer AS rewards,
        ARRAY(SELECT r.product_id FROM public.loyalty_reward_products r WHERE r.program_id=p.id ORDER BY r.product_id) AS reward_product_ids
        FROM public.loyalty_programs p CROSS JOIN LATERAL public.loyalty_balance($1::uuid,p.id) b
        WHERE p.is_active=TRUE ORDER BY p.created_at,p.id`, [user.customer_id]);
      programs = result.rows.map(p => ({ ...p, required_quantity: Number(p.required_quantity), progress: Number(p.progress), rewards: Number(p.rewards) }));
    }
    return { ...user, programs };
  }
  async function updateProfile(session, payload) {
    const user = await current(session);
    if (!user) return { status: 401, error: 'Войдите в личный кабинет.' };
    const fields = { name: 'display_name', deliveryAddress: 'delivery_address' };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).length || Object.keys(payload).some(key => !Object.hasOwn(fields,key))) return { status: 400, error: 'Проверьте поля профиля. Телефон изменить нельзя.' };
    const entries = [];
    for (const [key, raw] of Object.entries(payload)) {
      if (raw !== null && typeof raw !== 'string') return { status: 400, error: 'Проверьте формат данных.' };
      const value = raw?.trim() || null;
      if (key === 'name' && value && (value.length > 80 || /[\p{Cc}<>]/u.test(value))) return { status: 400, error: 'Введите имя длиной до 80 символов.' };
      if (key === 'deliveryAddress' && value && (value.length > 300 || /[\p{Cc}<>]/u.test(value))) return { status: 400, error: 'Введите адрес длиной до 300 символов.' };
      entries.push([fields[key], value]);
    }
    await query(`INSERT INTO public.customer_account_profiles(phone,${entries.map(([column]) => column).join(',')})
      VALUES($1,${entries.map((_, i) => `$${i + 2}`).join(',')}) ON CONFLICT(phone) DO UPDATE SET
      ${entries.map(([column]) => `${column}=EXCLUDED.${column}`).join(',')},updated_at=now()`, [user.phone, ...entries.map(([,value]) => value)]);
    return { user: await current(session) };
  }
  async function orders(session, cursor) {
    let before = null;
    if(cursor){try{before=JSON.parse(Buffer.from(String(cursor),"base64url").toString());if(!Array.isArray(before)||before.length!==2||!Number.isFinite(Date.parse(before[0]))||! /^[0-9a-f-]{36}$/i.test(before[1]))throw Error();}catch{return {error:"Обновите историю заказов.",status:400};}}
    const user = await current(session);
    if (!user) return null;
    const { rows } = await query(`SELECT o.id,o.external_id,o.status,o.order_type,o.total,o.created_at,o.created_at::text AS cursor_created_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name',i.product_name,'quantity',i.quantity,'price',i.price) ORDER BY i.created_at,i.id)
        FROM public.order_items i WHERE i.order_id=o.id),'[]'::jsonb) AS items
      FROM public.orders o WHERE (o.phone=$1 OR ($2::uuid IS NOT NULL AND o.customer_id=$2::uuid))
      AND ($3::timestamptz IS NULL OR (o.created_at,o.id)<($3::timestamptz,$4::uuid))
      ORDER BY o.created_at DESC,o.id DESC LIMIT 6`, [user.phone, user.customer_id,before?.[0]||null,before?.[1]||null]);
    const page=rows.slice(0,5),last=page.at(-1);
    return {orders:page,nextCursor:rows.length>5?Buffer.from(JSON.stringify([last.cursor_created_at||last.created_at,last.id])).toString('base64url'):null};
  }
  async function identity(session) {
    if(!validToken(session))return null;
    const {rows}=await query('SELECT phone,telegram_user_id FROM public.customer_account_sessions WHERE token_hash=$1 AND expires_at>now()',[hash(session)]);
    return rows[0]||null;
  }
  async function logout(session) {
    if (validToken(session)) await query('DELETE FROM public.customer_account_sessions WHERE token_hash=$1', [hash(session)]);
  }
  return { start, complete, current, identity, updateProfile, orders, logout };
}

function cookie(req, name) {
  return String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}
export function mountCustomerAccount(app, dependencies) {
  const account = createCustomerAccount(dependencies);
  const attempts = new Map();
  const setCookie = (req, res, name, value, maxAge) => res.append('Set-Cookie',
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  app.use('/api/account', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (['POST','PATCH','PUT','DELETE'].includes(req.method)) {
      const requestOrigin = `${req.protocol}://${req.get('host')}`;
      const expected = new URL(process.env.PUBLIC_BASE_URL || requestOrigin).origin;
      const sameOrigin = req.get('origin') === expected || process.env.NODE_ENV === 'development' && req.get('origin') === requestOrigin;
      if (!sameOrigin || !req.is('application/json')) return res.status(403).json({ error: 'Обновите страницу и повторите попытку.' });
    }
    next();
  });
  app.get('/api/account/session', async (req, res) => {
    try { res.json({ user: await account.current(cookie(req, 'mpos_account')) }); }
    catch { res.status(503).json({ error: 'Не удалось загрузить профиль. Попробуйте ещё раз.' }); }
  });
  app.patch('/api/account/profile', async (req, res) => {
    try {
      const result = await account.updateProfile(cookie(req, 'mpos_account'), req.body);
      res.status(result.status || 200).json(result);
    } catch { res.status(503).json({ error: 'Не удалось сохранить профиль. Попробуйте ещё раз.' }); }
  });
  app.get('/api/account/orders', async (req, res) => {
    try {
      const orders = await account.orders(cookie(req, 'mpos_account'),req.query?.cursor);
      if (!orders) return res.status(401).json({ error: 'Войдите в личный кабинет.' });
      res.status(orders.status||200).json(orders);
    } catch { res.status(503).json({ error: 'Не удалось загрузить историю заказов.' }); }
  });
  app.get('/api/account/qr', async (req, res) => {
    try {
      const user = await account.current(cookie(req, 'mpos_account'));
      if (!user) return res.status(401).json({ error: 'Войдите в личный кабинет.' });
      const svg = await QRCode.toString(user.phone, { type: 'svg', margin: 3, width: 192, errorCorrectionLevel: 'M', color: { dark: '#08090b', light: '#ffffff' } });
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.type('image/svg+xml').send(svg);
    } catch { res.status(503).json({ error: 'Не удалось загрузить QR-код.' }); }
  });
  app.post('/api/account/start', async (req, res) => {
    if (!process.env.OWNER_BOT_SHARED_SECRET) return res.status(503).json({ error: 'Вход через Telegram пока не настроен. Попробуйте позже.' });
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
    const entry = attempts.get(req.ip) || { count: 0, until: now + 15 * 60_000 };
    if (attempts.size >= 10_000 && !attempts.has(req.ip) || ++entry.count > 5) return res.status(429).json({ error: 'Слишком много попыток. Попробуйте через 15 минут.' });
    attempts.set(req.ip, entry);
    try {
      const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      const result = await account.start(new URL('/account/', base).href);
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      setCookie(req, res, 'mpos_account_challenge', result.proof, 300);
      res.status(201).json({ telegramUrl: result.telegramUrl, expiresAt: result.expiresAt });
    } catch { res.status(503).json({ error: 'Не удалось начать вход. Попробуйте ещё раз.' }); }
  });
  app.post('/api/account/complete', async (req, res) => {
    try {
      const result = await account.complete(cookie(req, 'mpos_account_challenge'));
      if (result.session) {
        setCookie(req, res, 'mpos_account', result.session, ACCOUNT_SESSION_SECONDS);
        setCookie(req, res, 'mpos_account_challenge', '', 0);
      }
      res.json({ status: result.status });
    } catch { res.status(503).json({ error: 'Не удалось завершить вход. Попробуйте ещё раз.' }); }
  });
  app.post('/api/account/logout', async (req, res) => {
    try {
      await account.logout(cookie(req, 'mpos_account'));
      setCookie(req, res, 'mpos_account', '', 0);
      setCookie(req, res, 'mpos_account_challenge', '', 0);
      res.json({ ok: true });
    } catch { res.status(503).json({ error: 'Не удалось выйти. Попробуйте ещё раз.' }); }
  });
  return account;
}
