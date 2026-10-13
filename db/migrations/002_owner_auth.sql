BEGIN;

CREATE TABLE IF NOT EXISTS public.owner_auth_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision bigint NOT NULL DEFAULT 0,
  document jsonb NOT NULL DEFAULT '{"sessions":{},"audit":[]}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.owner_auth_state (id, revision, document)
VALUES (true, 0, '{"sessions":{},"audit":[]}'::jsonb)
ON CONFLICT (id) DO NOTHING;

REVOKE ALL ON public.owner_auth_state FROM PUBLIC;
GRANT SELECT, UPDATE ON public.owner_auth_state TO mpos_app;

COMMIT;
