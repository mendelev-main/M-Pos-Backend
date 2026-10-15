-- Delivery tariffs are published only by the configured trusted POS device.
BEGIN;
CREATE TABLE IF NOT EXISTS public.delivery_tariffs (
 external_id text PRIMARY KEY,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
 amount numeric(9,2) NOT NULL CHECK(amount>=0),
 sort_order integer NOT NULL DEFAULT 0,
 is_active boolean NOT NULL DEFAULT TRUE,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.delivery_tariff_state (
 id boolean PRIMARY KEY DEFAULT TRUE CHECK(id),
 source_device_id uuid REFERENCES public.devices(id),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 published boolean NOT NULL DEFAULT FALSE,
 publication_id text,
 last_payload jsonb NOT NULL DEFAULT '[]'::jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.delivery_tariff_state(id) VALUES(TRUE) ON CONFLICT DO NOTHING;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_tariff_id text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_tariff_name text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS delivery_tariff_version bigint;
REVOKE ALL ON public.delivery_tariffs,public.delivery_tariff_state FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON public.delivery_tariffs TO mpos_app;
GRANT SELECT,UPDATE ON public.delivery_tariff_state TO mpos_app;

CREATE OR REPLACE FUNCTION public.finalize_verified_checkout(p_verification_token_hash text,p_external_id text,p_tracking_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $$
DECLARE checkout public.checkout_sessions;verification public.phone_verifications;customer public.customers;created_order public.orders;payload jsonb;item jsonb;
BEGIN
 SELECT * INTO checkout FROM public.checkout_sessions WHERE verification_token_hash=p_verification_token_hash FOR UPDATE; IF NOT FOUND THEN RETURN NULL; END IF;
 IF checkout.status='ORDER_CREATED' THEN RETURN jsonb_build_object('ok',true,'orderId',checkout.order_id,'customerId',(SELECT customer_id FROM public.orders WHERE id=checkout.order_id),'duplicate',true); END IF;
 IF checkout.status<>'PENDING' OR checkout.expires_at<=now() THEN RAISE EXCEPTION 'CHECKOUT_EXPIRED' USING errcode='P0001'; END IF;
 SELECT * INTO verification FROM public.phone_verifications WHERE token_hash=p_verification_token_hash FOR UPDATE;
 IF NOT FOUND OR verification.status<>'VERIFIED' OR verification.phone<>checkout.phone OR verification.expires_at<=now() THEN RAISE EXCEPTION 'VERIFICATION_NOT_READY' USING errcode='P0001'; END IF;
 payload=checkout.order_payload; IF jsonb_typeof(payload->'items')<>'array' OR jsonb_array_length(payload->'items')=0 THEN RAISE EXCEPTION 'ORDER_ITEMS_REQUIRED' USING errcode='P0001'; END IF;
 INSERT INTO public.customers(name,normalized_phone,telegram_user_id,updated_at) VALUES(coalesce(nullif(trim(payload->>'customerName'),''),'Гость'),checkout.phone,verification.telegram_user_id,now())
 ON CONFLICT(normalized_phone) DO UPDATE SET name=excluded.name,telegram_user_id=coalesce(excluded.telegram_user_id,public.customers.telegram_user_id),updated_at=now() RETURNING * INTO customer;
 INSERT INTO public.orders(external_id,tracking_token,status,order_type,customer_name,phone,customer_id,address,comment,total,delivery_fee,delivery_tariff_id,delivery_tariff_name,delivery_tariff_version)
 VALUES(p_external_id,p_tracking_token,'new',payload->>'orderType',payload->>'customerName',checkout.phone,customer.id,nullif(payload->>'address',''),nullif(payload->>'comment',''),coalesce((payload->>'total')::numeric,0),coalesce((payload->>'fee')::numeric,0),payload->'deliveryTariff'->>'id',payload->'deliveryTariff'->>'name',(payload->'deliveryTariff'->>'version')::bigint) RETURNING * INTO created_order;
 PERFORM public.reserve_web_order_items(created_order.id,payload->'items');
 FOR item IN SELECT value FROM jsonb_array_elements(payload->'items') LOOP INSERT INTO public.order_items(order_id,product_id,external_product_id,product_name,price,quantity,comment)
 VALUES(created_order.id,nullif(item->>'product_id','')::uuid,item->>'external_product_id',item->>'product_name',(item->>'price')::numeric,(item->>'quantity')::numeric,nullif(item->>'comment','')); END LOOP;
 UPDATE public.phone_verifications SET status='CONSUMED',consumed_at=now() WHERE id=verification.id;
 UPDATE public.checkout_sessions SET status='ORDER_CREATED',verified_at=verification.verified_at,order_id=created_order.id,tracking_token=p_tracking_token,telegram_user_id=verification.telegram_user_id,updated_at=now() WHERE id=checkout.id;
 RETURN jsonb_build_object('ok',true,'orderId',created_order.id,'customerId',customer.id,'duplicate',false);
END $$;
COMMIT;
