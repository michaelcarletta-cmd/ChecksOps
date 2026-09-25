# S14 deposit payee_line protection — production regression safeguards

**Date:** 2026-09-25  
**Scope:** Safeguard / test / CI work only. No production Lambda, SQL, flag, or provider change.  
**S14:** CLOSED / PRODUCTION PASS. Accepted production baseline at install: `zb7E5ptHPmRsBegkIFgNzq3rzBktHvpNCJ1QMTHM6l0=`.  
The safeguard does **not** permanently pin that SHA.

## Where it runs

Existing AWS API pre-deploy guardrail:

```bash
npm run test:aws-api
```

CI: `.github/workflows/aws-migration-ci.yml` → `bun run test:aws-api` (picks up `aws/tests/*.test.mjs`).

Labeled pre-deploy entry that also re-runs closed-item unit regressions:

```bash
npm run test:s14-safeguard
```

Failure output always includes `S14 Deposit Payee Line Protection`.

## Files added/changed

| Path | Role |
| --- | --- |
| `aws/tests/s14-deposit-payee-line-safeguard.test.mjs` | Behavioral + mutation safeguard |
| `aws/tests/lib/s14-deposit-payee-line-safeguard.mjs` | Shared invariant/mutation helpers |
| `scripts/aws-s14-deposit-payee-line-safeguard.mjs` | Pre-deploy runner + S2/S3/S4/S5/S11 regressions |
| `package.json` | `test:s14-safeguard` |
| `aws/audit/S14_PRODUCTION_SAFEGUARDS.md` | This record |

No runtime file was changed.

## Invariants protected

1. Pre-deposit `payee_line` correction remains permitted on authorized `/data/write`.
2. `deposited_at IS NOT NULL` → `payee_line` cannot materially change.
3. Confirmed provider deposit → lock even if `deposited_at` is null.
4. Confirmed deposit means `checkalt_deposit` + `provider_confirmed` / `settled` only.
5. Lookup failure fails closed.
6. Same-value post-deposit request is a no-op.
7. `/data/write` cannot bypass the lock.
8. `claim_checks` cannot bypass the lock.
9. OCR descriptive persist cannot overwrite after deposit.
10. `persistOcrDescriptiveHandoff` cannot bypass the lock.
11. Existing-row ingest cannot overwrite after deposit.
12. `payee_line` is not placed into `INTAKE_PROHIBITED_COLUMNS`.

Writer coupling also fails if `executeIntakeUpdate`, `executeClaimChecks`, OCR, OCR persist, or ingest stop calling `check-deposited.mjs`, or if a new existing-check `payee_line` UPDATE appears without the helper.

## Mutation probes (local copies only)

| Candidate mutation | Safeguard result |
| --- | --- |
| Remove confirmed-provider detection | FAIL |
| Change lookup to fail-open | FAIL |
| Remove `deposited_at` detection | FAIL |
| Delete helper exports | FAIL |
| Strip writer helper calls | FAIL |
| OCR persist bypass | FAIL |

Staging and production runtimes are not mutated.

## Cross-protection

The runner re-executes existing unit suites:

- S2 / S3: `endorsement-material-invalidation.test.mjs`
- S4: `api-workflow.test.mjs`, `checkalt-endorsement-gate.test.mjs`
- S5: `api-write.test.mjs` (generic `claim_id` remains prohibited)
- S11: `financial-remaining.test.mjs`, `api-financial.test.mjs`

Those suites are not replaced.

## S14 SAFEGUARD: PASS
