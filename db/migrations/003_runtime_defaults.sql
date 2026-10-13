BEGIN;

INSERT INTO public.customer_notification_settings (id, enabled_at)
VALUES (true, now())
ON CONFLICT (id) DO UPDATE
SET enabled_at = COALESCE(public.customer_notification_settings.enabled_at, EXCLUDED.enabled_at);

COMMIT;
