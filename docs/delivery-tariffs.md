# Delivery tariffs from POS

Implemented in backend/PostgreSQL and the guest checkout. Production rollout has not been performed by this task.

## Enable

1. Apply `db/migrations/004_delivery_tariffs.sql` as the database administrator after migrations 001–003. The migration adds the tariff registry, publication state and immutable order snapshot fields; it preserves existing orders and can be reapplied.
2. Set backend `DELIVERY_TARIFF_DEVICE_KEY` securely to the existing device key of the trusted tablet. Do not generate a different key or commit its value. The device must already be active in `devices` (registered by the existing manual catalog sync). Without this binding publication returns 503; other devices receive 403. Changing the assigned source after its first publication requires an explicit administrator migration of `delivery_tariff_state.source_device_id`; no public takeover endpoint exists.
3. Deploy backend and guest assets, then update the shared POS/Android application. Saving a tariff queues its full list and automatically attempts publication. The tablet displays status and offers “Повторить синхронизацию”. Existing tariff lists are queued at application startup.
4. Until the first successful publication the existing guest delivery behavior/`DELIVERY_FEE` remains active. The first publication atomically activates the new contract. After activation, delivery requires an active selected tariff; an empty list disables delivery. There is no fallback to `DELIVERY_FEE`. Pickup remains available.

The Telegram bot protocol does not change. Restart backend after changing its environment. Do not run a second Telegram poller.

## Protocol

- `GET /api/delivery-tariffs` returns `{version, published, tariffs:[{id,name,amount}]}` without private device metadata; responses are `no-store`. Amounts are exact decimal strings.
- `GET /api/device/delivery-tariffs` returns the same public data after checking `X-Device-Key` against the configured active source.
- `PUT /api/device/delivery-tariffs` takes `{baseVersion, publicationId, tariffs}`. The server serializes publication under a row lock, checks the base version, deactivates removed IDs and upserts the complete list in one transaction. A repeated last publication ID with the same payload returns its acknowledged version. Reusing its ID for different data or publishing from an older version returns `DELIVERY_SYNC_CONFLICT` without modifying the list.
- `POST /api/checkout` adds `deliveryTariffId`, `deliveryTariffAmount` and numeric `deliveryTariffVersion` for delivery. Amount/version are expectations, not price authority. The server validates against its active registry; forged amounts, stale versions, absent/unknown tariffs fail before creation of a verification session. Pickup ignores delivery fields.
- Checkout responses include the server `deliveryTariff`, `deliveryFee` and `total`. The snapshot is frozen for the existing five-minute checkout TTL. A later price change/deactivation affects new sessions only. Atomic SQL finalization copies ID/name/version and fee into the order and preserves duplicate/expiry/reservation behavior.
- Existing order feeds include `delivery_tariff_id`, `delivery_tariff_name`, `delivery_tariff_version`. Old orders have null snapshot fields and keep their recorded fees.

Tariffs permit zero, distinct IDs with equal prices, names up to 100 characters, up to 100 records and nonnegative amounts up to 9,999,999.99 BYN with at most two fractional digits. IDs match `[A-Za-z0-9_-]{1,100}` and must be unique. Invalid full lists are rejected without partial updates.

## Tablet behavior

The existing `deliveryRates` and `network` documents are committed together through the storage journal. `network.deliveryTariffSync` contains the destination, acknowledged version, status and pending publication; no new backup schema or local storage key is required. Sending starts after local persistence. Failed requests retain the publication ID; startup, online, visibility and SSE reconnection events retry it. There is no polling timer or automatic product catalog sync.

Concurrent local edits retain the latest list. Acknowledging an older in-flight publication advances the base version of its local successor. Conflicts, including restored older backups, stop automatic publication; manual republish reads the server version and asks before replacing an already published list. A changed URL/device key also requires manual confirmation. Successful manual catalog registration triggers another attempt to publish queued tariffs.

The guest explicitly selects a tariff; opening checkout and submitting refresh the list. Changes invalidate the selection and require confirmation. Network errors block delivery checkout without inventing a zero price; pickup is unaffected. The POS carries the server tariff snapshot through incoming/parked orders, current session, backup and paid receipt. A valid web snapshot permits payment even after local tariff deletion. Existing cash withdrawal and loyalty calculations remain in their existing code paths.

## Validation

Backend tests cover restricted-role SQL migration/reapplication, publication authorization and ordering, exact amounts, zero/equal-price tariffs, server price validation, immutable checkout/order snapshots, duplicate finalization and expiration. Guest tests exercise the actual page total/selection/pickup flow, stale responses and unavailable tariffs. Local HTTP validation against PostgreSQL 17 verifies publication, public listing, checkout 30 + 5 = 35 and rejection of a forged zero price.

Shared POS regression tests were added for durable queueing, offline retries and conflict confirmation. Android/iPad local JS tests, JVM tests, lint and APK assembly were not executed; CI and real tablet/Telegram/receipt acceptance remain pending. No production migration, deployment or live message sending was performed.
