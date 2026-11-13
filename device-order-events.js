/** Device-authenticated, read-only order lists shared by all POS devices in this deployment. */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
function badRequest() { return Object.assign(new Error('Invalid order page'), { status: 400 }); }
export function decodeOrderCursor(raw) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(raw)) throw badRequest();
  try {
    const cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (cursor.v !== 1 || !uuid.test(cursor.id) || !instant.test(cursor.at) || (!Number.isFinite(Date.parse(cursor.at)) || Number(cursor.at.slice(0,4))<1 || new Date(cursor.at).toISOString().slice(0,19)!==cursor.at.slice(0,19))) throw badRequest();
    return cursor;
  } catch { throw badRequest(); }
}
export function encodeOrderCursor(row) {
  // PostgreSQL microseconds must survive the cursor; JS Date would truncate them.
  if (!uuid.test(row.id) || !instant.test(row.cursor_at)) throw new Error('Invalid database order cursor');
  return Buffer.from(JSON.stringify({ v: 1, at: row.cursor_at, id: row.id })).toString('base64url');
}
const columns = `o.id,o.external_id,o.status,o.order_type,o.customer_id,o.customer_name,o.phone,o.address,o.comment,
 o.total,o.delivery_fee,o.delivery_tariff_id,o.delivery_tariff_name,o.delivery_tariff_version,
 o.created_at,o.updated_at,o.web_paid_at,
 to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('external_product_id',i.external_product_id,'product_name',i.product_name,
 'price',i.price,'quantity',i.quantity,'comment',i.comment) ORDER BY i.created_at,i.id)
 FROM public.order_items i WHERE i.order_id=o.id),'[]'::jsonb) AS order_items`;
export function createDeviceOrderEvents({ query }) {
  return {
    async current() {
      const { rows } = await query(`SELECT ${columns} FROM public.orders o WHERE o.status='new' AND o.web_paid_at IS NULL ORDER BY o.created_at DESC,o.id DESC LIMIT 1001`, []);
      if (rows.length > 1000) throw Object.assign(new Error('Current order queue exceeds device limit'), { status: 409, code: 'CURRENT_QUEUE_TOO_LARGE' });
      return { orders: rows, complete: true };
    },
    async history(input = {}) {
      const limit = input.limit === undefined ? 5 : Number(input.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (input.limit !== undefined && !/^[0-9]+$/.test(String(input.limit)))) throw badRequest();
      const cursor = input.cursor === undefined ? null : decodeOrderCursor(input.cursor);
      const { rows } = await query(`SELECT ${columns} FROM public.orders o
        ${cursor ? 'WHERE (o.created_at,o.id)<($1::timestamptz,$2::uuid)' : ''}
        ORDER BY o.created_at DESC,o.id DESC LIMIT $${cursor ? 3 : 1}`,
        cursor ? [cursor.at, cursor.id, limit + 1] : [limit + 1]);
      const orders = rows.slice(0, limit);
      return { orders, nextCursor: rows.length > limit ? encodeOrderCursor(orders.at(-1)) : null };
    }
  };
}
export function mountDeviceOrderEvents(app, { query, requireDevice }) {
  const service = createDeviceOrderEvents({ query });
  function route(path, read) {
    app.get(path, async (req, res) => {
      try {
        if (!await requireDevice(req, res)) return;
        res.setHeader('Cache-Control', 'no-store');
        res.json(await read(req));
      } catch (error) {
        const status = error.status === 400 || error.status === 409 ? error.status : 503;
        res.status(status).json({ error: status === 400 ? 'Invalid order page' : status === 409 ? 'Current order queue exceeds device limit' : 'Order list is temporarily unavailable', ...(error.code === 'CURRENT_QUEUE_TOO_LARGE' ? { code: error.code } : {}) });
      }
    });
  }
  // Mount before /api/orders/:token. No write, notification, acceptance or payment side effects.
  route('/api/orders/current', () => service.current());
  route('/api/orders/history', req => service.history(req.query));
}
