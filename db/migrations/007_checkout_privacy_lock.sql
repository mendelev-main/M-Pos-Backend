-- Lock customer consent before checkout upserts the customer row. This shares
-- the lock order used by sales, withdrawal, expiry and contact retirement.
BEGIN;
ALTER FUNCTION public.finalize_verified_checkout(text,text,text) RENAME TO finalize_verified_checkout_internal;
REVOKE ALL ON FUNCTION public.finalize_verified_checkout_internal(text,text,text) FROM PUBLIC,mpos_app;
CREATE FUNCTION public.finalize_verified_checkout(p_hash text,p_external_id text,p_tracking_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE checkout_phone text;cid uuid;
BEGIN
 SELECT phone INTO checkout_phone FROM public.checkout_sessions WHERE verification_token_hash=p_hash;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT id INTO cid FROM public.customers WHERE normalized_phone=checkout_phone;
 IF cid IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||cid::text,0));END IF;
 RETURN public.finalize_verified_checkout_internal(p_hash,p_external_id,p_tracking_token);
END $$;
REVOKE ALL ON FUNCTION public.finalize_verified_checkout(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_verified_checkout(text,text,text) TO mpos_app;
COMMIT;
