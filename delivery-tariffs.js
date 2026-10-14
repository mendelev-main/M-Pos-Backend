import { timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export function deliveryAmount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return { cents, amount: (cents / 100).toFixed(2) };
}

function normalizeTariffs(items) {
  if (!Array.isArray(items) || items.length > 100) return null;
  const seen = new Set();
  const tariffs = [];
  for (const item of items) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const amount = deliveryAmount(item?.amount);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !name || name.length > 100 || !amount || seen.has(id)) return null;
    seen.add(id);
    tariffs.push({ id, name, amount: amount.amount });
  }
  return tariffs;
}

export function createDeliveryTariffs({ query, withTransaction, sourceKey = '' }) {
  async function authorize(key) {
    if (!sourceKey) return { status: 503, code: 'DELIVERY_SOURCE_NOT_CONFIGURED', error: 'Источник тарифов доставки ещё не настроен на сервере' };
    const actual = Buffer.from(String(key || ''));
    const expected = Buffer.from(sourceKey);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { status: 403, error: 'Устройство не может менять тарифы доставки' };
    const { rows } = await query('SELECT id FROM public.devices WHERE device_key=$1 AND is_active=TRUE', [key]);
    if (!rows[0]) return { status: 401, error: 'Сначала выполните ручную синхронизацию каталога для регистрации устройства' };
    return { deviceId: rows[0].id };
  }

  async function list() {
    const { rows } = await query(`SELECT s.version,s.published,COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('id',t.external_id,'name',t.name,'amount',t.amount::text) ORDER BY t.sort_order,t.external_id)
       FROM public.delivery_tariffs t WHERE t.is_active), '[]'::jsonb) AS tariffs
      FROM public.delivery_tariff_state s WHERE s.id=TRUE`);
    return { version: Number(rows[0].version), published: rows[0].published, tariffs: rows[0].tariffs };
  }

  async function publish(key, payload) {
    const auth = await authorize(key);
    if (auth.error) return auth;
    const tariffs = normalizeTariffs(payload?.tariffs);
    const baseVersion = payload?.baseVersion;
    const publicationId = payload?.publicationId;
    if (!tariffs || !Number.isSafeInteger(baseVersion) || baseVersion < 0 || typeof publicationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(publicationId)) {
      return { status: 400, error: 'Некорректный список тарифов или версия публикации' };
    }
    return withTransaction(async client => {
      const { rows } = await client.query('SELECT * FROM public.delivery_tariff_state WHERE id=TRUE FOR UPDATE');
      const state = rows[0];
      if (state.source_device_id && state.source_device_id !== auth.deviceId) return { status: 403, error: 'Источник тарифов изменился; требуется настройка сервера' };
      if (state.publication_id === publicationId) {
        if (!isDeepStrictEqual(state.last_payload, tariffs)) return { status: 409, code: 'DELIVERY_SYNC_CONFLICT', error: 'ID публикации уже использован для другого списка' };
        return { ok: true, version: Number(state.version), duplicate: true };
      }
      if (Number(state.version) !== baseVersion) return { status: 409, code: 'DELIVERY_SYNC_CONFLICT', version: Number(state.version), error: 'На сервере уже другая версия тарифов. Проверьте список и подтвердите повторную публикацию' };
      if (state.published && isDeepStrictEqual(state.last_payload, tariffs)) {
        await client.query('UPDATE public.delivery_tariff_state SET publication_id=$1,updated_at=now() WHERE id=TRUE', [publicationId]);
        return { ok: true, version: Number(state.version), unchanged: true };
      }
      await client.query('UPDATE public.delivery_tariffs SET is_active=FALSE');
      for (const [position, tariff] of tariffs.entries()) {
        await client.query(`INSERT INTO public.delivery_tariffs(external_id,name,amount,sort_order,is_active)
          VALUES($1,$2,$3::numeric,$4,TRUE) ON CONFLICT(external_id) DO UPDATE SET
          name=excluded.name,amount=excluded.amount,sort_order=excluded.sort_order,is_active=TRUE,updated_at=now()`,
        [tariff.id, tariff.name, tariff.amount, position]);
      }
      const version = Number(state.version) + 1;
      await client.query(`UPDATE public.delivery_tariff_state SET source_device_id=$1,version=$2,published=TRUE,
        publication_id=$3,last_payload=$4::jsonb,updated_at=now() WHERE id=TRUE`, [auth.deviceId, version, publicationId, JSON.stringify(tariffs)]);
      return { ok: true, version };
    });
  }

  async function resolve(payload) {
    const { rows: states } = await query('SELECT published FROM public.delivery_tariff_state WHERE id=TRUE');
    if (!states[0].published) return { legacy: true };
    const id = payload?.deliveryTariffId;
    if (typeof id !== 'string' || !id) return { status: 400, code: 'DELIVERY_TARIFF_REQUIRED', error: 'Выберите тариф доставки' };
    const { rows } = await query(`SELECT t.external_id AS id,t.name,t.amount::text,s.version
      FROM public.delivery_tariffs t CROSS JOIN public.delivery_tariff_state s
      WHERE s.id=TRUE AND s.published AND t.external_id=$1 AND t.is_active`, [id]);
    const tariff = rows[0];
    if (!tariff) return { status: 409, code: 'DELIVERY_TARIFF_UNAVAILABLE', error: 'Выбранный тариф доставки больше недоступен' };
    const amount = deliveryAmount(tariff.amount);
    const expected = deliveryAmount(payload.deliveryTariffAmount);
    if (!expected || expected.cents !== amount.cents || payload.deliveryTariffVersion !== Number(tariff.version)) {
      return { status: 409, code: 'DELIVERY_TARIFF_CHANGED', error: 'Тарифы доставки изменились. Проверьте стоимость и выберите тариф заново' };
    }
    return { tariff: { id: tariff.id, name: tariff.name, amount: amount.amount, version: Number(tariff.version) }, cents: amount.cents };
  }
  return { authorize, list, publish, resolve };
}
