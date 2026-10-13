-- Native PostgreSQL 17 baseline for M-Pos Backend.
-- Source: final production Supabase schema audited 2026-10-13.
-- Run as mpos_admin against an EMPTY mpos database.
-- Supabase RLS/service_role/APNs legacy objects are intentionally excluded.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  color text,
  sort_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  external_id text,
  available_online boolean NOT NULL DEFAULT true,
  visible_in_menu boolean NOT NULL DEFAULT true
);

CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  price numeric NOT NULL DEFAULT 0,
  category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  image_url text,
  sort_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  available_online boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  external_id text,
  visible_in_menu boolean NOT NULL DEFAULT true
);

CREATE TABLE public.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  device_key text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  telegram_order_chat_id text,
  notify_online_orders boolean NOT NULL DEFAULT false,
  telegram_owner_chat_id text,
  CONSTRAINT devices_telegram_order_chat_id_format CHECK (telegram_order_chat_id IS NULL OR telegram_order_chat_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT devices_telegram_owner_chat_id_format CHECK (telegram_owner_chat_id IS NULL OR telegram_owner_chat_id ~ '^[0-9]{1,20}$')
);

CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_phone text NOT NULL UNIQUE,
  telegram_user_id text,
  telegram_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_purchase_at timestamptz
);

CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text,
  status text NOT NULL DEFAULT 'new',
  order_type text,
  customer_name text,
  phone text,
  address text,
  comment text,
  total numeric NOT NULL DEFAULT 0,
  delivery_fee numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  tracking_token text,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL
);

CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES public.products(id) ON DELETE SET NULL,
  external_product_id text,
  product_name text NOT NULL,
  price numeric NOT NULL DEFAULT 0,
  quantity numeric NOT NULL DEFAULT 1,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.phone_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  phone text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','CONSUMED','EXPIRED')),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  consumed_at timestamptz,
  telegram_user_id text,
  return_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  telegram_username text,
  telegram_username_observed boolean NOT NULL DEFAULT false
);

CREATE TABLE public.checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  phone text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','ORDER_CREATED','EXPIRED')),
  order_payload jsonb NOT NULL,
  verification_token_hash text,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  tracking_token text,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  telegram_user_id text
);

CREATE TABLE public.operational_states (
  device_id uuid PRIMARY KEY REFERENCES public.devices(id) ON DELETE CASCADE,
  schema_version integer NOT NULL,
  engine_version integer,
  heartbeat_at timestamptz,
  snapshot_sampled_at timestamptz,
  snapshot_received_at timestamptz,
  snapshot jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  snapshot_revision bigint NOT NULL DEFAULT 0
);

CREATE TABLE public.loyalty_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  required_quantity integer NOT NULL CHECK (required_quantity > 0),
  reward_quantity integer NOT NULL DEFAULT 1 CHECK (reward_quantity > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loyalty_programs_single_reward CHECK (reward_quantity = 1)
);

