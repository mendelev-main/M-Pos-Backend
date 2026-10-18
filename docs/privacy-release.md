# Privacy and optional loyalty release

Migrations 005–006 are additive. Existing memberships are not invented from old customer/purchase rows. Verified online checkout captures order acknowledgement and optional loyalty separately, along with the immutable legal edition. Old public order creation is retired; checkout is the sole public entry point. Re-enrollment uses a fresh checked and verified checkout. Unchecking a later order is not withdrawal.

Paid POS orders carry the membership version and purchase time captured locally before publication. The database serializes sales, administrative adjustments, withdrawal, expiry and refund through a customer lock. All programs in one sale are applied in a transaction. Duplicate sales do not renew membership; old signatures/private internals cannot bypass consent. Termination offsets gift/progress balances through auditable ledger adjustments; refund reversals cannot restore gifts for terminated membership.

## Retention and rollout

- Temporary unconfirmed checkouts/verification/access sessions: bounded daily cleanup 24 hours after expiry. Confirmed checkout contacts are retained for ongoing order service and erased together with the closed order contacts.
- Membership: expiry after 24 months from consent or a qualifying paid purchase. Withdrawal or expiry stops operations and remaining gifts/progress. Purpose-specific profile contacts are retired by the maintenance cycle after a 14-day handling interval; this does not erase independently justified order documents.
- Operational order contacts: 30 days after final cancellation/completion or a paid receipt completion signal. Historical non-final orders are not assumed paid. A later move from accepted to ready does not erase the financial completion timestamp. `privacy_hold_until` postpones contact cleanup for an individually justified case. Order totals/items and financial ledger rows remain.
- `apply_order_contacts` defaults false until setup verifies a fresh backup and full restore. Run `sudo bash <reviewed-release>/scripts/setup-privacy-vds.sh` after deployment. The setup is root-only because Docker/DB backups and the cron configuration are privileged.
- The setup installs daily private DB backups under `/opt/mpos/privacy-backups`, retaining managed dumps for 30 days. Only matching files in this directory are pruned after a successful new backup. Old delivery/manual backups, provider snapshots, exported tablet files, Telegram messages and paper documents require separate operator review; this release cannot claim deletion from those copies.
- Tablet instructions are paginated/replayed; acknowledgements follow durable local writes and retry independently. Backup import replays instructions from the configured server before restoring data. The protocol readiness registry and retention report expose counts only.

Old customer profiles without verified membership are frozen for loyalty, with their old balances preserved pending a new valid consent. Their historical retention must be reviewed separately; the release does not label their existence as consent or invent dates. Financial-document/proof retention periods and the hosting provider's exact legal identity still require operator documentation. Public policy accurately distinguishes implemented cleanup from unfinished coverage of external copies.

## Verification

Backend Node tests include actual native migrations 001–006 under `mpos_app` using PostgreSQL WASM, strict choices before contacts are stored, verified enrollment, idempotence, stale checkouts, versions, expiry, refund after withdrawal, bounded cleanup, contact removal preserving totals/items, and private function denial. GitHub Actions additionally tests Flyway on PostgreSQL 17 and an isolated VDS fixture with backup/restore/setup. Shared POS and Android suites run in Actions; no local JS/JVM test, lint or APK assembly was run for Android.

Physical acceptance remains required on the tablet: update over existing installation, verified opt-in, ordinary no-opt-in order, reward use, withdrawal, reconnect, and restore a pre-withdrawal backup. External file retention is an operator procedure, not an APK feature.

Checkout is open daily 10:00–22:00 Europe/Minsk, including on already-open browser tabs; the API enforces the same boundary. Menu and privacy withdrawal remain available around the clock. A pre-22:00 checkout cannot be finalized after closing.

The executable ready-server root override enforces the same ordering hours. Its legacy 24-hour deletion of entire ready orders/items has been removed; only contact retention runs through the central worker.
