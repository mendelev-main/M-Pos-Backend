BEGIN;

-- Runtime stopped collecting/reading birth dates in the preceding release.
-- Dropping the column also removes all previously stored profile birth dates.
ALTER TABLE public.customer_account_profiles DROP COLUMN birth_date;

COMMIT;
