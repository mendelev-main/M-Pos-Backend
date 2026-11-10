import { createHash, randomBytes } from 'node:crypto';

export function normalizeTelegramUsername(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/^@/, '');
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) ? name : null;
}
export const PHONE_VERIFICATION_TTL_MS = 5 * 60 * 1000;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'project_account_bot';

export function createPhoneVerificationService(query, normalizePhone) {
  const hashToken = token => createHash('sha256').update(String(token)).digest('hex');
  async function createRecord(phone, returnUrl) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + PHONE_VERIFICATION_TTL_MS).toISOString();
    await query(`INSERT INTO public.phone_verifications (token_hash,phone,status,expires_at,return_url)
      VALUES ($1,$2,'PENDING',$3::timestamptz,$4)`, [hashToken(token), phone, expiresAt, returnUrl || null]);
    return { token, status: 'PENDING', expiresAt, telegramUrl: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(token)}` };
  }
  async function create(phone, returnUrl = null) {
    const normalized = normalizePhone(phone);
    if (!normalized) return { error: 'Некорректный номер телефона', status: 400 };
    return createRecord(normalized, returnUrl);
  }
  // Only the browser-bound account flow may create a pending verification without a phone.
  const createAccount = returnUrl => createRecord(null, returnUrl);
  async function get(token) {
    const { rows } = await query(`SELECT id,phone,status,expires_at,verified_at,return_url,telegram_user_id
      FROM public.phone_verifications WHERE token_hash=$1 LIMIT 1`, [hashToken(token)]);
    const data = rows?.[0];
    if (!data) return null;
    if (data.status === 'PENDING' && new Date(data.expires_at).getTime() <= Date.now()) {
      await query(`UPDATE public.phone_verifications SET status='EXPIRED' WHERE id=$1::uuid AND status='PENDING'`, [data.id]);
      data.status = 'EXPIRED';
    }
    return data;
  }
  async function confirm(token, phone, telegramUserId, telegramUsername) {
    const normalized = normalizePhone(phone);
    if (!normalized || !/^\+375\d{9}$/.test(normalized) || !telegramUserId) return { ok: false, reason: 'INVALID' };
    const verification = await get(token);
    if (!verification || verification.status !== 'PENDING') return { ok: false, reason: verification?.status || 'NOT_FOUND' };
    if (verification.phone !== null && verification.phone !== normalized) return { ok: false, reason: 'PHONE_MISMATCH' };
    const usernameObserved = telegramUsername !== undefined;
    const username = usernameObserved ? normalizeTelegramUsername(telegramUsername) : null;
    const { rows } = await query(`UPDATE public.phone_verifications
      SET status='VERIFIED',verified_at=now(),telegram_user_id=$2,
          telegram_username=CASE WHEN $3::boolean THEN $4 ELSE telegram_username END,
          telegram_username_observed=CASE WHEN $3::boolean THEN TRUE ELSE telegram_username_observed END,
          phone=COALESCE(phone,$5)
      WHERE id=$1::uuid AND status='PENDING' AND expires_at>now() AND (phone IS NULL OR phone=$5)
      RETURNING id,status,verified_at,return_url,telegram_user_id`,
    [verification.id, String(telegramUserId), usernameObserved, username, normalized]);
    const data = rows?.[0];
    if (!data) return { ok: false, reason: 'ALREADY_USED' };
    return { ok: true, status: 'VERIFIED', verifiedAt: data.verified_at, returnUrl: data.return_url || null, telegramUserId: data.telegram_user_id || null };
  }
  async function consume(token, phone) {
    const normalized = normalizePhone(phone), verification = await get(token);
    if (!verification || verification.status !== 'VERIFIED' || verification.phone !== normalized) return false;
    const { rowCount } = await query(`UPDATE public.phone_verifications SET status='CONSUMED',consumed_at=now()
      WHERE id=$1::uuid AND status='VERIFIED'`, [verification.id]);
    return rowCount === 1;
  }
  return { create, createAccount, get, confirm, consume };
}
