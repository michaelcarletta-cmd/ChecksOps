# Phase 1 freeze and cross-build overwrite protection

**Date:** 2026-09-25  
**Scope:** Guardrail / release-safety only. No production or staging deploy. No SQL execution. No Lambda, IAM, VPC, Cognito, provider, tenant, or financial mutation.  
**Phase 1:** COMPLETE / PASS — 15/15 CLOSED — 0 BLOCKERS

This freeze does **not** redesign Phase 1. It treats the accepted behavior as a protected production contract and stops both directions of accidental overwrite:

1. A future build must not silently remove or regress accepted Phase 1 behavior.
2. A future Phase-1-derived build must not overwrite newer unrelated live production files or configuration.

## Authoritative records

| Item | Value |
| --- | --- |
| Machine-readable manifest | `aws/audit/phase1-freeze-manifest.json` |
| Closure documentation | `aws/audit/PHASE1_ADVERSARIAL_MONEY_PATH.md` |
| Phase 1 status | COMPLETE / PASS |
| Official matrix | S1–S15 |
| Remediated and mandatory | S2, S5, S11, S14 |
| Closure production SHA | `zb7E5ptHPmRsBegkIFgNzq3rzBktHvpNCJ1QMTHM6l0=` |
| SHA pin policy | `historical_provenance_only` |

The closure SHA is provenance, not a permanent pin. Future accepted deployments may advance production. Once production advances, the new live SHA is the next baseline. Phase 1 protection follows the behavioral invariants; deployment safety follows the current live package.

## CI (ordinary PR / unit tests)

Existing mandatory path is unchanged:

`.github/workflows/aws-migration-ci.yml` → `bun run test:aws-api` → `aws/tests/*.test.mjs`

That glob already includes:

- `s2-material-endorsement-invalidation-safeguard.test.mjs`
- `s5-audited-claim-association-safeguard.test.mjs`
- `admin-set-check-claim.test.mjs`
- `financial-remaining.test.mjs`
- `api-financial.test.mjs`
- `s14-deposit-payee-line-safeguard.test.mjs`
- `check-deposited.test.mjs`
- `phase1-freeze-safeguard.test.mjs`

Those suites do **not** require production AWS credentials. A candidate that fails an accepted Phase 1 invariant is not promotable.

Local freeze entry points:

```bash
npm run test:phase1-freeze
npm run phase1:freeze-preflight
```

## Production promotion / preflight

Official production path: `scripts/aws-production-overlay.mjs`

| Mode | AWS | Mutation | Requirement |
| --- | --- | --- | --- |
| default | none | none | local Phase 1 invariant + script isolation |
| `--live-preflight` | read-only get-function + zip download | none | `--baseline-sha` and explicit `--file` / `--remove` |
| `--apply` | UpdateFunctionCode only | code overlay | `--apply` + `CHECKSOPS_PRODUCTION_DEPLOY=1` + `--baseline-sha` + passing preflight + SHA recheck |

There is no force-through path. Staging overlay (`scripts/aws-overlay-staging-api.mjs`) refuses a production function name.

The production path:

1. Fetches current production Lambda metadata and `CodeSha256`.
2. Downloads the current live package.
3. Compares the candidate against that live package, not an old repository snapshot.
4. Requires the candidate’s recorded baseline SHA.
5. Fails closed if live SHA ≠ candidate baseline SHA.
6. Starts the overlay from the live package and applies only explicitly accepted files.
7. Treats unexpected live-only or candidate-only differences as STOP.
8. Treats file deletion as explicit only. Absence from a candidate branch never means delete.
9. Rechecks `CodeSha256` immediately before `UpdateFunctionCode`. If it changed: `ABORT. PRODUCTION CHANGED SINCE PREFLIGHT.`
10. Never calls `UpdateFunctionConfiguration`.
11. Never executes SQL, including accepted S5 `71_admin_set_check_claim.sql`.

Configuration drift (Lambda environment, IAM, VPC, Cognito, provider/tenant/Moov/CheckAlt/financial flags, SQL/schema) is reported. It is not normalized from an older repository or staging baseline.

## Protected runtime components

| Scenario | Contract | Protected files |
| --- | --- | --- |
| S2 | Material payee change invalidates endorsements | `endorsement-material-invalidation.mjs`, `write-check-workflow.mjs` |
| S5 | Audited `admin_set_check_claim`; generic `claim_id` stays prohibited | `workflow-rpc.mjs`, `write-allowlist.mjs`, SQL contract `71_admin_set_check_claim.sql` (record only) |
| S11 | Remaining = confirmed in − confirmed out; `requested_partial_cents`; `seq:N` | `financial-remaining.mjs`, `financial.mjs`, `financial-idempotency.mjs` |
| S14 | `payee_line` locked after `deposited_at` or confirmed provider deposit | `check-deposited.mjs`, write/OCR/ingest callers |

Branch-continuity question every candidate must answer:

> Does this candidate preserve every frozen Phase 1 production invariant while also preserving unrelated live production files that it does not intentionally modify?

If the answer is not demonstrably YES, promotion fails.

## Promotion manifest

Before any production overlay, the preflight writes a machine-readable manifest containing:

- production SHA before deployment
- candidate baseline SHA
- files intentionally added / modified / removed
- unexpected live-only differences
- unexpected candidate-only differences
- configuration drift (reported, not applied)
- `sqlExecuted: false`
- `configurationUpdated: false`

Any unexpected difference is FAIL CLOSED. Drift is not auto-resolved.

## Safety

This freeze does not deploy, apply SQL, change Lambda configuration, or replace the live Lambda with a repository zip.
