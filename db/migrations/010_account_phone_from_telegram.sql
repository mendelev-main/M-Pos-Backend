BEGIN;

-- Account login learns the phone from Telegram; checkout still creates a known phone.
ALTER TABLE public.phone_verifications ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE public.phone_verifications ADD CONSTRAINT verified_contact_requires_phone
  CHECK (phone IS NOT NULL OR status IN ('PENDING','EXPIRED'));

COMMIT;
