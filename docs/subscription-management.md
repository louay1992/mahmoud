# Single-company annual subscription

The customer administrator has a read-only «إدارة الاشتراك» destination on desktop and in the phone More menu. It shows the start/end dates, current status and annual renewal amount in the subscription's own currency. Expiry is evaluated by the database using the Damascus calendar date, including the final day. After the final contract day, business access stops for administrators, staff and captains. Payments and paid extras are not implemented.

The operator uses `/owner.html` (or `/owner`) to edit terms. It has a separate Auth storage key, owner-only RPCs, optimistic revisions and an immutable change log. Being a full company administrator is not sufficient to edit a subscription. Tables have no client read/write grants and use RLS; even the owner edits through validated RPCs only. An unconfigured subscription displays an honest empty state; there are no invented dates or prices.

## First setup

1. Apply the versioned migration through the normal deployment pipeline.
2. Choose a private Supabase Auth account for the system owner. Use an account whose credentials are not shared with the subscriber's company administrators. Create the account through Supabase Auth if needed; credentials and email addresses do not belong in the repository.
3. In a privileged database session, register that existing Auth user's UUID:

```sql
insert into public.subscription_owners(user_id) values ('OWNER_USER_UUID');
```

4. Sign in at `/owner.html` and enter the actual agreed start date, last valid date, renewal amount and currency. No production owner or subscription record is created by the migration.

### Password setup by email

Set the project's Auth Site URL to the deployed HTTPS `/owner.html` URL. The login page can request a password setup email with that exact redirect. Existing verified owner accounts use Supabase's password recovery flow; the link proves mailbox access before showing the password form. The Supabase SDK validates the callback session, and the server owner check must succeed before the form is enabled. Expired links show a request-again state. A new recovery callback can start a new session after a local logout, while clearing any old stored session first.

The owner enters and confirms the new password themselves. The page calls `updateUser`, clears both password fields and signs out locally after success, then asks for a fresh login. Passwords never enter the repository, subscription tables or logs. The recovery screen survives a refresh within the same tab; cancelling clears it and signs out. There is no public registration or role assignment route.

The company's password-setting Edge Function checks `subscription_owners` before resetting any existing account, including an inactive owner. It fails closed if that protection cannot be checked. This prevents a company administrator from adding the owner's email as a staff/captain account and then using the service-backed reset endpoint to take over the owner account. Deploy the database before the password function.

To revoke owner access, a privileged operator sets `subscription_owners.active=false`. The account remains protected against company password resets. No customer-facing endpoint can assign owner roles. Owner access is not cached for offline use; owner pages are excluded from both offline packages.

## Verification

- Actual full migration chain: independent owner versus full company admin, staff, captain and anonymous role; protected tables, immutable audit, invalid input, active/expired/upcoming terms, stale revisions and revoked owners.
- Real PostgreSQL concurrent edits: one revision wins and exactly one audit entry is saved.
- Browser: customer currency independent of business cash currency, read-only view, honest unconfigured/error states, stale response cancellation, phone/desktop layout, owner login/denial, saving and logout during a pending save.
- Existing desktop screenshot fixtures receive only the deliberately added navigation item. Their original content comparisons remain strict.

## Future paid services

The response has a schema version and a plan code so catalogues, plans and entitlements can be added later without changing the current single-company model. Future purchases should use server-owned catalogue prices and immutable order price snapshots, with separate payment confirmation. The current empty additions area has no purchase button and performs no financial action.

## Subscriber administrator invitations

The owner page has a separate subscriber-admin email form and an invitation list. `owner-invite-admin` verifies the caller's Auth identity and the private owner allowlist; a full company administrator cannot invoke it. Its service-only reservation serializes duplicate sends and enforces a one-minute cooldown per email. Owner accounts, including inactive owners, and captain emails cannot become subscriber administrators through this flow. An existing Auth email receives a recovery link; a new email receives an invitation. Both redirect to the exact deployed `/account-setup.html` URL, which must be added to Auth Redirect URLs. The owner Site URL remains `/owner.html`.

