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

1. Confirm leftover execution role `checksops-production-origin-verify`
   (Lambda trust). If its inline policy is missing, attach secret-read +
   log writes from `aws/production/cursor-api-perimeter-step3-role.yaml`
   (`OriginVerifyExecutionRole`).
2. Create **only** `ChecksOpsCursorApiPerimeterStep3Temp` + its allow/deny
   managed policies from the same template (do not recreate the execution
   role if it already exists). Or create the OIDC role from
   `cursor-api-perimeter-step3-role-allow.json` /
   `cursor-api-perimeter-step3-role-deny.json` /
   `cursor-api-perimeter-step3-role-trust.json`.
3. Do not broaden staging. Do not recreate deleted hardening roles.

Then Cursor can assume Step3Temp and run Gates 3A–3C observe mode.
Do **not** begin Gate 3D.
