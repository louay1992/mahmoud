# Owner operations console — active extension

Base release ff2a1fcfc73a76c3657922959e47fefeb26035aa is published and verified (PRs 34/36).

User additions: edit/delete subscriber administrator accounts; list/download/restore Backblaze backups; one-button manual backup; monitor DB/Storage/performance; safely remove only known disposable files and stale local cache.

Implementation boundaries:
- Independent owner authorization everywhere; owner identities (including inactive owners) cannot be modified/deleted as company accounts.
- Editing name is immediate. Email replacement uses a verified invitation and keeps old access until the new mailbox completes setup, then transfers the existing permissions and revokes the old administrative role atomically. Deletion revokes role/invites before Auth deletion, with a durable audit/retry status.
- Backups stay encrypted/private. Existing Backblaze/Supabase S3 and DB secrets remain in GitHub Actions. Owner-only durable DB jobs/catalog expose no cloud credentials. A short scheduled worker (every five minutes) executes queued commands; UI shows queued/running/success/error honestly.
- Restore requires the owner to select the recovery key locally and explicitly confirm the selected snapshot. Browser encrypts that identity with a worker transport public key; only an encrypted envelope is persisted, scrubbed after use. Worker transport private key is encrypted with a purpose-separated key derived from its existing DB credential. No recovery identity is copied from Library or persisted as a new long-lived cloud secret.
- Before restore: validate archive/checksums and key, maintenance lock, fresh verified safety backup. Restore business/Auth data through an isolated staging PostgreSQL database into current production schema, preserving owner/Auth identity, subscription/control tables, deployment migrations and infrastructure secrets. Storage uses S3 APIs, never SQL metadata deletion. Roll back SQL and restore staged safety Storage if a step fails; keep maintenance locked if automatic recovery is incomplete. No production restore is executed just to test this feature.
- Metrics use actual PostgreSQL/Storage counters, clearly label collection time and unavailable CPU/RAM/billing data. Cleanup only known registered temporary files; unknown/unreferenced-looking objects are never guessed disposable. Local browser cache cleanup preserves current active bundles, auth, private IndexedDB and server data.
- Test full role protections/leases/email activation; isolated end-to-end backup/restore with synthetic data; UI phone/desktop; live backup creation/download metadata and source/deploy fingerprints. Production restore awaits an owner's explicit in-product action.
