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

M-POS-Android imports `order_items.price`, including zero. Inventory snapshots
carry `settledWebOrderIds` and only release reservations / record payment time.
Migration 015 removes earning from that path: current native Android already
sends the committed receipt separately to `/api/loyalty/sales`. Running both
handlers earned twice because their identities were web UUID vs receipt UUID.

The durable receipt is now the sole source of earning, keyed by receipt and
program. `items[].unitPrice` from the immutable native checkout snapshot makes
already free website lines non-earning; POS reward allocations are also excluded,
including from overlapping programs. Gift units cannot be redeemed again. Old
clients without prices keep their previous receipt semantics and require the
Android update to distinguish already free website lines. Existing outbox bodies
and historical ledger entries are not rewritten. Unknown duplicate historical
balances require an audit linking the specific sale before correction.

Delivery orders have `delivery_fee_pending=true`, provisional goods-only total,
and an administrator pricing label. The administrator must agree the delivery
charge; zero in the provisional fee is not an offer of free delivery. The website
does not select a tariff. Existing POS tariff publication APIs remain available.

History is authorized by the verified phone/customer and uses a `(created_at,id)`
cursor with database timestamp precision, five rows plus one lookahead. There is
no offset or unbounded history response. Initial account HTML hides guest/member
views until the session request resolves.

Migrations 013–015 are additive and preserve earlier migration checksums. Published
terms are archived under edition 2026-11-11.1. Tests cover native payment replay,
cheapest gifts, cancellation, guests, enrollment and cursor isolation; Flyway CI
also checks fresh install, upgrade, checksum rejection and rollback.
