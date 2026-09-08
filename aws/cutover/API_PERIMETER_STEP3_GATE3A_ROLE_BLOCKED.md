# Gate 3A BLOCKED — Step 3 temp role missing

**STOP FOR REVIEW. Gates 3A–3C were not applied.**
`ORIGIN_VERIFY_REQUIRE` was not set. Execute-api remains enabled.
`$default` is still `AuthorizationType=NONE`. No origin-verify authorizer
is attached. SPA / WAF / DNS / RDS / Cognito / prep Lambda were not changed.

Caller audit is **PASS** (operator privileged list).

## Why

`ChecksOpsCursorApiPerimeterStep3Temp` does not exist. Staging cannot
`iam:CreateRole`, `iam:CreatePolicy`, or `iam:PassRole`. Steps12Temp is
denied Lambda / Secrets Manager / API Gateway and must not be broadened.

Apply scripts in `aws/origin-verify/apply-gate3a.mjs` (and 3B/3C) are ready.
They require that OIDC role plus `CHECKSOPS_STEP3_EXECUTE=1`.

## Leftover from this turn (cleaned / retained)

A staging permission probe briefly created:

- Authorizer `dq5sbq` on `kiqojucc02` — **deleted before attach**. `$default` stayed NONE.
- Secret `checksops/production/cloudfront-origin-verify-probe-do-not-use` — **force-deleted**.
- CloudFormation stack `checksops-cursor-api-perimeter-step3-role` with
  `DeployRole=true` — **CREATE failed** (no `iam:CreatePolicy`). Stack
  **deleted**. Execution role `checksops-production-origin-verify` was
  **retained** (exists; staging cannot PassRole to it).

Live `GET https://checksops.com/prep/health` still JSON `ok`.
`holds.ok=true`. `productionExecution=false`.

## Operator action (privileged IAM, not staging)

Follow `aws/cutover/API_PERIMETER_STEP3_OPERATOR_HANDOFF.md`.
Create **only** `ChecksOpsCursorApiPerimeterStep3Temp` from
`aws/production/cursor-api-perimeter-step3-temp-role-only.yaml`.
Inspect leftover `checksops-production-origin-verify` read-only.
Do not change or delete it. Do not deploy Gate 3A–3C from that handoff.

Do not broaden staging. Do not recreate deleted hardening roles.
Do **not** begin Gate 3D.
