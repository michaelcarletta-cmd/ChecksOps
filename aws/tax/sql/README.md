# Tax/1099 TIN containment SQL — DO NOT APPLY

These files are **design-only** for this pull request.

- `80_recipient_tax_profiles_containment.sql` — transactional, fail-closed policy tighten + additive encryption columns. Does **not** backfill, encrypt, decrypt, update, or delete existing `tin` values.
- `80_recipient_tax_profiles_containment.down.sql` — drops additive columns and restores the previous AWS policies. Does **not** touch `tin`.

Do not run either file against any live database unless a later change explicitly authorizes it.

Until applied:

- AWS generic `/data/query` and `/data/write` deny `recipient_tax_profiles` in application code.
- The dedicated `tenant-tax-profiles` handler is the only browser path for tax-profile operations and returns masked metadata only.
- Postgres still stores plaintext `tin` (existing rows are left as-is).
