-- Shared POS order history uses a stable created_at/id cursor, without OFFSET/full-history reads.
BEGIN;
CREATE INDEX IF NOT EXISTS orders_device_history_page ON public.orders(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS orders_device_pending_page ON public.orders(created_at DESC,id DESC)
 WHERE status='new' AND web_paid_at IS NULL;
COMMIT;
