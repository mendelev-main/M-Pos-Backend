-- Web gifts are authoritative on the server. Android acknowledges payment through
-- settledWebOrderIds in the trusted availability snapshot, never on order creation.
BEGIN;
ALTER TABLE public.orders ADD COLUMN delivery_fee_pending boolean NOT NULL DEFAULT false,
 ADD COLUMN discount_total numeric NOT NULL DEFAULT 0,
 ADD COLUMN web_loyalty boolean NOT NULL DEFAULT false,
 ADD COLUMN web_membership_version bigint,
 ADD COLUMN web_paid_at timestamptz;
ALTER TABLE public.order_items ADD COLUMN is_loyalty_reward boolean NOT NULL DEFAULT false,
 ADD COLUMN loyalty_program_id uuid REFERENCES public.loyalty_programs(id);
ALTER TABLE public.checkout_sessions ADD COLUMN request_id uuid, ADD COLUMN request_fingerprint text;
CREATE UNIQUE INDEX checkout_phone_request ON public.checkout_sessions(phone,request_id) WHERE request_id IS NOT NULL;
CREATE INDEX account_orders_phone_page ON public.orders(phone,created_at DESC,id DESC);
CREATE INDEX account_orders_customer_page ON public.orders(customer_id,created_at DESC,id DESC);

