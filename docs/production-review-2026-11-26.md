# Production integrity review — 2026-11-26

Reviewed production project `jabapvnmfdflysxfxwwf`, published web commit `bcef4101d770310a6a5739a5e6facfff7554aa0e` and all 58 public function definitions, policies, triggers, constraints, views and function ACLs.

Production already contained the correct full-admin check, NULL-safe ownership guards, capital/cost snapshots and captain-to-warehouse binding. Those definitions were missing from a complete fresh installation. The new migration preserves those live definitions and permissions, including notification triggers, so the repository can reproduce production.

The migration additionally enforces active captain identity; serializes warehouse/product stock operations in a consistent lock order, including missing stock rows; returns delivered stock to the historical source; forbids changing shipped item quantities; and retires the production data-reset RPC. No business rows are changed.

Notification grouping IDs and order IDs now travel separately. Both native and Web subscribers receive the actual order deep link. Open work is loaded independently of bounded terminal history, with RLS enforced by an invoker RPC. Carrier totals and financial statements cover the full server ledger rather than partial REST lists. The password function has a pinned SDK, an eight-character minimum and origin-restricted CORS; web security headers and removal of the reset control are included.

## Verification

- 84 Node tests pass, including a full installation of the real schema and all migrations under simulated Supabase Auth and an isolated pg_net spool. Business functions are not stubbed.
- Real PostgreSQL concurrent sessions: two deliveries competing for insufficient shared stock yield one success and one rejection; opposing transfers finish without deadlock and conserve stock.
- Full accounting, pricing approvals, returns, stock invoices, shipping, cost preservation, role isolation, inactive sessions, notification payload and a ledger with more than 3,000 entries are covered. Reapplying the migration preserves business rows.
- Project validation, public build and Android notification wiring pass.
- Browser checks pass for authentication, offline reads, refresh, diagnostics, native bridge, updates, workspace, phone operations and motion. A serverless Chromium executable was used locally because the usual browser download is unavailable. The full platform-notification test cannot complete on that executable; the captain desktop pixel test reports only one-level colour differences. Required CI retains the original strict checks.
- Native Android binaries were not changed or rebuilt locally. Physical device notification delivery was not certified.

## Deployment order

1. Apply `20261126163501_production_review_integrity.sql` and record its exact source in the migration journal. Verify definitions, ACLs, triggers, policies and source digest.
2. Deploy `admin-set-password` with its shared helper, or the equivalent generated dashboard bundle from `node scripts/prepare-deployment.cjs`. Preserve existing authentication settings.
3. Merge through normal branch protection, let Netlify publish main, then compare the live deployment commit, web build IDs and asset hashes. Verify allowed-origin and foreign-origin preflights.

GitHub Actions attempts were rejected before running jobs because the GitHub account is locked for billing. Local results do not replace required checks or justify bypassing branch protection. Release completion must be reported separately from preparation and from backend-only application.

## Applied backend result

The production migration was applied successfully. Its full journal source has MD5 `37a8f97d1aa36934cd91f96d1e69c4f0`, matching the checked-in file. All 63 live function bodies, security-definer flags and search-path settings match a fresh installation of the repaired repository. Existing policies, triggers and effective function execution ACLs are preserved, with the reset RPC revoked and the nonnegative stock constraint validated.

The downloaded live admin-set-password bundle matches the generated upload byte for byte. Live public endpoint, unauthenticated device rejection, foreign-origin rejection and allowed password-origin preflight checks pass.

A normal merge of PR #17 was attempted and rejected with `3 of 3 required status checks are failing`. The checks did not start their steps because the account is locked for billing. Netlify production remains on `bcef4101d770310a6a5739a5e6facfff7554aa0e`; frontend publication and CI/device validation remain pending. No protection was bypassed.

## Release retry and migration history

After billing was resolved, all required Node, browser, real PostgreSQL and Android jobs passed. PR #17 merged as `6e8e0eedb46f7662df5c55465ccefc65bd241ba2`; Netlify production deploy `6b0880ffb9eea21228ce3172` published that commit. Forty-one of 42 public files matched byte for byte; the landing page differed only in Netlify's two pretty-URL link rewrites, and matched after reversing those two transforms. Live migration and function-source digests were rechecked.

The separate Supabase integration then reported `Remote migration versions not found in local migrations directory`. Production retained 22 original migration records that had been consolidated into `schema.sql` but never saved as individual files. They are now restored with their original versions, names and exact statement bytes. `supabase/historical-migrations.json` records the observed original MD5 values; no production history is deleted or rewritten and no old migration should be replayed there.

Fresh installation now executes the complete migration chain, without a preliminary `schema.sql` import. The full-system fixture follows that same path and checksums guard the recovered history against accidental edits. Local fresh-install and real PostgreSQL concurrency tests validate the restored chain. The historical chain also revealed an obsolete eight-argument create_order overload absent from live production. A new migration retires it so fresh installs have the same unambiguous API; it is a no-op on the existing production schema. Published frontend assets are unchanged.
