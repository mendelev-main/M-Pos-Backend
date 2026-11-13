BEGIN;
ALTER TABLE public.orders ADD COLUMN ready_estimate text,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN status_changed_at timestamptz;
UPDATE public.orders SET status_changed_at=updated_at;
ALTER TABLE public.orders ALTER COLUMN status_changed_at SET DEFAULT now(),
  ALTER COLUMN status_changed_at SET NOT NULL;
ALTER TABLE public.orders ADD CONSTRAINT orders_ready_estimate_valid CHECK (
  ready_estimate IS NULL OR ready_estimate IN ('5m','15m','30m','40m','60plus')
  OR ready_estimate ~ '^at:([01][0-9]|2[0-3]):[0-5][0-9]$');
CREATE FUNCTION public.track_order_stage() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.status_changed_at=now();
 ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
  NEW.status_changed_at=now();
 ELSE
  NEW.status_changed_at=OLD.status_changed_at;
 END IF;
 IF NEW.status='accepted' AND NEW.accepted_at IS NULL THEN NEW.accepted_at=now(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER track_order_stage BEFORE INSERT OR UPDATE ON public.orders
 FOR EACH ROW EXECUTE FUNCTION public.track_order_stage();
REVOKE ALL ON FUNCTION public.track_order_stage() FROM PUBLIC;
CREATE INDEX orders_phone_current ON public.orders(phone,created_at DESC,id DESC);
COMMIT;
