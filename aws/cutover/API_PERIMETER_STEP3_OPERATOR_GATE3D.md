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
Do not print the secret, hash, prefix, HeaderValue, session, email code, or
ID token.
Do not create Cognito users, reset credentials, or broaden permissions.

## Apply

Run in **AWS CloudShell** (interactive TTY required):

```
CHECKSOPS_OPERATOR_GATE3D=I_UNDERSTAND_PRODUCTION
CHECKSOPS_OPERATOR_EXECUTE=1
node aws/origin-verify/operator-apply-gate3d.mjs
```

Uses Lambda `RevisionId`. **Before any AWS write**, the script starts the
existing T0 Tester passwordless flow through
`POST https://checksops.com/prep/auth/passwordless/start`, prompts on the
CloudShell TTY for the emailed EMAIL_OTP (input hidden, not echoed), and
completes `POST https://checksops.com/prep/auth/passwordless/verify`. The
Cognito ID token is held in process memory only. Then it sets
`ORIGIN_VERIFY_REQUIRE=true` and uses the token once for a read-only
`POST https://checksops.com/prep/data/query` (`user_roles.role`, limit 1),
then discards the token. Skipped login or skipped authenticated query is
**not** a pass.

Do **not** set `CHECKSOPS_GATE3D_ID_TOKEN`. Do not paste a browser token.
Do not use a Tester password env var or password file.

Non-TTY execute fails closed (`cloudshell_tty_required`) so CI cannot send
an OTP or hang on a prompt.

Automatic privileged rollback (`ORIGIN_VERIFY_REQUIRE=false`) runs if
authenticated query, health, or any Gate 3D validation fails after the
env write. A failed passwordless login aborts **before** the write.

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
