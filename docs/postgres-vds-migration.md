# PostgreSQL VDS migration — work log

Last updated: 2026-10-13

This document is the operational hand-off for the migration from Supabase to native PostgreSQL 17 on the Belarus VDS. It describes the goal, decisions, completed work, current test environment, known problem, and the exact remaining work. It must be updated as the migration progresses.

## Goal

Remove Supabase as a runtime dependency and run the application on infrastructure hosted on the VDS while preserving the existing HTTP contracts used by the Web/POS and Telegram bot.

Target architecture:

- Web/POS -> Backend API -> PostgreSQL
- Telegram bot -> Backend API -> PostgreSQL
- product images -> persistent VDS filesystem
- PostgreSQL remains Docker-internal; host port 5432 is not published
- public backend remains behind Caddy at project-dubrovno.store

The product has not yet been in real operation. The tablet/POS is the authoritative source for catalog/state and can resynchronize it. Therefore old Supabase test rows and old product-image data do not need to be migrated. We are intentionally starting with a clean PostgreSQL database and validating that the POS can repopulate it.

## Safety and branch state

Backend repository: `mendelev-main/M-Pos-Backend`.

Migration branch: `migration/postgres-vds`.

Production/autodeploy branch is `main`. Cutover was explicitly authorized and completed on 2026-10-13; the migration changes are being promoted to `main`.

VDS checkout: `/opt/mpos/app`.

Production `mpos-backend` has been rebuilt with the PostgreSQL runtime. Caddy still routes the public domain to loopback host port 3000. The runtime connects to PostgreSQL 17 as `mpos_app`.

The production deploy script resets the checkout to `origin/main`; `main` must contain the native PostgreSQL runtime before normal autodeploy is used.

Do not run `git clean` on the VDS checkout. The production Dockerfile is now included in the repository; its earlier VDS backup is `/opt/mpos/Dockerfile.backend.vds-backup`.

Secrets stay only on the VDS and must never be printed or committed.

## Database audit and migration scope

The actual Supabase production schema was audited. The active schema contained 18 application tables:

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

The active PostgreSQL functions were:

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

The active trigger is `sync_verified_customer_telegram_username` on `customers`.

Important loyalty invariant: `reward_quantity = 1`.

Legacy APNs objects such as `device_push_tokens` and `order_push_outbox` were already removed from the real Supabase database and are intentionally not recreated.

Supabase RLS/service-role semantics are intentionally not reproduced. The VDS database is private/internal and the backend uses a restricted application role.

Historical backend code expected owner-auth state that did not exist in the actual Supabase schema. We resolved that drift natively with migration `002_owner_auth.sql`.

## PostgreSQL VDS state

PostgreSQL 17 runs in Docker:

- Compose service: `postgres`
- container: `mpos-postgres`
- database: `mpos`
- admin/bootstrap role: `mpos_admin`
- restricted runtime role: `mpos_app`
- persistent PGDATA: `/opt/mpos/data/postgres`
- product media directory: `/opt/mpos/data/product-images`

No PostgreSQL host port is published.

The `mpos_app` role was verified as LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT and NOREPLICATION. TCP/password authentication from the application environment was successfully tested.

Server-only environment files include:

- `/opt/mpos/postgres.env`
- `/opt/mpos/app-db.env`
- `/opt/mpos/backend-db.env`

They are root-owned/mode 600. Never print or commit their contents.

## Database migrations completed

### 001_baseline.sql

The clean final-state baseline has been created and applied. It contains the 18 active application tables, constraints, indexes, 14 production functions, the customer trigger and grants for `mpos_app`.

Five useful FK indexes missing in the old Supabase database were added:

- checkout_sessions(order_id)
- loyalty_ledger(order_id)
- loyalty_ledger(program_id)
- order_items(order_id)
- order_items(product_id)

The baseline was first tested inside a transaction/rollback and then applied for real. Validation confirmed the expected application functions and trigger.

### 002_owner_auth.sql

Applied successfully.

Creates `owner_auth_state`, seeds the initial document, revokes PUBLIC access and grants SELECT/UPDATE to `mpos_app`. Backend owner-auth now performs PostgreSQL reads and compare-and-swap style revision updates directly.

