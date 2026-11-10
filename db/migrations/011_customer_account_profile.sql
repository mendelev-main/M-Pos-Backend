BEGIN;

CREATE TABLE public.customer_account_profiles (
  phone text PRIMARY KEY CHECK (phone ~ '^\+375[0-9]{9}$'),
  display_name text CHECK (length(display_name) <= 80),
  birth_date date CHECK (birth_date >= DATE '1900-01-01'),
  delivery_address text CHECK (length(delivery_address) <= 300),
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.customer_account_profiles FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON public.customer_account_profiles TO mpos_app;

COMMIT;
