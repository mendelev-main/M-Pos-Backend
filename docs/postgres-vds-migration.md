# PostgreSQL VDS migration — work log

Last updated: 2026-10-13

This document records the current state of the migration from Supabase PostgreSQL to a native PostgreSQL 17 instance on the VDS. It is intentionally operational: the next person/session should be able to understand what is already done, what is deliberately not done, and the exact next step.

## Goal

Move the application's database dependency from Supabase to PostgreSQL on the VDS while keeping the existing Backend API stable for the Web/POS and Telegram bot. Production must remain on Supabase until schema/data/media migration and backend compatibility are verified.

Target architecture:

- Web/POS -> Backend API -> PostgreSQL
- Telegram bot -> Backend API -> PostgreSQL
- product images -> persistent VDS storage
- PostgreSQL is Docker-internal only; port 5432 is not published on the host

## Production safety / current state

Production is still using Supabase. No database cutover has happened.

Backend production repository on the VDS: `/opt/mpos/app`.
The running Docker image is not automatically changed by switching the Git working tree; nevertheless, do not rebuild/restart production from the migration branch.

Migration branch: `migration/postgres-vds`.
`main` must remain the production/autodeploy branch until cutover is explicitly approved.

## Database audit completed

The production Supabase schema and the three application repositories were audited:

- `mendelev-main/M-Pos-Backend`
- `mendelev-main/project_bot`
- `mendelev-main/M-POS-Android-Web`

The bot and POS do not access Supabase directly; database migration can therefore be concentrated in the Backend while preserving its HTTP API.

The current production schema contains 18 relevant tables:

1. categories
2. products
3. orders
4. order_items
5. devices
6. phone_verifications
7. checkout_sessions
8. operational_states
9. customers
10. loyalty_programs
11. loyalty_earning_products
12. loyalty_reward_products
13. loyalty_ledger
14. availability_states
15. product_availability
16. web_order_reservations
17. customer_notification_settings
18. customer_order_notifications

All 18 have a current runtime/business purpose and should initially be migrated.

The current production database also has 14 relevant PostgreSQL functions:

- apply_loyalty_sale
- apply_single_reward_adjustment
- apply_single_reward_reversal
- claim_customer_order_notification
- create_web_order
- finalize_verified_checkout
- finish_customer_order_notification
- get_web_availability
- loyalty_balance
- replace_loyalty_program
- reserve_web_order_items
- store_availability_snapshot
- store_operational_snapshot
- sync_verified_customer_telegram_username

Current application trigger:

- `sync_verified_customer_telegram_username` on `customers`

Important business invariant: loyalty programs currently enforce `reward_quantity = 1`.

### Intentionally excluded

Old APNs/push-notification schema is legacy and has already been removed from production. Do not recreate `device_push_tokens`, `order_push_outbox`, their old trigger, or their RPC functions.

Supabase RLS/service-role semantics will not be reproduced on the VDS. PostgreSQL is private/internal and the Backend will use a restricted DB login.

`owner_auth_state` / `owner_auth_compare_swap` exist in historical/backend code expectations but are absent from the actual production Supabase schema. This is schema drift. They are intentionally excluded from the first baseline until `OWNER_AUTH_ENABLED` and the intended owner-auth design are resolved.

Supabase Storage is still an active dependency. Planned replacement is persistent local storage at `/opt/mpos/data/product-images`, exposed by the application as `/media/products/...`. Existing Supabase image URLs will need a later media-copy/rewrite step.

## VDS PostgreSQL prepared

Docker Compose now contains a PostgreSQL 17 service named `postgres` / container `mpos-postgres`.

Persistent PGDATA:

`/opt/mpos/data/postgres`

Planned product media directory:

`/opt/mpos/data/product-images`

PostgreSQL has no host port mapping. `docker ps` shows only `5432/tcp`, not `0.0.0.0:5432`.

Database:

`mpos`

Administrative role:

`mpos_admin`

Application role:

`mpos_app`

Role separation was verified:

- mpos_admin is the bootstrap/admin role and is reserved for migrations/maintenance.
- mpos_app can LOGIN.
- mpos_app has NOSUPERUSER.
- mpos_app has NOCREATEDB.
- mpos_app has NOCREATEROLE.
- mpos_app has NOREPLICATION.
- mpos_app has NOINHERIT.
- real TCP/password login to database `mpos` as `mpos_app` was successfully tested.

Secrets are not stored in this document or Git.

Server-only files:

- `/opt/mpos/postgres.env` — PostgreSQL bootstrap/admin environment
- `/opt/mpos/app-db.env` — application DB password
- both are root-owned mode 600

Do not print or commit their contents.

The PostgreSQL database is currently empty. No application baseline or production data has been imported yet.

## Baseline design

Create a clean final-state migration:

`db/migrations/001_baseline.sql`

Do not replay the historical Supabase migration chain.

The baseline should contain:

- the 18 current production tables
- current PK, FK, UNIQUE and CHECK constraints
- current useful indexes
- the 14 current production functions
- the current customers trigger
- additional indexes for currently unindexed foreign keys:
  - checkout_sessions(order_id)
  - loyalty_ledger(order_id)
  - loyalty_ledger(program_id)
  - order_items(order_id)
  - order_items(product_id)
- grants required by restricted role `mpos_app`

Do not add Supabase RLS/policies/service_role grants.
Do not add legacy APNs objects.
Do not add owner_auth_state in the initial baseline.

Preserve production UUIDs and external IDs during data migration.

## Migration sequence after baseline

1. Build and review `001_baseline.sql`.
2. Apply it to the empty VDS PostgreSQL as `mpos_admin`.
3. Validate tables, constraints, functions, trigger, indexes and mpos_app permissions.
4. Export/copy the initial Supabase data in FK-safe order while preserving IDs.
5. Validate row counts and referential integrity.
6. Copy product images from Supabase Storage and rewrite image URLs.
7. Add Backend PostgreSQL data-access layer (Node `pg` Pool) while preserving existing API contracts.
8. Test catalog, devices, orders, checkout, phone verification, availability, loyalty, Telegram notifications and operational snapshots against VDS PostgreSQL.
9. Perform final synchronization with a short write pause.
10. Switch Backend to VDS PostgreSQL.
11. Verify production behavior.
12. Keep Supabase available as rollback source for an agreed window before retirement.

Existing ready-order cleanup semantics should remain unchanged during the migration. Retention/archive redesign is a separate post-migration task.

## Exact stopping point / next action

We were about to switch the VDS Git working tree from production `main` to `migration/postgres-vds` before creating `db/migrations/001_baseline.sql`.

A safety check found an untracked VDS-only file:

```
/opt/mpos/app/Dockerfile
```

Observed state:

```
git status --short
?? Dockerfile
```

`git ls-files Dockerfile` returned nothing, confirming that this Dockerfile is not tracked in the currently checked-out branch.

Observed file metadata:

```
-rw-rw-r-- 1 aleksandr aleksandr 170 Oct 11 18:03 Dockerfile
```

STOP HERE before switching branches.

### Next step

Determine whether `Dockerfile` exists/tracks on `origin/migration/postgres-vds`. Preserve the VDS-only Dockerfile before any checkout/switch if the target branch could overwrite/conflict with it. Do not delete it: production deployment currently depends on it.

After the Dockerfile is safely handled:

- switch the VDS working copy to `migration/postgres-vds` without rebuilding/restarting the production container;
- create/review `db/migrations/001_baseline.sql`;
- apply the baseline only to the empty `mpos-postgres` database;
- do not cut production over from Supabase yet.
