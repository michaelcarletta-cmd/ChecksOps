# Tax/1099 TIN containment SQL — NOT SAFE TO APPLY / DESIGN ONLY

**Do not apply these files.** They are design-only artifacts for review. They are
intentionally **not** under `supabase/migrations/`, **not** under
`aws/migrations/proposed/` as a runnable oneshot, and **not** referenced by any
Lambda oneshot or migration runner.

## Location (required)

All SQL lives in `unapplied-do-not-run/` with a `NOT_APPLIED_` filename prefix
so glob-based runners that pick up `*.sql` from known apply directories cannot
see them:

- `unapplied-do-not-run/NOT_APPLIED_80_recipient_tax_profiles_containment.sql`
  — transactional, fail-closed policy tighten + additive encryption columns.
  Does **not** backfill, encrypt, decrypt, update, or delete existing `tin`
  values. Does **not** ENABLE extra RLS or REVOKE authenticated PostgREST
  grants (that is a separately reviewed production database-security PR).
- `unapplied-do-not-run/NOT_APPLIED_80_recipient_tax_profiles_containment.down.sql`
  — drops additive columns and restores the previous AWS policies. Does **not**
  touch `tin`. Do not weaken this down script.

Do not run either file against any live database unless a later change
explicitly authorizes it.

Until applied:

- AWS generic `/data/query` and `/data/write` deny `recipient_tax_profiles` in
  application code **before** allowlist processing, including schema-qualified,
  quoted, case, whitespace, alias, embed, join, and RPC workarounds.
- The dedicated `tenant-tax-profiles` handler is the only browser path for
  tax-profile operations and returns masked metadata only.
- Postgres still stores plaintext `tin` (existing rows are left as-is).
- Production Lovable PostgREST GRANT/RLS for this table is unchanged by this PR.

## Remaining out of scope (do not add here)

- Encryption-at-rest of `tin`
- Production PostgREST grant/RLS containment
- `tenants.ein`, Moov KYC, service-role architecture, 1099 filing rules
