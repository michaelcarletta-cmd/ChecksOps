# API Perimeter Step 3 — Gate 3D ENFORCEMENT BLOCKED (KMS)

**2026-09-09.** STOP FOR REVIEW. Gate 3D is **FAIL / BLOCKED**.

Caller
`arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorApiPerimeterStep3Temp/[session]`.

Secret value, hash, prefix, CloudFront header value, session, and JWT are **not** recorded here.

## Confirm-first (before any write)

| Check | Result |
|---|---|
| GetCallerIdentity Step3Temp | **true** |
| CloudFront `E1B0ZWWO5559U5` | **Deployed** |
| Production WAF | Unchanged |
| Origin custom header | Exactly one name `x-checksops-origin-verify` |
| `$default` | `CUSTOM` / authorizer `0dwrwx` |
| OPTIONS `/{proxy+}` | `AuthorizationType=NONE` |
| Integration `jci10de` | Still prep; strip configured |
| `ORIGIN_VERIFY_REQUIRE` | `<unset>` / false |
| Authorizer env keys | none |
| Lambda CMK | `kmsKeyPresent=false` |
| `holds.ok` | **true** |
| `productionExecution` | **false** |
| Moov / CheckAlt / provider / financial flags | **false** |
| `64_financial_activation_grants.sql` | `financialActivationSqlApplied=false` |
| Execute-api | `DisableExecuteApiEndpoint=false` |
| CloudFront `/prep/health` | 200 |
| Raw execute-api `/prep/health` | 200 (observe) |
| CloudFront observe | `originHeaderPresent=true`, `originHeaderValid=true` |
| Raw observe | `originHeaderPresent=false`, `originHeaderValid=false` |

Confirm-first `ok=true`. No AWS write had been made.

## Enforcement attempt

Step3Temp called `UpdateFunctionConfiguration` on `checksops-production-origin-verify` only, preserving the empty existing environment and attempting to set the require flag.

Result: **`update_env_kms_denied`**. Explicit deny `DenyKmsAndRoleChaining` (`kms:*`) blocked Lambda environment encryption. `applied=false`.

Step3Temp was **not** broadened. The privileged-operator CloudShell path in `API_PERIMETER_STEP3_OPERATOR_GATE3D.md` remains the reviewed next step. That path was **not** executed here (it refuses Step3Temp and requires an interactive TTY).

## After the failed write

| Surface | Result |
|---|---|
| `ORIGIN_VERIFY_REQUIRE` | still `<unset>` / false |
| Authorizer env keys | still none |
| CloudFront apex `/prep/health` | 200 |
| CloudFront www `/prep/health` | 200 |
| Raw execute-api `/prep/health` | 200 (observe; not yet denied) |
| Rollback | **not needed** (no env write landed) |
| WAF | Unchanged |
| SPA / DNS / Cognito / RDS / prep Lambda | Not modified |
| `holds.ok` | **true** |
| `productionExecution` | **false** |
| Provider / financial flags | **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** |

Authenticated Tester login / tenant isolation in require-mode was **not** run because require-mode never turned on.

## Return

| Item | Result |
|---|---|
| Gate 3D | **FAIL / BLOCKED** |
| Raw execute-api | still 200 (observe) |
| CloudFront | still 200 |
| Authenticated app regression | **not run** (require-mode not applied) |
| Rollback status | **not needed** |
| Financial / provider holds | **intact** |

## STOP

Do **not** broaden `ChecksOpsCursorApiPerimeterStep3Temp`. Keep the `kms:*` deny. Do **not** set the require flag from this role. Do **not** disable execute-api. Do **not** modify SPA, prep Lambda, RDS, Cognito, WAF, or DNS. Do **not** rotate RDS secrets. Do **not** activate Moov or CheckAlt. Do **not** apply `64_financial_activation_grants.sql`. Do **not** delete temporary roles.
