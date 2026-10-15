# Flyway migrations before backend deployment

Flyway Community 11.8.2 is pinned by image digest in `db/flyway-image.txt`. Activation requires one-time administrative setup on the VDS. SSH access is available, but the current account can run only the old deployment entrypoints without a sudo password.

## Deployment contract

GitHub first runs backend tests and the isolated Flyway/PostgreSQL integration test. It then checks the installed entrypoint's root ownership, mode 755 and SHA-256 against the release's `scripts/deploy-backend.sh`. A missing, old or different script stops deployment before invocation. Only after those checks does it call `/opt/mpos/scripts/deploy-backend.sh` with the exact commit SHA. Install the repository's new deployment script on the VDS before merging this workflow change. The old script does not implement the migration gate.

The new entrypoint locks deployment, refuses dirty tracked files/local-only commits, fetches `main`, verifies the expected commit is the current tip and archives that commit's migration files to an isolated temporary directory. It runs Flyway **before** changing the checkout or rebuilding/restarting the backend. Migration failure leaves the old backend running. A build failure also leaves it running, although the schema and checkout may already be updated. Database migrations must therefore remain compatible with the old backend.

After successful migration, Compose builds the existing backend service and recreates only that service. The deployed image records `org.opencontainers.image.revision`; the script checks it against the requested SHA and checks health plus the database-backed tariff endpoint. Failed health after restart requires investigation; automatic database rollback or guaranteed application rollback is not claimed.

This assumes the documented VDS Compose path `/opt/mpos/docker-compose.yml`, existing containers `mpos-postgres`/`mpos-backend` and a single internal PostgreSQL Docker network. The backend Compose service is derived from its container label. Multiple database networks or missing containers fail explicitly rather than guessing. The host needs Bash, GNU coreutils/sed, Git, flock, curl, Docker and Compose; Node.js is not needed on the VDS.

## One-time server setup

1. Save the current `/opt/mpos/scripts/deploy-backend.sh` as a private backup. Install this repository's `scripts/deploy-backend.sh` in its place as root-owned mode 755. Keep the existing restricted sudo entrypoint; do not grant arbitrary Docker/shell sudo access to the GitHub SSH user. Ensure the deployment repository is trusted by root's Git configuration and preserve unrelated local files.
2. Create `/opt/mpos/flyway.env` from `db/flyway.env.example`, root-owned mode 600. Enter the existing database-owner/migration account credential securely on the VDS; do not commit it or print it in CI. The database owner must be able to alter existing tables and functions. The application remains `mpos_app`; do not give it migration privileges or add these credentials to the backend container.
3. Prepare a reviewed copy of the release repository outside the live application checkout for initial baseline commands. Pull the pinned Flyway image. Set `MPOS_FLYWAY_ENV_FILE=/opt/mpos/flyway.env` and `MPOS_DOCKER_NETWORK` to the existing private Compose network. Use `bash scripts/flyway.sh info` to inspect history.
4. Back up the production database using the established backup procedure and verify backup recoverability before adopting baseline. Inspect the actual schema, constraints, function definitions, ownership/grants and singleton defaults against `001_baseline.sql`, `002_owner_auth.sql` and `003_runtime_defaults.sql`. The historical documentation is evidence to inspect, not proof of the running database state. Never run `001_baseline.sql` against an existing populated database.
5. **Only if schema 001–003 has been verified and Flyway history is absent**, run `bash scripts/flyway.sh baseline-v3-reviewed`. This records version 3; it does not execute historical SQL, validate the schema or record checksums for skipped versions. If the schema does not match, stop and resolve the discrepancy in a reviewed migration. If later migrations have already been applied manually, review them separately before choosing how to adopt history; do not mark unverified changes as applied.
6. Run `bash scripts/flyway.sh migrate` and `bash scripts/flyway.sh validate`. After the reviewed version-3 baseline, only migration 004 is pending. Configure `DELIVERY_TARIFF_DEVICE_KEY` in the existing backend environment before expecting tablet tariff publication to succeed. Baseline alone does not enable delivery or supply that key.
7. Merge the release branch only after the server entrypoint and credentials are prepared. The main workflow then applies future migrations automatically. Verify the deployed SHA, history and application checks. Tablet/Telegram acceptance remains a separate physical check.

Without server setup, deployment fails safely; no automatic baseline is enabled to make it pass.

## Migration files and safeguards

Existing `db/migrations/001_*.sql` through `004_*.sql` remain byte-for-byte unchanged. `scripts/prepare-flyway.sh` generates stable Flyway names `V001__baseline.sql` etc. It replaces only the first outer `BEGIN;` and final `COMMIT;` with blank lines, leaving PL/pgSQL bodies intact so Flyway owns the transaction. Unsupported names/wrappers or nonempty preparation directories fail.

Once adopted, never change applied SQL, naming or the conversion algorithm: this changes Flyway checksums. Add `005_description.sql`, wrapped in outer `BEGIN;`/`COMMIT;`, for the next change. Keep all migration files immutable. There is no automatic `repair`, `clean`, out-of-order application or baseline-on-migrate. Migration account environment variables must not contain passwords in JDBC URLs or enable verbose debug output.

Flyway locks its history and the deployment script serializes the release; migrations use PostgreSQL transactions, 5-second lock timeout and 60-second statement timeout. Only transactional migrations are supported by this wrapper. Operations such as concurrent index creation require a separately reviewed design rather than silently disabling transaction protection. The public schema history table is maintained by the migration account.

## Validation

`bash scripts/test-flyway.sh` uses a disposable PostgreSQL 17 container on an isolated Docker network without a host port. Trust authentication is confined to that disposable test cluster. It tests fresh 001–004 migration, no-op repeat/validation, refusal of an unbaselined nonempty database, explicit baseline at 3 followed only by 004, checksum rejection and rollback of a deliberately failing migration. It deletes only its own test resources.

Production baseline, migration and deployment have not been executed here. Tests exercise the actual pinned Flyway image; the remote SSH/sudo/Compose entrypoint must still be provisioned and verified on the VDS.

## One-time setup helper for this VDS

`bash scripts/setup-delivery-vds.sh [tablet-device-uuid]` must be run with interactive sudo from a reviewed release archive outside `/opt/mpos/app`. It selects the sole active tablet or stops and lists non-secret device IDs for explicit selection. It makes a private custom-format DB backup, compares the live schema with 001–003 in a disposable PostgreSQL cluster with networking disabled, checks singleton rows/ownership and restores the backup into a separate disposable database. Any schema mismatch stops before baseline. The helper then derives private Flyway credentials from the existing PostgreSQL container, explicitly baselines version 3, migrates/validates 004, securely binds the existing tablet key and installs the root-owned deployment entrypoint. It never prints keys/passwords and does not deploy or restart backend. Backups are kept root-only under `/opt/mpos/delivery-backup.*`. Existing Flyway history causes a stop rather than automatic repair/rebaseline. The actual live schema remains unverified until this helper runs successfully.

The read-only Actions preflight calls only the existing restricted sudo entrypoint with `--preflight`. That mode runs a fixed read-only SQL query; it does not accept arbitrary SQL or grant Docker access. Before the one-time helper installs the new entrypoint, this check is expected to fail. Re-run it after setup.