CREATE TABLE public.loyalty_earning_products (
  program_id uuid NOT NULL REFERENCES public.loyalty_programs(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  PRIMARY KEY (program_id, product_id)
);

CREATE TABLE public.loyalty_reward_products (
  program_id uuid NOT NULL REFERENCES public.loyalty_programs(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  PRIMARY KEY (program_id, product_id)
);

CREATE TABLE public.loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  program_id uuid NOT NULL REFERENCES public.loyalty_programs(id) ON DELETE RESTRICT,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  operation_type text NOT NULL CHECK (operation_type IN ('EARN','REWARD_GRANTED','REWARD_REDEEMED','REVERSAL','MANUAL_ADJUSTMENT')),
  progress_delta integer NOT NULL DEFAULT 0,
  reward_delta integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.availability_states (
  device_id uuid PRIMARY KEY REFERENCES public.devices(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  sampled_at timestamptz,
  received_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.product_availability (
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  external_product_id text NOT NULL,
  quantity numeric CHECK (quantity IS NULL OR quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, external_product_id)
);

CREATE TABLE public.web_order_reservations (
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  external_product_id text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (order_id, external_product_id)
);

CREATE TABLE public.customer_notification_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled_at timestamptz
);

CREATE TABLE public.customer_order_notifications (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','uncertain','retry','rejected')),
  claim_token uuid,
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  telegram_message_id bigint
);

-- Production indexes (PK/UNIQUE indexes above are created by constraints).
CREATE UNIQUE INDEX categories_external_id_idx ON public.categories(external_id);
CREATE INDEX categories_online_menu_idx ON public.categories(sort_order,name) WHERE is_active=true AND visible_in_menu=true;
CREATE INDEX categories_online_order_idx ON public.categories(sort_order,name) WHERE is_active=true AND available_online=true;
CREATE UNIQUE INDEX products_external_id_idx ON public.products(external_id);
CREATE INDEX products_visible_online_menu_idx ON public.products(category_id,sort_order,name) WHERE is_active=true AND visible_in_menu=true;
CREATE UNIQUE INDEX devices_device_key_idx ON public.devices(device_key);
CREATE UNIQUE INDEX orders_external_id_idx ON public.orders(external_id);
CREATE UNIQUE INDEX orders_tracking_token_idx ON public.orders(tracking_token) WHERE tracking_token IS NOT NULL;
CREATE INDEX orders_customer_id_idx ON public.orders(customer_id);
CREATE INDEX phone_verifications_expires_at_idx ON public.phone_verifications(expires_at);
CREATE INDEX phone_verifications_phone_idx ON public.phone_verifications(phone);
CREATE INDEX checkout_sessions_expires_at_idx ON public.checkout_sessions(expires_at);
CREATE INDEX checkout_sessions_phone_idx ON public.checkout_sessions(phone);
CREATE INDEX checkout_sessions_telegram_user_id_idx ON public.checkout_sessions(telegram_user_id);
CREATE INDEX operational_states_heartbeat_at_idx ON public.operational_states(heartbeat_at DESC);
CREATE UNIQUE INDEX customers_telegram_user_id_uidx ON public.customers(telegram_user_id) WHERE telegram_user_id IS NOT NULL;
CREATE INDEX customers_name_idx ON public.customers(lower(name));
CREATE INDEX loyalty_ledger_customer_program_idx ON public.loyalty_ledger(customer_id,program_id,created_at);
CREATE INDEX web_order_reservations_open_product_idx ON public.web_order_reservations(device_id,external_product_id) WHERE settled_at IS NULL;
CREATE INDEX customer_order_notifications_due ON public.customer_order_notifications(next_attempt_at) WHERE state IN ('pending','retry');

-- Missing FK indexes reported by the Supabase advisor; included in the native baseline.
CREATE INDEX checkout_sessions_order_id_idx ON public.checkout_sessions(order_id);
CREATE INDEX loyalty_ledger_order_id_idx ON public.loyalty_ledger(order_id);
CREATE INDEX loyalty_ledger_program_id_idx ON public.loyalty_ledger(program_id);
CREATE INDEX order_items_order_id_idx ON public.order_items(order_id);
CREATE INDEX order_items_product_id_idx ON public.order_items(product_id);

CREATE OR REPLACE FUNCTION public.loyalty_balance(p_customer_id uuid,p_program_id uuid)
RETURNS TABLE(progress bigint,rewards bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $$ SELECT coalesce(sum(progress_delta),0)::bigint,coalesce(sum(reward_delta),0)::bigint FROM public.loyalty_ledger WHERE customer_id=p_customer_id AND program_id=p_program_id $$;

CREATE OR REPLACE FUNCTION public.apply_loyalty_sale(
 p_customer_id uuid,p_program_id uuid,p_idempotency_key text,p_pos_order_id text,
 p_earned integer,p_redeem integer,p_required integer,p_reward_each integer)
RETURNS TABLE(duplicate boolean,progress bigint,rewards bigint,granted integer,redeemed integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE cur_progress bigint; cur_rewards bigint; redeem_count integer; remaining_rewards bigint; combined bigint; new_progress bigint; grant_count integer; progress_change bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text||':'||p_program_id::text,0));
 IF EXISTS(SELECT 1 FROM public.loyalty_ledger WHERE idempotency_key IN (p_idempotency_key,p_idempotency_key||':earn',p_idempotency_key||':grant',p_idempotency_key||':redeem')) THEN
  SELECT coalesce(sum(progress_delta),0),coalesce(sum(reward_delta),0) INTO cur_progress,cur_rewards FROM public.loyalty_ledger WHERE customer_id=p_customer_id AND program_id=p_program_id;
  RETURN QUERY SELECT true,cur_progress,cur_rewards,0,0; RETURN;
 END IF;
 SELECT coalesce(sum(progress_delta),0),coalesce(sum(reward_delta),0) INTO cur_progress,cur_rewards FROM public.loyalty_ledger WHERE customer_id=p_customer_id AND program_id=p_program_id;
 redeem_count:=greatest(p_redeem,0);
 IF redeem_count>cur_rewards OR redeem_count>1 THEN RAISE EXCEPTION 'INSUFFICIENT_LOYALTY_REWARDS' USING errcode='P0001'; END IF;
 remaining_rewards:=cur_rewards-redeem_count; combined:=greatest(cur_progress,0)+greatest(p_earned,0);
 IF remaining_rewards>0 THEN new_progress:=0;grant_count:=0;
 ELSIF combined>=greatest(p_required,1) THEN new_progress:=0;grant_count:=1;
 ELSE new_progress:=combined;grant_count:=0; END IF;
 progress_change:=new_progress-cur_progress;
 IF greatest(p_earned,0)>0 THEN INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
 VALUES(p_customer_id,p_program_id,'EARN',progress_change,0,p_idempotency_key||':earn',jsonb_build_object('posOrderId',p_pos_order_id,'earned',greatest(p_earned,0),'frozen',remaining_rewards>0)); END IF;
 IF grant_count>0 THEN INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
 VALUES(p_customer_id,p_program_id,'REWARD_GRANTED',0,1,p_idempotency_key||':grant',jsonb_build_object('posOrderId',p_pos_order_id,'granted',1)); END IF;
 IF redeem_count>0 THEN INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
 VALUES(p_customer_id,p_program_id,'REWARD_REDEEMED',0,-redeem_count,p_idempotency_key||':redeem',jsonb_build_object('posOrderId',p_pos_order_id,'redeemed',redeem_count)); END IF;
 RETURN QUERY SELECT false,new_progress,least(1::bigint,remaining_rewards+grant_count),grant_count,redeem_count;
END $$;

CREATE OR REPLACE FUNCTION public.apply_single_reward_adjustment(
 p_customer_id uuid,p_program_id uuid,p_progress_delta integer,p_reward_delta integer,p_idempotency_key text,p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(progress bigint,rewards bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE cur_progress bigint;cur_rewards bigint;next_progress bigint;next_rewards bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text||':'||p_program_id::text,0));
 SELECT coalesce(sum(progress_delta),0),coalesce(sum(reward_delta),0) INTO cur_progress,cur_rewards FROM public.loyalty_ledger WHERE customer_id=p_customer_id AND program_id=p_program_id;
 next_progress:=cur_progress+p_progress_delta;next_rewards:=cur_rewards+p_reward_delta;
 IF next_rewards<0 OR next_rewards>1 OR next_progress<0 OR (next_rewards=1 AND next_progress<>0) THEN RAISE EXCEPTION 'INVALID_SINGLE_REWARD_BALANCE' USING errcode='P0001'; END IF;
 INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
 VALUES(p_customer_id,p_program_id,'MANUAL_ADJUSTMENT',p_progress_delta,p_reward_delta,p_idempotency_key,coalesce(p_metadata,'{}'::jsonb));
 RETURN QUERY SELECT next_progress,next_rewards;
END $$;

CREATE OR REPLACE FUNCTION public.apply_single_reward_reversal(p_customer_id uuid,p_pos_order_id text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE source_row record;program_row record;inserted_rows integer;reversed_count integer:=0;cur_progress bigint;cur_rewards bigint;correction_progress bigint;correction_rewards bigint;
BEGIN
 FOR source_row IN SELECT id,program_id,operation_type,progress_delta,reward_delta FROM public.loyalty_ledger WHERE customer_id=p_customer_id AND metadata->>'posOrderId'=p_pos_order_id AND coalesce(metadata->>'reversalOf','')='' ORDER BY created_at,id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text||':'||source_row.program_id::text,0));
  INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
  VALUES(p_customer_id,source_row.program_id,'REVERSAL',-source_row.progress_delta,-source_row.reward_delta,'order:'||p_pos_order_id||':program:'||source_row.program_id::text||':reversal:'||source_row.id::text,jsonb_build_object('posOrderId',p_pos_order_id,'reversalOf',source_row.id,'reversalType',source_row.operation_type))
  ON CONFLICT(idempotency_key) DO NOTHING; GET DIAGNOSTICS inserted_rows=ROW_COUNT; reversed_count:=reversed_count+inserted_rows;
 END LOOP;
 FOR program_row IN SELECT DISTINCT program_id FROM public.loyalty_ledger WHERE customer_id=p_customer_id AND metadata->>'posOrderId'=p_pos_order_id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text||':'||program_row.program_id::text,0));
  SELECT coalesce(sum(progress_delta),0),coalesce(sum(reward_delta),0) INTO cur_progress,cur_rewards FROM public.loyalty_ledger WHERE customer_id=p_customer_id AND program_id=program_row.program_id;
  correction_rewards:=CASE WHEN cur_rewards>1 THEN 1-cur_rewards WHEN cur_rewards<0 THEN -cur_rewards ELSE 0 END;
  correction_progress:=CASE WHEN cur_rewards+correction_rewards>0 THEN -cur_progress ELSE 0 END;
  IF correction_progress<>0 OR correction_rewards<>0 THEN
   INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
   VALUES(p_customer_id,program_row.program_id,'MANUAL_ADJUSTMENT',correction_progress,correction_rewards,'order:'||p_pos_order_id||':program:'||program_row.program_id::text||':reversal-normalize',jsonb_build_object('posOrderId',p_pos_order_id,'reason','Нормализация одного подарка после возврата')) ON CONFLICT(idempotency_key) DO NOTHING;
  END IF;
 END LOOP;
 RETURN reversed_count;
