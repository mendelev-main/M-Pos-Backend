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

Production/autodeploy branch remains `main` until cutover is explicitly approved.

VDS checkout: `/opt/mpos/app`.

Important: the running production container has NOT been rebuilt/restarted from the migration branch. The public domain still points through Caddy to the existing backend on host port 3000.

Do not run the production deploy script while `/opt/mpos/app` is on the migration branch: the deploy script resets the checkout to `origin/main`.

Do not run `git clean`. `/opt/mpos/app/Dockerfile` is an untracked VDS-only production Dockerfile and is required for builds. A backup also exists at `/opt/mpos/Dockerfile.backend.vds-backup`.

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

## Temporary integration-test environment

Production has not been cut over.

A separate backend container is running for PostgreSQL integration tests:

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

For checkout integration testing, the bot has been TEMPORARILY redirected from the public production backend to the test backend:

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

## Current blocker: Telegram confirmation/finalization test

This is the exact point where work is paused.

With a checkout created using the real Telegram phone number:

1. a fresh checkout is created;
2. the new Telegram deep link is opened;
3. bot successfully loads the verification and shows the contact-sharing button;
4. user sends the Telegram contact;
5. the contact button disappears;
6. bot responds: `⌛ Подтверждение недействительно или уже завершено.`

Database inspection of previous attempts showed records remaining `PENDING`, with no `telegram_user_id`, `verified_at` or `consumed_at`. One inspection was performed after the five-minute TTL had elapsed, so it did not identify the original rejection reason.

Backend logs currently show no useful entry for this case. That is expected from the code: the confirm route only logs thrown exceptions/500 errors. Normal unsuccessful `phoneVerification.confirm()` results are returned as HTTP 409 without a server log.

The relevant backend route is:

`POST /api/phone-verification/:token/confirm`

It first validates `X-Owner-Bot-Secret`, then calls `phoneVerification.confirm()`, and if confirmation succeeds calls `checkout.finalizeByVerificationToken()`.

Possible `phoneVerification.confirm()` failure reasons in current code are:

- INVALID
- NOT_FOUND
- EXPIRED
- PHONE_MISMATCH
- ALREADY_USED

A successful confirmation should change the verification from `PENDING` to `VERIFIED`, set `verified_at` and `telegram_user_id`, then checkout finalization should create the order/consume the verification.

### Exact next diagnostic step

Do not continue blind retries.

Create one fresh checkout with the real Telegram phone, open its new deep link and send the contact immediately. While the five-minute TTL is still active, capture the exact HTTP status/body returned by the bot's confirm request or add temporary safe diagnostic logging that records only status/reason and never logs phone, verification token, Telegram ID or shared secret.

The objective is to determine whether the failure is:

1. authorization (`X-Owner-Bot-Secret`);
2. `phoneVerification.confirm()` returning one of the reasons above;
3. confirmation succeeds but `finalize_verified_checkout` returns a failure;
4. bot maps a different backend response to the generic expiry/completed message.

Once the exact response is known, fix the cause and repeat the full flow. The acceptance condition is:

- verification becomes VERIFIED/CONSUMED as designed;
- checkout becomes finalized;
- order and order_items are created;
- reservation reduces available quantity atomically;
- Telegram receives a success response;
- repeated confirmation is idempotent/rejected correctly without duplicate order creation.

## Remaining tests before cutover

After checkout/Telegram confirmation is fixed, test at least:

- local product image upload and retrieval
- operational heartbeat/snapshot
- owner-auth read/CAS/login flow
- loyalty program create/update and `replace_loyalty_program`
- loyalty sale, reward adjustment/reversal
- customer notification claim/finish
- order accept/status/ready flow
- ready-order cleanup behavior
- SSE/new-order polling as used by POS
- tablet/POS synchronization against the fresh PostgreSQL database

Because the product is not yet live, test data should be removed/reset before the real tablet synchronization.

## Production cutover work still required

The production Compose backend currently needs to be wired to the new runtime before cutover:

- include `backend-db.env`
- mount `/opt/mpos/data/product-images:/data/product-images`
- set `PRODUCT_IMAGES_DIR=/data/product-images`
- set `PUBLIC_BASE_URL` to the public site origin
- keep backend host exposure loopback-only on port 3000
- keep PostgreSQL internal-only

Before switching production:

1. finish integration tests above;
2. clean/reset test rows;
3. ensure migrations 001/002/003 are present and applied;
4. update Compose backend configuration;
5. restore the bot from temporary test routing as appropriate for the cutover (after production backend is PostgreSQL, its normal public URL can be used again);
6. rebuild/restart backend deliberately;
7. verify public health/menu/order flows;
8. synchronize the real tablet/POS into the clean database;
9. verify catalog, availability, orders, Telegram and loyalty end to end;
10. only then consider merging `migration/postgres-vds` to `main` and restoring normal autodeploy.

Do not retire Supabase until the PostgreSQL production path has been verified and a rollback decision has been made.

## Current status summary

Database/schema migration: **done**.

Backend runtime conversion to PostgreSQL: **done in migration branch**.

Supabase runtime dependency removal: **done**.

Temporary PostgreSQL backend: **running and healthy**.

Catalog/availability integration: **passed**.

Atomic order reservation: **passed**.

Checkout creation: **passed**.

Telegram verification lookup: **passed**.

Telegram contact confirmation + checkout finalization: **current blocker / under diagnosis**.

Production cutover: **not started**.
