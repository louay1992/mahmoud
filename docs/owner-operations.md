# Owner operations

The owner console at `/owner` is independent of company administrators. It now includes administrator name/email changes, access revocation/Auth deletion, encrypted Backblaze backup catalog/download/create/restore, and real PostgreSQL/Storage statistics.

## Accounts

Email changes require verified mailbox/password setup. Existing access remains until activation; activation atomically transfers the existing permissions, then revokes the previous email's business role. Previous Auth credentials cannot access business data after the transfer. Name-only changes are immediate. Deletion requires typing the email, revokes roles and invitations before Auth deletion, and exposes a retryable `deleting` state if Hosted Auth is unavailable. Registered owner accounts, including inactive owners, are protected in SQL and by an Auth-delete trigger. Staff password resets preserve staff permissions.

## Backup execution

`owner_request_backup` authorizes an active owner and stores a durable job in an unexposed, RLS-protected schema. The five-minute worker and the daily 05:00 Asia/Damascus backup share a serialized GitHub queue with space for pending runs. GitHub scheduling can still be delayed. The console reports the worker's last successful cycle, its latest reported error, the latest verified backup date, and each request's stage. Every backup is age-encrypted and downloaded from B2 for SHA-256 verification before a verification sidecar is created. Download links are private, expire after ten minutes and are never logged.

Restore requires the original recovery-key file, chosen locally. WebCrypto RSA-OAEP-SHA256 encrypts the identity before it leaves the browser. A purpose-separated HKDF/AES-GCM key derived from the existing DB credential encrypts the worker's transport private key. No recovery identity is persisted as plaintext or added as a long-lived secret. Envelopes are scrubbed after processing. DB-password rotation creates a new transport key; old pending envelopes may need to be submitted again.

## Restore boundaries

The worker verifies the encryption, archive and file checksums, and project identity. It parses PostgreSQL COPY data into a private PostgreSQL instance and checks schema compatibility before enabling maintenance. A restore rolls business records back while keeping current Auth users, credentials, MFA, administrator permissions, captain access, warehouse assignments for surviving warehouses, subscription terms, invitation state, and device registrations. Historical-only captains exist as inactive records without login or contact details, so orders and payments keep their references. Current consumed order request identifiers stay recorded and order numbers continue above their existing high-water mark. Buckets recreated from format-1 snapshots start private.

Before writes, the worker enables maintenance, locks business tables, uploads a verified safety backup, and saves its identifier on the recovery job. Storage is restored and checked through S3 before the worker commits the business data, job completion, and maintenance state together. If the worker stops during a Storage change, the next cycle uses the recorded safety backup to repair the files. If automated recovery needs a fresh key or fails, the application stays in maintenance. The owner can retry file recovery with two-step verification and the recovery key for the safety backup. Confirm that the worker reports a completed rollback and that maintenance cleared before resuming operations. Coordinate external services that write with privileged credentials before starting a restore.

## Monitoring and cleanup

Metrics include database size, per-table/index size and estimated rows, Storage counts/metadata sizes/buckets, connections, transaction/cache/deadlock counters, and available pg_stat_statements execution averages. Time stamps and counter reset times are displayed. Browser-to-server request latency is labeled separately. CPU/RAM/hosting-plan limits are explicitly unavailable rather than estimated.

Cleanup deletes only registered expired `owner-temp/` files whose ETag still matches. A restrictive Storage policy makes registered disposable files immutable/inaccessible from client sessions; the serialized worker alone removes them. There is deliberately no heuristic deletion of unreferenced images or backup archives, no direct Storage metadata SQL deletion, and no VACUUM FULL/production cache reset. Empty candidate lists are normal until a trusted producer registers temporary exports. Local cache cleanup retains the active offline bundle, one fallback, all shell caches, unrelated caches, local data and Auth; it affects this browser/origin only.

## Validation

The recovery test uses PostgreSQL COPY, locally encrypted archives, and synthetic S3/Backblaze objects. It checks current credentials and restrictions, order and payment links, transactional order numbering, interruption handling, and both successful and compensated Storage restores. Rehearse full recovery to an isolated Supabase project using a real encrypted backup before relying on it for production incidents.