ALTER FUNCTION public.finalize_verified_checkout(text,text,text) RENAME TO finalize_verified_checkout_before_gifts;
REVOKE ALL ON FUNCTION public.finalize_verified_checkout_before_gifts(text,text,text) FROM PUBLIC,mpos_app;
CREATE FUNCTION public.finalize_verified_checkout(p_hash text,p_external_id text,p_tracking_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE checkout public.checkout_sessions;cid uuid;result jsonb;oid uuid;pid uuid;item public.order_items;balance bigint;discount numeric:=0;member_version bigint;
BEGIN
 SELECT * INTO checkout FROM public.checkout_sessions WHERE verification_token_hash=p_hash;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT id INTO cid FROM public.customers WHERE normalized_phone=checkout.phone;
 IF cid IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||cid::text,0));END IF;
 SELECT * INTO checkout FROM public.checkout_sessions WHERE verification_token_hash=p_hash FOR UPDATE;
 result=public.finalize_verified_checkout_before_gifts(p_hash,p_external_id,p_tracking_token);
 IF NOT coalesce((result->>'ok')::boolean,false) OR (result->>'duplicate')::boolean THEN RETURN result;END IF;
 oid=(result->>'orderId')::uuid;cid=(result->>'customerId')::uuid;
 SELECT version INTO member_version FROM public.loyalty_memberships WHERE customer_id=cid;
 UPDATE public.orders SET delivery_fee_pending=coalesce((checkout.order_payload->>'deliveryFeePending')::boolean,false),
 web_loyalty=true,web_membership_version=member_version WHERE id=oid;
 FOR pid IN SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(coalesce(checkout.order_payload->'giftProgramIds','[]'::jsonb)) ORDER BY 1 LOOP
  IF NOT public.loyalty_membership_active(cid) OR NOT EXISTS(SELECT 1 FROM public.loyalty_programs WHERE id=pid AND is_active) THEN RAISE EXCEPTION 'LOYALTY_GIFT_UNAVAILABLE';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(cid::text||':'||pid::text,0));
  SELECT rewards INTO balance FROM public.loyalty_balance(cid,pid);
  IF balance<1 THEN RAISE EXCEPTION 'LOYALTY_GIFT_UNAVAILABLE';END IF;
  SELECT i.* INTO item FROM public.order_items i WHERE i.order_id=oid AND NOT i.is_loyalty_reward AND i.quantity>=1
    AND EXISTS(SELECT 1 FROM public.loyalty_reward_products r WHERE r.program_id=pid AND (r.product_id=i.external_product_id OR r.product_id=i.product_id::text))
    ORDER BY i.price,i.product_id,i.id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LOYALTY_GIFT_UNAVAILABLE';END IF;
  IF item.quantity=1 THEN UPDATE public.order_items SET price=0,is_loyalty_reward=true,loyalty_program_id=pid WHERE id=item.id;
  ELSE
   UPDATE public.order_items SET quantity=quantity-1 WHERE id=item.id;
   INSERT INTO public.order_items(order_id,product_id,external_product_id,product_name,price,quantity,comment,is_loyalty_reward,loyalty_program_id)
   VALUES(oid,item.product_id,item.external_product_id,item.product_name,0,1,item.comment,true,pid);
  END IF;
  discount=discount+item.price;
  INSERT INTO public.loyalty_ledger(customer_id,program_id,order_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
  VALUES(cid,pid,oid,'REWARD_REDEEMED',0,-1,'web-gift:'||oid::text||':'||pid::text,jsonb_build_object('posOrderId','web:'||oid::text,'productId',item.product_id,'unitPrice',item.price));
 END LOOP;
 UPDATE public.orders SET total=total-discount,discount_total=discount WHERE id=oid;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.finalize_verified_checkout(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_verified_checkout(text,text,text) TO mpos_app;

ALTER FUNCTION public.store_availability_snapshot(uuid,bigint,timestamptz,jsonb,text[]) RENAME TO store_availability_snapshot_before_web_loyalty;
REVOKE ALL ON FUNCTION public.store_availability_snapshot_before_web_loyalty(uuid,bigint,timestamptz,jsonb,text[]) FROM PUBLIC,mpos_app;
CREATE FUNCTION public.store_availability_snapshot(p_device_id uuid,p_revision bigint,p_sampled_at timestamptz,p_items jsonb,p_settled_order_ids text[] DEFAULT '{}'::text[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE applied boolean;cid uuid;o public.orders;p public.loyalty_programs;earned integer;m public.loyalty_memberships;
BEGIN
 -- Match checkout/withdrawal lock ordering: customer, then inventory.
 FOR cid IN SELECT DISTINCT customer_id FROM public.orders WHERE id::text=ANY(p_settled_order_ids) AND web_loyalty AND customer_id IS NOT NULL ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||cid::text,0));
 END LOOP;
 applied=public.store_availability_snapshot_before_web_loyalty(p_device_id,p_revision,p_sampled_at,p_items,p_settled_order_ids);
 IF NOT applied THEN RETURN false;END IF;
 FOR o IN SELECT * FROM public.orders WHERE id::text=ANY(p_settled_order_ids) AND web_loyalty AND web_paid_at IS NULL
   AND status NOT IN ('cancelled','canceled') AND EXISTS(SELECT 1 FROM public.web_order_reservations r WHERE r.order_id=orders.id AND r.device_id=p_device_id) ORDER BY id FOR UPDATE LOOP
  SELECT * INTO m FROM public.loyalty_memberships WHERE customer_id=o.customer_id;
  IF m.status='active' AND m.expires_at>now() AND m.version=o.web_membership_version THEN
   FOR p IN SELECT * FROM public.loyalty_programs WHERE is_active ORDER BY id LOOP
    SELECT coalesce(sum(floor(i.quantity)),0)::integer INTO earned FROM public.order_items i WHERE i.order_id=o.id AND NOT i.is_loyalty_reward
     AND EXISTS(SELECT 1 FROM public.loyalty_earning_products e WHERE e.program_id=p.id AND (e.product_id=i.external_product_id OR e.product_id=i.product_id::text));
    IF earned>0 THEN PERFORM public.apply_loyalty_sale(o.customer_id,p.id,'web-paid:'||o.id::text||':'||p.id::text,'web:'||o.id::text,earned,0,p.required_quantity,1,m.version,now());END IF;
   END LOOP;
  END IF;
  UPDATE public.orders SET web_paid_at=now() WHERE id=o.id;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.store_availability_snapshot(uuid,bigint,timestamptz,jsonb,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_availability_snapshot(uuid,bigint,timestamptz,jsonb,text[]) TO mpos_app;

CREATE FUNCTION public.reverse_cancelled_web_loyalty() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.web_loyalty AND NEW.customer_id IS NOT NULL AND NEW.status IN ('cancelled','canceled') AND OLD.status NOT IN ('cancelled','canceled') THEN
  PERFORM public.apply_single_reward_reversal(NEW.customer_id,'web:'||NEW.id::text);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.reverse_cancelled_web_loyalty() FROM PUBLIC,mpos_app;
CREATE TRIGGER web_loyalty_cancelled AFTER UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION public.reverse_cancelled_web_loyalty();
COMMIT;
