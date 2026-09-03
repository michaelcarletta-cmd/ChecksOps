# Real provider UAT / sandbox validation results

Branch `cursor/real-provider-uat-validation-c48b` from current `main` `1b7559decb0a0bd95a3b717f543642bdb22a5fff` (merged PR #100).

**Production was not touched. No production provider transaction occurred.**

This phase does **not** execute `PRODUCTION_ACTIVATION_RUNBOOK.md`.

## Isolation (before any provider HTTP)

| Check | Result |
| --- | --- |
| `AWS_PROVIDER_EXECUTION_ENABLED` | must remain `false` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | must remain `false` |
| All production `AWS_*_ENABLED` provider flags | must remain `false` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | may be `true` (staging only) |
| CheckAlt host allowlist | only `https://uatapi.checkalt.com` |
| CheckAlt merchant allowlist | only `lockbox5` |
| Moov keys | only `MOOV_SANDBOX_*`; production keys refused |
| Production RDS provider IDs | must not overlap sandbox objects; HTTP stopped on overlap |
| Sandbox writes | `aws_provider_sandbox_*` only |
| Production ledgers | not writable by these tests |

If environment classification cannot be proven, that provider's HTTP is stopped.

## Moov API version (not changed)

| Item | Value |
| --- | --- |
| Current production pin | `x-moov-version: v2024.01.00` (`supabase/functions/_shared/moovClient.ts`) |
| Invoice exception only | `v2026.07.00` in `moov-invoice` |
| Sandbox adapter pin | `v2024.01.00` (unchanged) |
| Moov docs default when header omitted | `v2024.01.00` |
| Moov docs current stable | `v2026.07.00` (`v2026.10.00` in development) |
| Amount compatibility | `amount.value` remains integer USD cents on both pins. Newer versions add `amount.valueDecimal` / `amountDetails` (tax, tip, surcharge). |
| Recommendation | **Keep `v2024.01.00`.** Do not bump until a dedicated PR adds tests for the newer amount fields. Silent version changes are forbidden. |

## CheckAlt `userAmount` unit

Authoritative evidence that `userAmount` is **integer cents** (not dollars):

1. Production `checkalt-submit-deposit` records CheckAlt support guidance: `$123.45 → 12345`. Sending dollars caused **RDC Amount Mismatch** against OCR cents.
2. ChecksOps `providers/amounts.mjs` and T6 certification use the same map.
3. Adapter conversion is 1:1: ChecksOps integer cents === CheckAlt `userAmount`.

Fixtures: `$0.01 → 1`, `$1.00 → 100`, `$123.45 → 12345`.

Rejected: zero, negative, over configured maximum, more than 2 decimal precision, browser-supplied amounts.

UAT auth path requested for this phase: `POST /public/jwtauth/authenticate`. Same-host fallback only if that path returns 404: `/public/fincapture/authenticate` (production path). Host never changes.

Images, if required, are a synthetic 1×1 PNG labeled non-negotiable. No real check is submitted.

## Live results

Filled after staging overlay and isolation-first live run. Secret values are never recorded.

| Item | Result |
| --- | --- |
| Credential availability | pending live inspect (keys present/absent only) |
| Moov environment | pending |
| Moov real HTTP | pending |
| CheckAlt UAT HTTP | pending |
| Financial aggregates | must match PR #100 / T6 baseline |
| Cutover | **NO-GO** unless live HTTP + provider-side idempotency are proven |

## Production confirmation

- Do not enable `AWS_PROVIDER_EXECUTION_ENABLED`
- Do not enable `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`
- Do not enable production provider flags
- Do not redirect production webhooks
- Do not change DNS
- Do not deploy production frontend
- Do not change production provider credentials
- Do not run a production transaction
- Do not disable Supabase production
- Do not delete production provider objects
