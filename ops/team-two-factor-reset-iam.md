# Team two-factor reset: let the API roles turn off a teammate's login two-factor

**What breaks today.** Settings → Users → ↺ (Reset two-factor authentication) passes the caller's own
code step and then fails. Staging, 2026-11-04, with a second user's code accepted:

> Could not reset two-factor. User: arn:aws:sts::806168576068:assumed-role/checksops-staging-ApiFunctionRole-7E7XRyLe3nyi/checksops-staging-api
> is not authorized to perform: cognito-idp:AdminSetUserMFAPreference on resource: arn:a…

`aws/functions/api/admin-reset-totp.mjs` calls three Cognito actions on the environment's user pool:
`AdminGetUser`, then `AdminSetUserMFAPreference` (turn the login two-factor off), then
`AdminUserGlobalSignOut` (sign the teammate out everywhere). Both API roles allow only `AdminGetUser`.

**Evidence (read-only, 2026-11-04, `user/claude-code`).** `iam:SimulatePrincipalPolicy` on each role and
its own pool: `AdminSetUserMFAPreference` and `AdminUserGlobalSignOut` are `implicitDeny` on both;
`AdminGetUser` is allowed (staging through `ApiFunctionRolePolicyClassA`, production through
`TenantInviteUserProductionCognito`). Recorded in `ops/team-two-factor-reset-iam/staging-before-2026-11-04.json`
and `ops/team-two-factor-reset-iam/production-before-2026-11-04.json` with each role's inline policy names; neither
role has a policy named `TeamTwoFactorResetCognito`. So the reset has never completed on AWS, in either
environment; it stops before it changes anything.

**The change.** A new inline policy `TeamTwoFactorResetCognito` on each role, granting exactly
`cognito-idp:AdminSetUserMFAPreference` and `cognito-idp:AdminUserGlobalSignOut`, on exactly that
environment's user pool. No existing policy is edited, and nothing else changes (no Lambda, SQL, bucket,
key or Cognito pool setting).

| environment | role | user pool | policy document |
|---|---|---|---|
| staging | `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` | `us-east-1_vPmQ7cL1F` | `ops/team-two-factor-reset-iam/staging-after.json` |
| production | `checksops-production-api-execution` | `us-east-1_h00WorYMT` | `ops/team-two-factor-reset-iam/production-after.json` |

Like `ApiFunctionRolePolicyClassA` (`aws/staging-api/README.md`) and `TenantInviteUserProductionCognito`
(`aws/production/api-execution-cognito-admin-policy.json`), these are hand-made inline policies: the staging
SAM stack manages only its own `ApiFunctionRolePolicy0`–`5` and leaves other inline policies alone, and the
production role is not in a template. The deploy role cannot change IAM, so the owner applies them.

## Staging (first)

The owner, as `michael-admin`, from an LF checkout of main after this PR merges. Sign in first if needed
(`aws sso login`, then `aws sts get-caller-identity`). Paste as one block; it stops at the first problem.

```bash
cd /home/carle/ChecksOps && git checkout main && git pull --ff-only && bash -euo pipefail -c '
ROLE=checksops-staging-ApiFunctionRole-7E7XRyLe3nyi
POOL=arn:aws:cognito-idp:us-east-1:806168576068:userpool/us-east-1_vPmQ7cL1F
if aws iam get-role-policy --role-name "$ROLE" --policy-name TeamTwoFactorResetCognito >/dev/null 2>&1; then echo "STOP: TeamTwoFactorResetCognito already exists"; exit 1; fi
echo "BEFORE: policy absent"
aws iam put-role-policy --role-name "$ROLE" --policy-name TeamTwoFactorResetCognito --policy-document file://ops/team-two-factor-reset-iam/staging-after.json
aws iam get-role-policy --role-name "$ROLE" --policy-name TeamTwoFactorResetCognito --query PolicyDocument --output json > /tmp/tfr-live.json
diff <(python3 -m json.tool --sort-keys /tmp/tfr-live.json) <(python3 -m json.tool --sort-keys ops/team-two-factor-reset-iam/staging-after.json)
echo "LIVE MATCHES AFTER"
aws iam simulate-principal-policy --policy-source-arn "$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)" --action-names cognito-idp:AdminSetUserMFAPreference cognito-idp:AdminUserGlobalSignOut --resource-arns "$POOL" --query "EvaluationResults[].[EvalActionName,EvalDecision]" --output text'
```

Expect `BEFORE: policy absent`, `LIVE MATCHES AFTER`, and both actions `allowed`. Then a Freedom user with a
working staging authenticator resets `mcarletta@freedomadj.com` from Settings → Users → ↺; that login signs in
by magic link and sets up a new authenticator.

**Rollback (staging).**
`aws iam delete-role-policy --role-name checksops-staging-ApiFunctionRole-7E7XRyLe3nyi --policy-name TeamTwoFactorResetCognito`

## Production (a separate owner step, after staging works)

```bash
cd /home/carle/ChecksOps && git checkout main && git pull --ff-only && bash -euo pipefail -c '
ROLE=checksops-production-api-execution
POOL=arn:aws:cognito-idp:us-east-1:806168576068:userpool/us-east-1_h00WorYMT
if aws iam get-role-policy --role-name "$ROLE" --policy-name TeamTwoFactorResetCognito >/dev/null 2>&1; then echo "STOP: TeamTwoFactorResetCognito already exists"; exit 1; fi
echo "BEFORE: policy absent"
aws iam put-role-policy --role-name "$ROLE" --policy-name TeamTwoFactorResetCognito --policy-document file://ops/team-two-factor-reset-iam/production-after.json
aws iam get-role-policy --role-name "$ROLE" --policy-name TeamTwoFactorResetCognito --query PolicyDocument --output json > /tmp/tfr-live.json
diff <(python3 -m json.tool --sort-keys /tmp/tfr-live.json) <(python3 -m json.tool --sort-keys ops/team-two-factor-reset-iam/production-after.json)
echo "LIVE MATCHES AFTER"
aws iam simulate-principal-policy --policy-source-arn "$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)" --action-names cognito-idp:AdminSetUserMFAPreference cognito-idp:AdminUserGlobalSignOut --resource-arns "$POOL" --query "EvaluationResults[].[EvalActionName,EvalDecision]" --output text'
```

**Rollback (production).**
`aws iam delete-role-policy --role-name checksops-production-api-execution --policy-name TeamTwoFactorResetCognito`

After each environment, tell Claude: a read-only check re-reads the policy and CloudTrail `PutRolePolicy`, and a
record PR adds the result here.

**Status:** not applied anywhere.
