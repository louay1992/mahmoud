# Owner operations

The owner console at `/owner` is independent of company administrators. It now includes administrator name/email changes, access revocation/Auth deletion, encrypted Backblaze backup catalog/download/create/restore, and real PostgreSQL/Storage statistics.

## Accounts

Email changes require verified mailbox/password setup. Existing access remains until activation; activation atomically transfers the existing permissions, then revokes the previous email's business role. Previous Auth credentials cannot access business data after the transfer. Name-only changes are immediate. Deletion requires typing the email, revokes roles and invitations before Auth deletion, and exposes a retryable `deleting` state if Hosted Auth is unavailable. Registered owner accounts, including inactive owners, are protected in SQL and by an Auth-delete trigger. Staff password resets preserve staff permissions.

## Backup execution

`owner_request_backup` authorizes an active owner and stores a durable job in an unexposed, RLS-protected schema. `.github/workflows/owner-operations.yml` runs every five minutes, serializing with the daily 05:00 Asia/Damascus backup. GitHub scheduling can be delayed; the UI shows queue/stage/result rather than promising instant completion. Existing GitHub DB/B2/Supabase S3 secrets remain only in runner environments. Every backup is age-encrypted and downloaded from B2 for SHA-256 verification before a verification sidecar is created. The worker paginates the B2 catalog, and missing/unchecked files cannot be restored or downloaded through the console. Download links are private, expire after ten minutes and are never logged.

Restore requires the original recovery-key file, chosen locally. WebCrypto RSA-OAEP-SHA256 encrypts the identity before it leaves the browser. A purpose-separated HKDF/AES-GCM key derived from the existing DB credential encrypts the worker's transport private key. No recovery identity is persisted as plaintext or added as a long-lived secret. Envelopes are scrubbed after processing. DB-password rotation creates a new transport key; old pending envelopes may need to be submitted again.

## Restore boundaries

The worker verifies encryption/checksum/project/file hashes, parses only PostgreSQL COPY data into a private isolated PostgreSQL database, and rejects incompatible columns/table sets before maintenance. It never executes backup functions, triggers, role changes or arbitrary SQL. Current schema/migrations, infrastructure configuration, subscription terms/audit and all registered owner identities remain current. Business rows and subscriber Auth users/identities are restored; historical invitation approvals are revoked, subscriber sessions/MFA challenges are invalidated and device registrations must reconnect. Owner sessions/credentials survive. Existing bucket configuration is preserved; buckets recreated from older format-1 snapshots start private because those snapshots did not contain bucket policies.

Before writes, the worker enables a restrictive maintenance gate, drains business/Auth writes with table locks and uploads a fresh verified safety backup. Business data and nonowner Auth replacement run inside one transaction; Storage is restored and read back through S3 before SQL commit. A Storage failure rolls SQL back and restores staged safety files. An interrupted process or incomplete rollback keeps the application locked with `recovery_required`; an operator must inspect the safety backup and finish recovery before unlocking. No production restore is performed merely to test this feature. External services writing with privileged credentials must be coordinated during any restore; the gate controls application users, not unrelated superuser tools.

## Monitoring and cleanup

Metrics include database size, per-table/index size and estimated rows, Storage counts/metadata sizes/buckets, connections, transaction/cache/deadlock counters, and available pg_stat_statements execution averages. Time stamps and counter reset times are displayed. Browser-to-server request latency is labeled separately. CPU/RAM/hosting-plan limits are explicitly unavailable rather than estimated.

Cleanup deletes only registered expired `owner-temp/` files whose ETag still matches. A restrictive Storage policy makes registered disposable files immutable/inaccessible from client sessions; the serialized worker alone removes them. There is deliberately no heuristic deletion of unreferenced images or backup archives, no direct Storage metadata SQL deletion, and no VACUUM FULL/production cache reset. Empty candidate lists are normal until a trusted producer registers temporary exports. Local cache cleanup retains the active offline bundle, one fallback, all shell caches, unrelated caches, local data and Auth; it affects this browser/origin only.

## Validation

Node/PGlite tests cover owner/account protections, exact role transfer, revocation, private tables, backup queue idempotence and maintenance/session cutoff. Browser tests cover real UI actions, encrypted recovery envelopes, confirmation, safe cache selection and 320/390/1440 layouts. PostgreSQL integration tests restore actual COPY data, preserve owner terms/credentials, invalidate subscriber sessions and verify SQL/Storage rollback with injected transport failure. On merge, the production verifier compares migration text and deployed function bodies/policies to source. The first worker deployment also creates a verified B2 backup and checks its private presigned download without exposing the URL.
