# Payments & Financials editability — read-only fresh-read

**Date:** 2026-10-05T00:27Z  
**Authorization:** diagnosis only. No deploy. No Lambda/SPA/SQL/Moov/data writes.

## Staging (stable vs Payments compose apply)

| Target | Value |
|---|---|
| SPA entry | `/assets/index-DxJGUt9C.js` |
| `index.html` SHA-256 | `29a7fa5a6948ebf2e20136cfead50ae4c978d2ded986f2e98487b702446a1606` |
| `index.html` last-modified | `2026-10-05T00:08:03+00:00` |
| Lambda | `checksops-staging-api` |
| CodeSha256 | `/0Wyipd63VyUCg97uzp4ppFHAnC9RLHeqBNOJCZZth8=` |
| RevisionId | `a7ace3ea-006c-423e-a26d-87857c1e696a` |
| LastModified | `2026-10-04T20:34:40.000+0000` |
| `AWS_WRITES_ENABLED` | `true` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `true` |
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |

## Production (observed; do not touch)

| Target | Value |
|---|---|
| SPA entry | `/assets/index-Bbftik1r.js` |
| Lambda `checksops-production-prep-api` CodeSha256 | `RUOC6wUAE9eCkhbhF8h8FAfUyegj9KCrvZt5vCojOlw=` |
| RevisionId | `48b8b0da-7448-435b-b9ea-d068a4497f1e` |
| LastModified | `2026-10-05T00:15:53.000+0000` |

Production moved after the Payments SPA compose. This workstream did not change it.

Diagnosis: `docs/audits/PAYMENTS_FINANCIALS_EDITABILITY_DIAGNOSIS.md`
