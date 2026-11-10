import { createHash, randomBytes } from 'node:crypto';
import { createPhoneVerificationService } from './phone-verification.js';

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
    const { rows } = await query(`SELECT s.phone,c.name,c.telegram_username FROM public.customer_account_sessions s
      LEFT JOIN public.customers c ON c.normalized_phone=s.phone AND c.telegram_user_id=s.telegram_user_id
      WHERE s.token_hash=$1 AND s.expires_at>now()`, [hash(session)]);
    return rows[0] || null;
  }
  async function logout(session) {
    if (validToken(session)) await query('DELETE FROM public.customer_account_sessions WHERE token_hash=$1', [hash(session)]);
  }
  return { start, complete, current, logout };
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
    if (req.method === 'POST') {
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
}