`subscription_admin_invites` is private and has RLS with no direct client grants. No business-admin role is created on reservation or a failed email request. The setup page first requires a confirmed Auth email and a server-approved invitation. The user chooses the password through the Auth SDK, then `complete_admin_setup` checks the authoritative Auth row and creates the full company-admin role. Auth user metadata cannot grant roles. A revoked owner approval blocks a pending activation. Retrying activation does not resubmit a password, and an old activated invitation cannot restore a deleted or downgraded admin role. All owner invitation reads and sends are cleared or ignored after logout.

The admin login has «نسيت كلمة المرور؟», and account settings can send a reset link to the current admin email. Requests use Supabase's generic result to avoid revealing account existence. The setup page also supports already-authorized staff/admin resets without granting new permissions. Successful setup signs out the temporary setup session and returns to a fresh admin login. Owner accounts use their separate owner recovery flow.

### Hosted email delivery

Configure custom SMTP in Supabase Auth before inviting external subscribers. The built-in service only sends to project-team addresses and is not a production email provider. This is a deployment dependency: request failures are shown honestly and recorded as failed invitation delivery. SMTP credentials belong only in the provider's secure settings, never in source or client assets. Do not add subscribers to the Supabase project team as a workaround.

The `/account-setup*` paths use no-store/noindex/no-referrer headers, are excluded from offline shells and Android bundled assets, and never expose verification links through the owner endpoint. Tests cover actual migration permissions/activation, send failure, stale results and duplicate-send concurrency, plus phone layouts and the complete password/activation UI with synthetic Auth fixtures.


## Owner workspace and expiry enforcement

The owner console has an overview, subscription editor, administrator search/status filters, and an expandable audit showing old and new values for the latest 20 changes. Summary counts explicitly cover invitations created from the owner console, not every historical company administrator. Drafts stay local in memory; saving requires a review dialog. Discard restores the saved record. Extending a still-valid contract keeps its original start and extends the end by one inclusive calendar year. Renewing an expired contract starts today according to the server's Damascus date. No payment is collected by these actions.

`subscription_access` is a fresh server read before either app loads any business data. It gives full company administrators renewal terms, while staff/captains receive only validity data. The last contract day is inclusive: the lock begins at midnight in Asia/Damascus following `valid_until`. An unconfigured installation continues operating until the owner defines actual terms; migrations never fabricate a trial or change live commercial values.

The migration installs `enforce_subscription_request` as the PostgREST pre-request hook and fails if an unrelated hook is already configured. It blocks business tables, views and RPCs with HTTP 402 after expiry, including older connected clients. Narrow subscription/owner/password-setup RPCs remain available and perform their own role checks. `is_admin`, `has_perm` and `my_captain_id` also deny expired business authorization, and restrictive RLS policies AND existing authorization on every current public business table and Storage objects. When adding business tables, include the same restrictive policy. Notification target RPCs return no targets after expiry. Service backup operations remain available.

Both updated apps show a dedicated expired-subscription screen, clear business state and private offline snapshots, stop realtime channels, and provide a renewal recheck and sign-out. Open apps schedule the lock from server `expires_at`, corrected for the device/server clock offset, and check again on foregrounding. Offline snapshots carry their verified expiry; old snapshots without this data require an online check. No offline client can learn a contract shortened remotely until it reconnects; the server always refuses expired operations. Previously installed/cached clients must receive the updated interface to show the new screen and enforce its offline viewing behavior. Renewing in the owner console takes effect on the server immediately; the subscriber's recheck performs a fresh authorized boot.

Verification covers full migration-chain role/RLS enforcement, last-day validity and Damascus midnight, owner access during expiry, immediate recovery after renewal, annual leap dates, draft review/discard, invitation filters, before/after audit values, 320/390/1440px layouts, expired boot without any business request, an already-open app expiring, and offline snapshot restoration.
