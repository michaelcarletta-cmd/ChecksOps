# Security Hardening #2–#6 handoff — STOP after #3 FAIL

**Date:** 2026-09-07 (reopened after
`checksops-cursor-security-hardening-role` **CREATE_COMPLETE**)  
**STOP FOR REVIEW.** Temporary role **not** deleted. Trail stack left
`CREATE_FAILED`. Money flags remain **false**. `64_` remains
**NOT_APPLIED**. **#4–#6 not started.**

Caller: `arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorSecurityHardeningTemp/checksops-sec-hard`

## Handoff gates (re-verified this run)

| Check | Result |
|---|---|
| Role `ChecksOpsCursorSecurityHardeningTemp` exists | **PASS** — created `2026-09-07T17:45:35Z` |
| Inline policies | **0** (`PolicyNames: []`) |
| Attached managed policies | **6/6** — AllowCfnSns, AllowConfigPosture, AllowFlowAlarms, AllowReadonly, DenyFinancialApp, DenyIamInfra |
| Cursor OIDC assume | **PASS** (`assume-role-with-web-identity`, session `checksops-sec-hard`) |
| `GetCallerIdentity` is the temp role (not staging/root) | **PASS** — `arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorSecurityHardeningTemp/checksops-sec-hard` |
| Moov / CheckAlt / Provider / Financial | All **false** (Lambda env + `/financial/status` + `/ops/readiness`) |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** (repo stub `SELECT 'NOT_APPLIED'`; role cannot apply it) |
| Trail stack `checksops-production-security-trail` | Still **CREATE_FAILED** (untouched) |
| Live trail `checksops-production-mgmt-events` | Still present, `IsLogging=true`, one trail, `DataResources=[]` |

`DescribeStacks` on `checksops-cursor-security-hardening-role` still
returns “does not exist” to this role (intentional CFN Deny on its own
stack). The role and six managed policies exist; do not treat that
Describe as “role missing.”

## Deployments

| # | Service | Result | Evidence |
|---|---|---|---|
| 1 | CloudTrail | **PASS** (prior) | Not modified. `checksops-production-mgmt-events`, logging, multi-region, validation, management All, no data events. |
| 2 | SNS | **PASS** | Stack `checksops-production-security-sns` `CREATE_COMPLETE`. Topic `arn:aws:sns:us-east-1:806168576068:checksops-production-security-alerts` live. Email subscription **PendingConfirmation** (`security@checksops.com`). `SubscriptionsConfirmed=0`, `SubscriptionsPending=1`. Operator must confirm mail before #6 paging. |
| 3 | AWS Config | **FAIL** | Stack `checksops-production-security-config` **ROLLBACK_COMPLETE**. `ConfigDeliveryChannel` CREATE_FAILED: name `checksops-production` **already exists in** `checksops-production-security-trail`. Config API lists **0** recorders and **0** channels. Role `checksops-production-config-recorder` is **NoSuchEntity**. This reopen did **not** retry `create-stack` (same two blockers; another rollback would not change them). |
| 4 | GuardDuty + Security Hub | **NOT STARTED** | Stopped after #3. `list-detectors` empty. Hub not subscribed. |
| 5 | VPC Flow Logs | **NOT STARTED** | `checksops-production-vpc-flow-logs` does not exist. No flow logs on `vpc-09f2268778966ce97`. |
| 6 | CloudWatch alarms | **NOT STARTED** | Needs Confirmed SNS + reviewed #3 path. Existing `checksops-production-prep-api-*` alarms are a different name set and were not modified. |

## Why #3 stopped

Reviewed `security-config.yaml` uses delivery-channel / recorder name
`checksops-production`. The CREATE_FAILED trail stack still owns logical
`ConfigDeliveryChannel` with that name (physical id `None`, status
`CREATE_FAILED`). A second CFN stack cannot create the same name.

Do **not** delete `checksops-production-security-trail` (it owns the live
logs bucket). Do **not** invent a new channel name without review.

Secondary: the retained Config recorder role is gone. Even a name fix
needs a reviewed role (or import) before `iam:PassRole`. The temp role
can PassRole `checksops-production-config-recorder` only; it **cannot**
`CreateRole` for Config.

The empty `ROLLBACK_COMPLETE` stack
`checksops-production-security-config` was left in place; it owns
nothing live. Delete it only as the first step of a **reviewed** #3
retry.

Reviewed path still required before any #3 retry:

1. Privileged-ops creates (or imports) `checksops-production-config-recorder`, **or** a reviewed new role name plus matching PassRole.
2. Either a reviewed new recorder/channel name (same class of fix as CloudTrail `#1` / `checksops-production-mgmt-events`), **or** a reviewed trail-stack cleanup that frees `checksops-production` **without** deleting the logs bucket.
3. Then delete the empty `ROLLBACK_COMPLETE` config stack and retry the reviewed template/CLI.

## Holds after this run

- #2 SNS left in place
- Flags still false (`GetFunctionConfiguration`, `/ops/readiness`, `/financial/status`)
- `64_` not applied
- No Cognito / CloudFront / WAF / DNS / RDS data / app / staging change
- Trail stack and live trail untouched
- Temp role kept

## Final security + production regression (after stop)

| Surface | Result |
|---|---|
| `https://checksops.com/` `/login` `/endorse` `/sign` | 200 |
| `GET /health` `/db-health` `/ops/readiness` `/financial/status` | 200 |
| Money flags in Lambda env | all **false** (Plaid also **false**) |
| Money flags in `/financial/status` | all **false**; `productionExecution` **false**; `ok` **true** |
| `/ops/readiness` | `financialActivationSqlApplied` **false**; holds `ok` |
| RDS `checksops-staging` | available; backup **35**; deletion protection **true** |
| CloudTrail | one trail, logging, no data events |

Authenticated isolation was **not** re-run (would require Cognito
password reset; Cognito is out of scope).

## Remaining blockers

1. **#3 Config:** reserved channel name on the failed trail stack + missing
   `checksops-production-config-recorder` role. Needs a reviewed path that
   does not delete the logs bucket.
2. **SNS email** still `PendingConfirmation`.
3. **MUST FIX before financial activation:** API-behind-CloudFront
   (unchanged).
4. Detection #4–#6 not live.
