# Web checkout and Android loyalty

A valid `mpos_account` session authorizes checkout only for its verified phone. A
request UUID, payload fingerprint and phone lock prevent duplicate authenticated
orders. Session validation and finalization run in a single transaction. Guests
still confirm their contact in Telegram. Every new web order joins loyalty,
including a new order after withdrawal; retries do not renew membership.

`giftProgramIds` is a list of requested programs, never prices or discounts. The
finalizer locks the customer, validates each current balance, and makes one
cheapest eligible whole unit free per requested program (program UUID order,
product UUID breaks equal-price ties). A unit cannot satisfy multiple programs.
Stock is reserved for the original total quantities before paid/free lines are
split. Gift redemption, lines and the discounted order commit together.
Cancellation reverses the linked ledger entries idempotently.

M-POS-Android imports `order_items.price`, including zero. Its BackendRuntime sends
paid web order UUIDs as `settledWebOrderIds` with a new availability snapshot,
after the local sale exists. The backend records payment once, earns only on
non-gift quantities, and skips cancelled orders or a membership changed since
checkout. Retries/newer snapshots do not earn twice. Existing historical orders
are excluded through `orders.web_loyalty`. This does not add synchronization of
Android receipt refunds or edits to imported receipts; those are not included in
the current paid-ID protocol.

Delivery orders have `delivery_fee_pending=true`, provisional goods-only total,
and an administrator pricing label. The administrator must agree the delivery
charge; zero in the provisional fee is not an offer of free delivery. The website
does not select a tariff. Existing POS tariff publication APIs remain available.

History is authorized by the verified phone/customer and uses a `(created_at,id)`
cursor with database timestamp precision, five rows plus one lookahead. There is
no offset or unbounded history response. Initial account HTML hides guest/member
views until the session request resolves.

Migrations 013–014 are additive and preserve earlier migration checksums. Published
terms are archived under edition 2026-11-11.1. Tests cover native payment replay,
cheapest gifts, cancellation, guests, enrollment and cursor isolation; Flyway CI
also checks fresh install, upgrade, checksum rejection and rollback.
