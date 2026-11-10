BEGIN;

CREATE TABLE public.customer_account_challenges (
  proof_hash text PRIMARY KEY,
  verification_token_hash text NOT NULL UNIQUE REFERENCES public.phone_verifications(token_hash) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX customer_account_challenges_expiry ON public.customer_account_challenges(expires_at);
CREATE TABLE public.customer_account_sessions (
  token_hash text PRIMARY KEY,
  phone text NOT NULL,
  telegram_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX customer_account_sessions_expiry ON public.customer_account_sessions(expires_at);
REVOKE ALL ON public.customer_account_challenges, public.customer_account_sessions FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.customer_account_challenges, public.customer_account_sessions TO mpos_app;

COMMIT;