END $$;

CREATE OR REPLACE FUNCTION public.replace_loyalty_program(p_program_id uuid,p_name text,p_required integer,p_reward integer,p_is_active boolean,p_earning_ids text[],p_reward_ids text[])
RETURNS public.loyalty_programs LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $$
DECLARE updated public.loyalty_programs;
BEGIN
 IF nullif(trim(p_name),'') IS NULL OR p_required<1 OR p_reward<1 OR coalesce(array_length(p_earning_ids,1),0)=0 OR coalesce(array_length(p_reward_ids,1),0)=0 THEN RAISE EXCEPTION 'INVALID_LOYALTY_PROGRAM' USING errcode='P0001'; END IF;
 PERFORM 1 FROM public.loyalty_programs WHERE id=p_program_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'LOYALTY_PROGRAM_NOT_FOUND' USING errcode='P0001'; END IF;
 UPDATE public.loyalty_programs SET name=trim(p_name),required_quantity=p_required,reward_quantity=p_reward,is_active=p_is_active,updated_at=now() WHERE id=p_program_id RETURNING * INTO updated;
 DELETE FROM public.loyalty_earning_products WHERE program_id=p_program_id; DELETE FROM public.loyalty_reward_products WHERE program_id=p_program_id;
 INSERT INTO public.loyalty_earning_products(program_id,product_id) SELECT p_program_id,value FROM unnest(p_earning_ids) value;
 INSERT INTO public.loyalty_reward_products(program_id,product_id) SELECT p_program_id,value FROM unnest(p_reward_ids) value;
 RETURN updated;
