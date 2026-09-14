# identity_accounts.cognito_sub writers

Shared RDS `checksops` backs staging and production-prep. There is one
`cognito_sub` column and no pool id. This inventory is the pre-go-live
guard surface. It is not an identity architecture redesign.

## Live writers

| ID | Path | What it writes | Guard |
|---|---|---|---|
| W1 | `aws/identity/oneshot/onboard.mjs` `applyLinks` | `UPDATE` pending + `cognito_sub IS NULL` | Refuses locked production `application_user_id`s. Never sets `request.production_identity_write`. |
| W2 | `aws/identity/oneshot/onboard.mjs` `clearIsolatedTest` + `sql/09_clear_isolated_test.sql` | NULLs tester when `isolated_test` | Tester UUID is one of the 8 locks. SQL excludes locked ids. JS refuses locked tester. |
| W3 | `aws/functions/api/tenant-admin.mjs` `runTenantInviteUser` | `INSERT … ON CONFLICT (cognito_sub) DO UPDATE` | `assertProductionCognitoWriteAllowed`. Staging-like `CHECKSOPS_ENV` cannot touch locked users. |
| W4 | `aws/functions/api/tenant-admin.mjs` `runHireMortgageAgent` | same `INSERT … ON CONFLICT` | Same helper as W3. |
| W5 | Operator SQL repair | Direct `UPDATE identity_accounts SET cognito_sub` | Allowed only when `request.production_identity_write=1`. |

## Database enforcement

`aws/identity/sql/11_protect_production_cognito.sql` seeds
`identity_production_cognito_locks` from the 8 repaired rows and installs
BEFORE UPDATE/DELETE on `identity_accounts` plus BEFORE INSERT/UPDATE/DELETE
on the lock table. Bypass GUC: `request.production_identity_write=1`.

## Non-writers (read or insert-null only)

- `aws/functions/api/identity.mjs` — SELECT by `cognito_sub`
- `aws/identity/sql/07_seed_pending.sql` — INSERT pending with `cognito_sub` NULL
- `aws/identity/sql/08_reconcile_known_users.sql` — read-only
- `aws/db-copy/rehearsal/oneshot/index.mjs` — counts only
- `aws/rls/oneshot/*` — SELECT inventory

No table triggers existed on `identity_accounts` before SQL 11. `CHECKSOPS_ENV`
is a label only; it does not by itself prevent W3/W4. That is why the trigger
and the JS fail-closed checks both exist.