### 003_runtime_defaults.sql

Applied successfully.

Ensures `customer_notification_settings` has its runtime default row/enabled timestamp.

## Backend migration completed in code

The backend runtime on `migration/postgres-vds` has been converted from Supabase to Node `pg`.

`db/index.js` provides a shared `Pool`, `query()` and `withTransaction()`.

Migrated areas include:

- menu/catalog reads
- catalog synchronization from POS
- availability snapshots and reads
- operational state/snapshots
- shared device authentication
- device Telegram settings
- live POS reports
- checkout sessions
- phone verification
- checkout finalization
- customer order notification claim/finish
- orders and order items
- order tracking
- order acceptance/status updates
- SSE new-order polling
- ready-order flow and cleanup
- customers
- loyalty program CRUD
- loyalty sale/reversal/adjustment
- loyalty analytics/history
- owner authentication state

Supabase runtime dependency was removed from `server.js` and package dependencies. Runtime source scans found no remaining Supabase client/storage usage.

Product image upload now writes to local persistent storage. Intended production path is `/data/product-images`, backed by `/opt/mpos/data/product-images`, and files are served as `/media/products/...`.

Relevant migration commits include:

- `c200f78` — availability service
- `29867c7` — operational state
- `6608eb9` — catalog sync
- `04e94a9` — shared device auth
- `3541fc7` — device Telegram settings
- `eab5eae` — restored listener after order migration
- `986d748` — ready-order runtime
- `e0851dc` — owner auth
- `31b3286` — remove Supabase runtime dependency
- `2c54f14` — PostgreSQL runtime defaults / loyalty SQL fix

Important runtime JS files were syntax-checked with Node 22 and passed.

## Temporary integration-test environment — historical

The following describes the pre-cutover test environment. Production cutover is now complete; this temporary backend is stopped.

A separate backend container was used for PostgreSQL integration tests:

- container: `mpos-backend-pg-test`
- Docker network: `mpos_default`
- container port: 3001
- host binding: `127.0.0.1:3001`
- PostgreSQL environment: `/opt/mpos/backend-db.env`
- source: current migration checkout
- media volume: `/opt/mpos/data/product-images:/data/product-images`

Health check passed:

`GET http://127.0.0.1:3001/health` -> HTTP 200.

The existing Telegram bot container `project-bot` and test backend are both on `mpos_default`.

For checkout integration testing, the bot was temporarily redirected to the test backend. These routes have now been restored to the public backend:

- `VERIFICATION_API_URL` -> `http://mpos-backend-pg-test:3001`
- `OWNER_API_URL` -> `http://mpos-backend-pg-test:3001`

The original bot environment was backed up as `/opt/mpos/bot.env.bak-pg-test`.

A real fetch executed inside `project-bot` against `$VERIFICATION_API_URL/health` returned HTTP 200, proving bot -> test backend connectivity.

Do not start a second polling bot with the same Telegram token; that would cause Telegram polling conflicts.

## Integration tests already passed

### Catalog synchronization

A temporary test device synchronized a category and product through `POST /api/menu/sync`.

The test product is:

- external id: `product:http-test`
- PostgreSQL product id: `e4043722-2b88-41b9-be49-c7a32a9c3f5d`
- price: 12.34

`GET /api/menu?surface=menu` returned the synchronized catalog from PostgreSQL.

### Availability

`POST /api/availability/snapshot` stored quantity 7 for the test product.

Subsequent menu reads returned `availability_known=true` and `available_quantity=7`.

This proves POS-style catalog/availability write -> backend -> PostgreSQL -> menu read.

### Atomic order/reservation function

`public.create_web_order(...)` was tested inside `BEGIN/ROLLBACK`.

Inside the transaction, ordering quantity 2 reduced availability from 7 to 5. After rollback, availability returned to 7 and the test order did not exist.

This validates reservation behavior and transactional rollback.

### Checkout creation

`POST /api/checkout` successfully creates:

- a PENDING checkout session
- a PENDING phone verification
- a Telegram deep link