END $$;

CREATE OR REPLACE FUNCTION public.store_operational_snapshot(p_device_id uuid,p_schema_version integer,p_engine_version integer,p_revision bigint,p_sampled_at timestamptz,p_received_at timestamptz,p_snapshot jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE applied boolean:=false;
BEGIN
 INSERT INTO public.operational_states(device_id,schema_version,engine_version,heartbeat_at,snapshot_sampled_at,snapshot_received_at,snapshot_revision,snapshot,updated_at)
 VALUES(p_device_id,p_schema_version,p_engine_version,p_received_at,p_sampled_at,p_received_at,p_revision,p_snapshot,p_received_at)
 ON CONFLICT(device_id) DO UPDATE SET schema_version=excluded.schema_version,engine_version=excluded.engine_version,heartbeat_at=excluded.heartbeat_at,snapshot_sampled_at=excluded.snapshot_sampled_at,snapshot_received_at=excluded.snapshot_received_at,snapshot_revision=excluded.snapshot_revision,snapshot=excluded.snapshot,updated_at=excluded.updated_at
 WHERE public.operational_states.snapshot_revision<excluded.snapshot_revision;
 GET DIAGNOSTICS applied=ROW_COUNT; RETURN applied;
END $$;

CREATE OR REPLACE FUNCTION public.store_availability_snapshot(p_device_id uuid,p_revision bigint,p_sampled_at timestamptz,p_items jsonb,p_settled_order_ids text[] DEFAULT '{}'::text[])
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $$
DECLARE current_revision bigint;
BEGIN
 IF p_revision<=0 OR p_sampled_at IS NULL OR jsonb_typeof(p_items)<>'array' THEN RAISE EXCEPTION 'INVALID_AVAILABILITY_SNAPSHOT' USING errcode='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) item WHERE nullif(trim(item->>'externalId'),'') IS NULL OR NOT(item?'quantity') OR NOT(jsonb_typeof(item->'quantity') IN ('number','null')) OR (jsonb_typeof(item->'quantity')='number' AND (item->>'quantity')::numeric<0))
 OR EXISTS(SELECT item->>'externalId' FROM jsonb_array_elements(p_items) item GROUP BY item->>'externalId' HAVING count(*)>1)
 THEN RAISE EXCEPTION 'INVALID_AVAILABILITY_ITEM' USING errcode='P0001'; END IF;
 INSERT INTO public.availability_states(device_id,revision) VALUES(p_device_id,0) ON CONFLICT(device_id) DO NOTHING;
 SELECT revision INTO current_revision FROM public.availability_states WHERE device_id=p_device_id FOR UPDATE; IF p_revision<=current_revision THEN RETURN false; END IF;
 UPDATE public.web_order_reservations SET settled_at=coalesce(settled_at,now()) WHERE device_id=p_device_id AND settled_at IS NULL AND order_id::text=ANY(coalesce(p_settled_order_ids,'{}'::text[]));
 DELETE FROM public.product_availability WHERE device_id=p_device_id;
 INSERT INTO public.product_availability(device_id,external_product_id,quantity,updated_at)
 SELECT p_device_id,trim(item->>'externalId'),CASE WHEN jsonb_typeof(item->'quantity')='null' THEN NULL ELSE (item->>'quantity')::numeric END,now() FROM jsonb_array_elements(p_items) item;
 UPDATE public.availability_states SET revision=p_revision,sampled_at=p_sampled_at,received_at=now(),updated_at=now() WHERE device_id=p_device_id; RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.get_web_availability()
RETURNS TABLE(external_product_id text,quantity numeric) LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $$
 WITH active_device AS (SELECT (array_agg(id ORDER BY id))[1] device_id FROM public.devices WHERE is_active=true HAVING count(*)=1),
 reserved AS (SELECT r.device_id,r.external_product_id,sum(r.quantity) quantity FROM public.web_order_reservations r WHERE r.settled_at IS NULL GROUP BY r.device_id,r.external_product_id)
 SELECT a.external_product_id,CASE WHEN a.quantity IS NULL THEN NULL ELSE greatest(0,a.quantity-coalesce(r.quantity,0)) END
 FROM public.product_availability a JOIN active_device d ON d.device_id=a.device_id LEFT JOIN reserved r ON r.device_id=a.device_id AND r.external_product_id=a.external_product_id
$$;

CREATE OR REPLACE FUNCTION public.reserve_web_order_items(p_order_id uuid,p_items jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $$
DECLARE active_device_id uuid;active_device_count integer;item jsonb;requested numeric;physical numeric;reserved numeric;
BEGIN
 SELECT count(*)::integer,(array_agg(id ORDER BY id))[1] INTO active_device_count,active_device_id FROM public.devices WHERE is_active=true;
 IF active_device_count<>1 THEN RAISE EXCEPTION 'AVAILABILITY_UNAVAILABLE' USING errcode='P0001'; END IF;
 PERFORM 1 FROM public.availability_states WHERE device_id=active_device_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'AVAILABILITY_UNAVAILABLE' USING errcode='P0001'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) ORDER BY value->>'external_product_id' LOOP
  requested=(item->>'quantity')::numeric;
  SELECT quantity INTO physical FROM public.product_availability WHERE device_id=active_device_id AND external_product_id=item->>'external_product_id' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AVAILABILITY_UNAVAILABLE' USING errcode='P0001'; END IF;
  IF physical IS NOT NULL THEN SELECT coalesce(sum(quantity),0) INTO reserved FROM public.web_order_reservations WHERE device_id=active_device_id AND external_product_id=item->>'external_product_id' AND settled_at IS NULL;
   IF requested>greatest(0,physical-reserved) THEN RAISE EXCEPTION 'OUT_OF_STOCK:%',item->>'external_product_id' USING errcode='P0001'; END IF;
  END IF;
  INSERT INTO public.web_order_reservations(order_id,device_id,external_product_id,quantity) VALUES(p_order_id,active_device_id,item->>'external_product_id',requested);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.create_web_order(p_external_id text,p_tracking_token text,p_order_type text,p_customer_name text,p_phone text,p_address text,p_comment text,p_total numeric,p_delivery_fee numeric,p_items jsonb)
RETURNS public.orders LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $$
DECLARE created public.orders;item jsonb;
BEGIN
 IF jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items)=0 THEN RAISE EXCEPTION 'ORDER_ITEMS_REQUIRED' USING errcode='P0001'; END IF;
 INSERT INTO public.orders(external_id,tracking_token,status,order_type,customer_name,phone,address,comment,total,delivery_fee) VALUES(p_external_id,p_tracking_token,'new',p_order_type,p_customer_name,p_phone,p_address,p_comment,p_total,p_delivery_fee) RETURNING * INTO created;
 PERFORM public.reserve_web_order_items(created.id,p_items);
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  INSERT INTO public.order_items(order_id,product_id,external_product_id,product_name,price,quantity,comment) VALUES(created.id,nullif(item->>'product_id','')::uuid,item->>'external_product_id',item->>'product_name',(item->>'price')::numeric,(item->>'quantity')::numeric,nullif(item->>'comment',''));
 END LOOP; RETURN created;
