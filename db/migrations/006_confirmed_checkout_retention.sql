-- Confirmed checkout contacts support service messages until order closure.
BEGIN;
CREATE OR REPLACE FUNCTION public.privacy_retention_report() RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
SELECT jsonb_build_object(
 'expiredCheckouts',(SELECT count(*) FROM public.checkout_sessions WHERE (status<>'ORDER_CREATED' OR order_id IS NULL OR EXISTS(SELECT 1 FROM public.orders retained_order WHERE retained_order.id=public.checkout_sessions.order_id AND retained_order.privacy_redacted_at IS NOT NULL)) AND expires_at<now()-interval '24 hours'),
 'expiredVerifications',(SELECT count(*) FROM public.phone_verifications WHERE expires_at<now()-interval '24 hours'),
 'profileContactsDue',(SELECT count(*) FROM public.loyalty_memberships m JOIN public.customers c ON c.id=m.customer_id WHERE m.status IN ('withdrawn','expired') AND m.revoked_at<now()-interval '14 days' AND c.privacy_retired_at IS NULL),
 'tabletsReady',(SELECT count(*) FROM public.privacy_devices WHERE protocol_version>=1),
 'expiredMemberships',(SELECT count(*) FROM public.loyalty_memberships WHERE status='active' AND expires_at<=now()),
 'orderContactsDue',(SELECT count(*) FROM public.orders WHERE privacy_redacted_at IS NULL AND privacy_closed_at<now()-interval '30 days' AND (privacy_hold_until IS NULL OR privacy_hold_until<now())),
 'orderContactDeletionEnabled',(SELECT apply_order_contacts FROM public.privacy_retention_state WHERE id=true),
 'unacknowledgedDeviceTasks',(SELECT count(*) FROM public.privacy_pos_tasks t CROSS JOIN public.devices d WHERE d.is_active AND NOT EXISTS(SELECT 1 FROM public.privacy_pos_task_receipts r WHERE r.task_id=t.id AND r.device_id=d.id))
) $$;
CREATE OR REPLACE FUNCTION public.run_privacy_retention(p_apply boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE c record;o record;report jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy-retention',0));
 report=public.privacy_retention_report();
 IF p_apply THEN
  -- Bounded batches; timestamps are expiry rather than last UI poll.
  DELETE FROM public.privacy_access_sessions WHERE id IN(SELECT id FROM public.privacy_access_sessions WHERE expires_at<now()-interval '24 hours' ORDER BY expires_at LIMIT 500);
  DELETE FROM public.checkout_sessions WHERE id IN(SELECT id FROM public.checkout_sessions WHERE (status<>'ORDER_CREATED' OR order_id IS NULL OR EXISTS(SELECT 1 FROM public.orders retained_order WHERE retained_order.id=public.checkout_sessions.order_id AND retained_order.privacy_redacted_at IS NOT NULL)) AND expires_at<now()-interval '24 hours' ORDER BY expires_at LIMIT 500);
  DELETE FROM public.phone_verifications WHERE id IN(SELECT v.id FROM public.phone_verifications v WHERE v.expires_at<now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM public.checkout_sessions s WHERE s.verification_token_hash=v.token_hash) AND NOT EXISTS(SELECT 1 FROM public.privacy_access_sessions a WHERE a.verification_token_hash=v.token_hash) ORDER BY v.expires_at LIMIT 500);
  FOR c IN SELECT customer_id FROM public.loyalty_memberships WHERE status='active' AND expires_at<=now() ORDER BY expires_at LIMIT 500 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||c.customer_id::text,0));
   UPDATE public.loyalty_memberships SET status='expired',version=version+1,revoked_at=now() WHERE customer_id=c.customer_id AND status='active' AND expires_at<=now();
   IF FOUND THEN INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
 SELECT l.customer_id,l.program_id,'MANUAL_ADJUSTMENT',(-sum(l.progress_delta))::integer,(-sum(l.reward_delta))::integer,
 'privacy-close:'||l.customer_id::text||':'||membership_row.version::text||':'||l.program_id::text||'',
 jsonb_build_object('reason','membership_terminated','membershipVersion',membership_row.version)
 FROM public.loyalty_ledger l JOIN public.loyalty_memberships membership_row ON membership_row.customer_id=l.customer_id
 WHERE l.customer_id=c.customer_id GROUP BY l.customer_id,l.program_id,membership_row.version
 HAVING sum(l.progress_delta)<>0 OR sum(l.reward_delta)<>0 ON CONFLICT(idempotency_key) DO NOTHING;
   INSERT INTO public.privacy_events(customer_id,event_type,document_version) SELECT customer_id,'loyalty_expired',document_version FROM public.loyalty_memberships WHERE customer_id=c.customer_id;INSERT INTO public.privacy_pos_tasks(customer_id,membership_version,task_type) SELECT c.customer_id,version,'stop_loyalty' FROM public.loyalty_memberships WHERE customer_id=c.customer_id;END IF;
  END LOOP;
  FOR c IN SELECT m.customer_id FROM public.loyalty_memberships m JOIN public.customers x ON x.id=m.customer_id WHERE m.status IN ('withdrawn','expired') AND m.revoked_at<now()-interval '14 days' AND x.privacy_retired_at IS NULL ORDER BY m.revoked_at LIMIT 500 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||c.customer_id::text,0));
   IF EXISTS(SELECT 1 FROM public.loyalty_memberships WHERE customer_id=c.customer_id AND status IN ('withdrawn','expired') AND revoked_at<now()-interval '14 days') THEN
    UPDATE public.customers SET name='Удалённый участник',normalized_phone='retired:'||id::text,telegram_user_id=NULL,telegram_username=NULL,last_purchase_at=NULL,privacy_retired_at=now(),updated_at=now() WHERE id=c.customer_id;
    INSERT INTO public.privacy_pos_tasks(customer_id,task_type) VALUES(c.customer_id,'redact_customer');
   END IF;
  END LOOP;
  IF (SELECT apply_order_contacts FROM public.privacy_retention_state WHERE id=true) THEN
   FOR o IN SELECT id,external_id FROM public.orders WHERE privacy_redacted_at IS NULL AND privacy_closed_at<now()-interval '30 days' AND (privacy_hold_until IS NULL OR privacy_hold_until<now()) ORDER BY privacy_closed_at LIMIT 200 FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.orders SET customer_name=NULL,phone=NULL,address=NULL,comment=NULL,customer_id=NULL,tracking_token=NULL,privacy_redacted_at=now() WHERE id=o.id;
    UPDATE public.order_items SET comment=NULL WHERE order_id=o.id;
    DELETE FROM public.phone_verifications verification USING public.checkout_sessions session_row
     WHERE session_row.order_id=o.id AND verification.token_hash=session_row.verification_token_hash
     AND NOT EXISTS(SELECT 1 FROM public.privacy_access_sessions access_row WHERE access_row.verification_token_hash=verification.token_hash);
    DELETE FROM public.checkout_sessions WHERE order_id=o.id;
    INSERT INTO public.privacy_pos_tasks(order_external_id,order_id,task_type) VALUES(o.external_id,o.id,'redact_order');
   END LOOP;
  END IF;
  -- Order-only profiles are not loyalty enrollment. Once every operational order
  -- has been redacted, remove their otherwise orphaned contact record as well.
  FOR c IN SELECT x.id AS customer_id FROM public.customers x WHERE x.privacy_retired_at IS NULL AND x.updated_at<now()-interval '30 days'
   AND NOT EXISTS(SELECT 1 FROM public.loyalty_memberships m WHERE m.customer_id=x.id)
   AND NOT EXISTS(SELECT 1 FROM public.loyalty_ledger l WHERE l.customer_id=x.id)
   AND NOT EXISTS(SELECT 1 FROM public.orders order_row WHERE order_row.customer_id=x.id)
   ORDER BY x.updated_at LIMIT 500 FOR UPDATE SKIP LOCKED LOOP
   UPDATE public.customers SET name='Удалённый клиент',normalized_phone='retired:'||id::text,telegram_user_id=NULL,telegram_username=NULL,last_purchase_at=NULL,privacy_retired_at=now(),updated_at=now() WHERE id=c.customer_id;
   INSERT INTO public.privacy_pos_tasks(customer_id,task_type) VALUES(c.customer_id,'redact_customer');
  END LOOP;
 END IF;
 UPDATE public.privacy_retention_state SET last_run_at=now(),last_report=report||jsonb_build_object('applied',p_apply) WHERE id=true;
 RETURN report||jsonb_build_object('applied',p_apply);
END $$;
COMMIT;
