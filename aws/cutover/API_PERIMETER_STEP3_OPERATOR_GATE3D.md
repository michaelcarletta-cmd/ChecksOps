# Privileged-operator Gate 3D path

**DO NOT EXECUTE FROM THIS PR.** Keep `ChecksOpsCursorApiPerimeterStep3Temp`
`kms:*` deny. Do **not** broaden that role.

Step3Temp may be unable to `UpdateFunctionConfiguration` with environment
variables because Lambda encrypts env with KMS. This path is for a privileged
operator only. It changes **only** `checksops-production-origin-verify`
environment: preserve every existing variable and flip `ORIGIN_VERIFY_REQUIRE`.

Do not modify CloudFront, WAF, SPA, DNS, Cognito, RDS, Moov, CheckAlt,
provider/financial flags, or `64_financial_activation_grants.sql`.
Do not disable execute-api. Do not delete Step3Temp.
Do not print the secret, hash, prefix, HeaderValue, or `CHECKSOPS_GATE3D_ID_TOKEN`.

## Apply

```
CHECKSOPS_OPERATOR_GATE3D=I_UNDERSTAND_PRODUCTION
CHECKSOPS_OPERATOR_EXECUTE=1
CHECKSOPS_GATE3D_ID_TOKEN=<id token; never print>
node aws/origin-verify/operator-apply-gate3d.mjs
```

Uses Lambda `RevisionId`. Validates authenticated `/prep/data/query` (token
required; skipped is not a pass). Automatic rollback on CloudFront/API failure.

## Rollback

```
CHECKSOPS_OPERATOR_ROLLBACK_GATE3D=I_UNDERSTAND_PRODUCTION
CHECKSOPS_OPERATOR_EXECUTE=1
node aws/origin-verify/operator-rollback-gate3d.mjs
```

Sets `ORIGIN_VERIFY_REQUIRE=false` only, re-reads the Lambda, requires that
flag is `false`, then checks CloudFront and raw `/prep/health`. Exits fatal
`GATE3D_ROLLBACK_FATAL` if that cannot be confirmed.

Refuse unless AWS account is `806168576068`. Refuse if the caller ARN
contains `ChecksOpsCursorApiPerimeterStep3Temp`. Do not broaden that role.

`waitForLambdaReady` returns only when `State=Active` and
`LastUpdateStatus=Successful`. `Active` alone is not enough. `Failed`
exits immediately with a sanitized reason. A stuck `InProgress` update
times out closed.