END $$;

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
 INSERT INTO public.orders(external_id,tracking_token,status,order_type,customer_name,phone,customer_id,address,comment,total,delivery_fee)
 VALUES(p_external_id,p_tracking_token,'new',payload->>'orderType',payload->>'customerName',checkout.phone,customer.id,nullif(payload->>'address',''),nullif(payload->>'comment',''),coalesce((payload->>'total')::numeric,0),coalesce((payload->>'fee')::numeric,0)) RETURNING * INTO created_order;
 PERFORM public.reserve_web_order_items(created_order.id,payload->'items');
 FOR item IN SELECT value FROM jsonb_array_elements(payload->'items') LOOP INSERT INTO public.order_items(order_id,product_id,external_product_id,product_name,price,quantity,comment)
 VALUES(created_order.id,nullif(item->>'product_id','')::uuid,item->>'external_product_id',item->>'product_name',(item->>'price')::numeric,(item->>'quantity')::numeric,nullif(item->>'comment','')); END LOOP;
 UPDATE public.phone_verifications SET status='CONSUMED',consumed_at=now() WHERE id=verification.id;
 UPDATE public.checkout_sessions SET status='ORDER_CREATED',verified_at=verification.verified_at,order_id=created_order.id,tracking_token=p_tracking_token,telegram_user_id=verification.telegram_user_id,updated_at=now() WHERE id=checkout.id;
 RETURN jsonb_build_object('ok',true,'orderId',created_order.id,'customerId',customer.id,'duplicate',false);