Before confirmation, availability correctly remains unchanged.

### Telegram lookup

After redirecting the bot to the test backend, opening a fresh Telegram deep link produced:

`Подтвердите номер телефона. Ссылка действует 5 минут.`

This proves the bot can retrieve the verification token from the new PostgreSQL-backed backend.

A test with a deliberately fake order phone correctly produced a phone mismatch response, showing that phone comparison is active.

### Clock synchronization

UTC time was checked in:

- `project-bot`
- `mpos-backend-pg-test`
- `mpos-postgres`

All three clocks matched, so clock skew is not causing verification expiry.

## Telegram confirmation blocker — resolved

The bot's shared secret did not match the temporary PostgreSQL backend's secret. A request using the bot's configured secret returned HTTP 403 before phone confirmation or SQL finalization. The bot maps all non-2xx responses to its generic invalid/completed message.

The test backend secret was aligned with the production backend/bot secret. A synthetic missing-token request then returned HTTP 409 / NOT_FOUND, proving authorization passed. Production bot -> public backend health and authorization were also verified after cutover. Secret values were not printed or committed.

Safe backend logging now records only authorization/confirmation/finalization stage, HTTP status and reason for ordinary rejected confirmations.

## Production cutover completed — 2026-10-13

User authorized a clean database, with no migration or preservation of Supabase test data.

Completed:

- rebuilt `mpos-backend` with native `pg` runtime;
- added `backend-db.env` to production Compose;
- mounted `/opt/mpos/data/product-images:/data/product-images`;
- set `PRODUCT_IMAGES_DIR=/data/product-images` and `PUBLIC_BASE_URL=https://project-dubrovno.store`;
- retained loopback-only backend port 3000 and internal-only PostgreSQL;
- stopped the temporary PostgreSQL backend;
- cleared all application test rows transactionally and reseeded the owner-auth and customer-notification singleton defaults;
- restored both bot API URLs to `https://project-dubrovno.store` and restarted the existing single polling bot;
- verified public health and empty catalog responses.

Validation:

- actual PostgreSQL 17 / Node 22 / `mpos_app`: checkout creation, confirmation, finalization, reservation 7 -> 5 and duplicate SQL finalization passed in a rollback-only transaction;
- persistent image upload and retrieval passed; temporary image removed;
- production database connection confirmed `mpos_app`, database `mpos`, PostgreSQL 17;
- bot -> public backend health and shared-secret authorization passed;
- local native-baseline PGlite integration and PostgreSQL-adapted checkout unit tests passed (3 tests).

The full historical test suite still contains Supabase mocks and source-pattern assertions and does not pass against the migrated runtime. The targeted native tests do not replace physical POS/Telegram end-to-end acceptance.

## Remaining operator acceptance

Synchronize the real iPad/POS catalog and availability into the clean database, then check real images, a Telegram-confirmed order, POS order receipt and loyalty. Menu is intentionally empty until synchronization. Real Telegram contact sharing and physical POS operation were not performed by this agent.

The regular venue opening hours are unchanged; checkout is unavailable after 22:30 Europe/Minsk.

## Rollback references

- original backend image: `mpos-backend:supabase-before-postgres-20261013`;
- original Compose: `/opt/mpos/docker-compose.yml.bak-pg-cutover-20261013`;
- bot routing before this cutover: `/opt/mpos/bot.env.bak-before-cutover-20261013` (points to the test backend);
- original public bot environment: `/opt/mpos/bot.env.bak-pg-test`.

Supabase was not deleted. Before any rollback, restore the original backend image/configuration and the original public bot routing together; the temporary test bot routing must not be restored by itself.

## Current status summary

Database/schema migration: **done**.

Backend runtime conversion and production cutover: **done**.

Supabase runtime dependency: **removed**.

Production PostgreSQL: **connected and verified**.

Temporary PostgreSQL backend: **stopped**.

Telegram authorization blocker: **resolved**.

Database contents: **clean; runtime singleton defaults seeded**.

Real tablet synchronization and human Telegram contact-sharing acceptance: **pending operator action**.
