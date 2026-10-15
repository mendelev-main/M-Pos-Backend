-- No application rows, credentials or function bodies are returned.
SET statement_timeout = '15s';
BEGIN READ ONLY;
SELECT current_database() AS database_name,current_user AS migration_user,
       current_setting('server_version') AS postgres_version;
SELECT tablename,tableowner FROM pg_tables WHERE schemaname='public' ORDER BY tablename;
SELECT column_name,data_type FROM information_schema.columns
 WHERE table_schema='public' AND table_name='orders'
 AND column_name IN('delivery_fee','delivery_tariff_id','delivery_tariff_name','delivery_tariff_version')
 ORDER BY column_name;
SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
       md5(p.prosrc) AS body_checksum,p.prosecdef AS security_definer
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='finalize_verified_checkout';
SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolcanlogin
 FROM pg_roles WHERE rolname IN('mpos_admin','mpos_app');
SELECT to_regclass('public.flyway_schema_history') AS flyway_history,
       to_regclass('public.owner_auth_state') AS owner_auth_table,
       to_regclass('public.customer_notification_settings') AS notification_settings;
COMMIT;
