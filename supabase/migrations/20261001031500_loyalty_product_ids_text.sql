-- POS product ids are local stable string identifiers, not guaranteed UUIDs.
alter table public.loyalty_earning_products drop constraint if exists loyalty_earning_products_product_id_fkey;
alter table public.loyalty_reward_products drop constraint if exists loyalty_reward_products_product_id_fkey;
alter table public.loyalty_earning_products alter column product_id type text using product_id::text;
alter table public.loyalty_reward_products alter column product_id type text using product_id::text;
