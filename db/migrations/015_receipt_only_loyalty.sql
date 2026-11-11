-- Inventory settlement and receipt loyalty are separate messages for the same
-- Android sale. Only the durable receipt event may earn progress.
BEGIN;
CREATE OR REPLACE FUNCTION public.store_availability_snapshot(p_device_id uuid,p_revision bigint,p_sampled_at timestamptz,p_items jsonb,p_settled_order_ids text[] DEFAULT '{}'::text[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE applied boolean;
BEGIN
 applied=public.store_availability_snapshot_before_web_loyalty(p_device_id,p_revision,p_sampled_at,p_items,p_settled_order_ids);
 IF NOT applied THEN RETURN false;END IF;
 UPDATE public.orders o SET web_paid_at=coalesce(o.web_paid_at,now())
 WHERE o.id::text=ANY(p_settled_order_ids) AND o.web_loyalty AND o.status NOT IN ('cancelled','canceled')
 AND EXISTS(SELECT 1 FROM public.web_order_reservations r WHERE r.order_id=o.id AND r.device_id=p_device_id);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.store_availability_snapshot(uuid,bigint,timestamptz,jsonb,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_availability_snapshot(uuid,bigint,timestamptz,jsonb,text[]) TO mpos_app;
COMMIT;
