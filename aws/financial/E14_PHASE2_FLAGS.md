# E14 Phase 2 — CheckAlt flags only

Recorded 2026-09-22T21:49Z. Overlay CodeSha `xt/R8za4uuGndEDN0g82S4wIhR+eBO0sO/RR92u5P/E=` (E13 plus eligibility-select fix). Env count stayed 41.

## Order and effective values

| Step | Flag | After |
| --- | --- | --- |
| 1 | `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `true` (21:48:59Z) |
| 2 | `AWS_CHECKALT_ENABLED` | `true` (21:49:08Z) |
| 3 | `AWS_PROVIDER_EXECUTION_ENABLED` | `true` last (21:49:16Z) |

Held unchanged:

- `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`
- `AWS_CHECKALT_STATUS_RECONCILE_ENABLED=false`
- `AWS_MOOV_ENABLED=false`
- `AWS_MOOV_TRANSFER_POST_ENABLED=false`
- `AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED=false`
- `AWS_PLAID_ENABLED=false`
- `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`

No ACH/RTP/wire Lambda flags exist. Those rails stay closed because Moov stays false.

`/prep/providers/status` after step 3: execution true, CheckAlt true, Moov false, dry-run true, `liveProviderTransactions` still false (status catalog; CheckAlt submit uses `productionCheckAltExecutionAllowed()`).

## Not done in Phase 2

No CheckAlt HTTP. No second flag family. No SQL 65 reapply. No reconcile.