END $$;

CREATE OR REPLACE FUNCTION public.claim_customer_order_notification()
RETURNS TABLE(order_id uuid,claim_token uuid,chat_id text,external_id text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE cutoff timestamptz;selected_id uuid;recipient text;reference text;token uuid;
BEGIN
 SELECT enabled_at INTO cutoff FROM public.customer_notification_settings WHERE id=true; IF cutoff IS NULL THEN RETURN; END IF;
 UPDATE public.customer_order_notifications n SET state='uncertain',updated_at=now() WHERE n.state='sending' AND n.updated_at<now()-interval '2 minutes';
 INSERT INTO public.customer_order_notifications(order_id) SELECT DISTINCT o.id FROM public.orders o JOIN public.checkout_sessions c ON c.order_id=o.id WHERE o.status='new' AND o.created_at>=cutoff AND o.created_at>=now()-interval '15 minutes' AND c.telegram_user_id IS NOT NULL ON CONFLICT DO NOTHING;
 SELECT n.order_id,c.telegram_user_id,o.external_id INTO selected_id,recipient,reference FROM public.customer_order_notifications n JOIN public.orders o ON o.id=n.order_id
 JOIN LATERAL(SELECT s.telegram_user_id FROM public.checkout_sessions s WHERE s.order_id=o.id AND s.telegram_user_id IS NOT NULL ORDER BY s.updated_at DESC,s.id LIMIT 1)c ON true
 WHERE n.state IN('pending','retry') AND n.next_attempt_at<=now() AND n.attempts<3 AND o.status='new' AND o.created_at>=now()-interval '15 minutes'
 ORDER BY n.next_attempt_at,n.order_id FOR UPDATE OF n SKIP LOCKED LIMIT 1;
 IF selected_id IS NULL THEN RETURN; END IF; token=gen_random_uuid();
 UPDATE public.customer_order_notifications n SET state='sending',claim_token=token,attempts=n.attempts+1,updated_at=now() WHERE n.order_id=selected_id;
 RETURN QUERY SELECT selected_id,token,recipient,reference;
END $$;

CREATE OR REPLACE FUNCTION public.finish_customer_order_notification(p_order_id uuid,p_token uuid,p_state text,p_message_id bigint DEFAULT NULL,p_retry_seconds integer DEFAULT 30)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE changed integer;
BEGIN
 IF p_state NOT IN('sent','uncertain','retry','rejected') THEN RAISE EXCEPTION 'INVALID_NOTIFICATION_STATE'; END IF;
 UPDATE public.customer_order_notifications n SET state=CASE WHEN p_state='retry' AND n.attempts>=3 THEN 'rejected' ELSE p_state END,telegram_message_id=p_message_id,updated_at=now(),next_attempt_at=now()+make_interval(secs=>greatest(30,least(86400,p_retry_seconds)))
 WHERE n.order_id=p_order_id AND n.claim_token=p_token AND n.state='sending'; GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END $$;

CREATE OR REPLACE FUNCTION public.sync_verified_customer_telegram_username()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE observed boolean;username text;
BEGIN
 SELECT v.telegram_username_observed,v.telegram_username INTO observed,username FROM public.phone_verifications v
 WHERE v.phone=new.normalized_phone AND v.telegram_user_id=new.telegram_user_id AND v.status IN('VERIFIED','CONSUMED')
 ORDER BY v.verified_at DESC NULLS LAST,v.created_at DESC LIMIT 1;
 IF observed THEN new.telegram_username:=CASE WHEN username~'^[A-Za-z][A-Za-z0-9_]{3,31}$' THEN username ELSE NULL END;
 ELSIF tg_op='INSERT' OR new.telegram_user_id IS DISTINCT FROM old.telegram_user_id THEN new.telegram_username:=NULL; END IF; RETURN new;
END $$;

CREATE TRIGGER sync_verified_customer_telegram_username
BEFORE INSERT OR UPDATE OF telegram_user_id ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.sync_verified_customer_telegram_username();

-- Native role permissions. mpos_app is created outside this migration.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT CONNECT ON DATABASE mpos TO mpos_app;
GRANT USAGE ON SCHEMA public TO mpos_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO mpos_app;
GRANT EXECUTE ON FUNCTION public.loyalty_balance(uuid,uuid) TO mpos_app;
GRANT EXECUTE ON FUNCTION public.apply_loyalty_sale(uuid,uuid,text,text,integer,integer,integer,integer) TO mpos_app;
GRANT EXECUTE ON FUNCTION public.apply_single_reward_adjustment(uuid,uuid,integer,integer,text,jsonb) TO mpos_app;
GRANT EXECUTE ON FUNCTION public.apply_single_reward_reversal(uuid,text) TO mpos_app;
GRANT EXECUTE ON FUNCTION public.replace_loyalty_program(uuid,text,integer,integer,boolean,text[],text[]) TO mpos_app;
GRANT EXECUTE ON FUNCTION public.store_operational_snapshot(uuid,integer,integer,bigint,timestamptz,timestamptz,jsonb) TO mpos_app;
GRANT EXECUTE ON FUNCTION public.store_availability_snapshot(uuid,bigint,timestamptz,jsonb,text[]) TO mpos_app;
GRANT EXECUTE ON FUNCTION public.get_web_availability() TO mpos_app;
GRANT EXECUTE ON FUNCTION public.reserve_web_order_items(uuid,jsonb) TO mpos_app;
GRANT EXECUTE ON FUNCTION public.create_web_order(text,text,text,text,text,text,text,numeric,numeric,jsonb) TO mpos_app;
GRANT EXECUTE ON FUNCTION public.finalize_verified_checkout(text,text,text) TO mpos_app;
GRANT EXECUTE ON FUNCTION public.claim_customer_order_notification() TO mpos_app;
GRANT EXECUTE ON FUNCTION public.finish_customer_order_notification(uuid,uuid,text,bigint,integer) TO mpos_app;
-- Trigger function does not need direct application EXECUTE.

COMMIT;
