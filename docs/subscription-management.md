# Single-company annual subscription

The customer administrator has a read-only «إدارة الاشتراك» destination on desktop and in the phone More menu. It shows the start/end dates, current status and annual renewal amount in the subscription's own currency. Expiry is evaluated by the database using the Damascus calendar date, including the final day. This release displays terms; it does not block business operations, take payments or enable paid extras.

The operator uses `/owner.html` (or `/owner`) to edit terms. It has a separate Auth storage key, owner-only RPCs, optimistic revisions and an immutable change log. Being a full company administrator is not sufficient to edit a subscription. Tables have no client read/write grants and use RLS; even the owner edits through validated RPCs only. An unconfigured subscription displays an honest empty state; there are no invented dates or prices.

## First setup

1. Apply the versioned migration through the normal deployment pipeline.
2. Choose a private Supabase Auth account for the system owner. Use an account whose credentials are not shared with the subscriber's company administrators. Create the account through Supabase Auth if needed; credentials and email addresses do not belong in the repository.
3. In a privileged database session, register that existing Auth user's UUID:

```sql
insert into public.subscription_owners(user_id) values ('OWNER_USER_UUID');
```

4. Sign in at `/owner.html` and enter the actual agreed start date, last valid date, renewal amount and currency. No production owner or subscription record is created by the migration.

The company's password-setting Edge Function checks `subscription_owners` before resetting any existing account, including an inactive owner. It fails closed if that protection cannot be checked. This prevents a company administrator from adding the owner's email as a staff/captain account and then using the service-backed reset endpoint to take over the owner account. Deploy the database before the password function.

To revoke owner access, a privileged operator sets `subscription_owners.active=false`. The account remains protected against company password resets. No customer-facing endpoint can assign owner roles. Owner access is not cached for offline use; owner pages are excluded from both offline packages.

## Verification

- Actual full migration chain: independent owner versus full company admin, staff, captain and anonymous role; protected tables, immutable audit, invalid input, active/expired/upcoming terms, stale revisions and revoked owners.
- Real PostgreSQL concurrent edits: one revision wins and exactly one audit entry is saved.
- Browser: customer currency independent of business cash currency, read-only view, honest unconfigured/error states, stale response cancellation, phone/desktop layout, owner login/denial, saving and logout during a pending save.
- Existing desktop screenshot fixtures receive only the deliberately added navigation item. Their original content comparisons remain strict.

## Future paid services

The response has a schema version and a plan code so catalogues, plans and entitlements can be added later without changing the current single-company model. Future purchases should use server-owned catalogue prices and immutable order price snapshots, with separate payment confirmation. The current empty additions area has no purchase button and performs no financial action.
