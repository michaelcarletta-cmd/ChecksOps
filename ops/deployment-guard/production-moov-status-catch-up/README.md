# Production Moov status catch-up role (owner creates it; not created by this PR)

`ChecksOpsGitHubProductionMoovStatusCatchUp` is the only identity
`.github/workflows/production-moov-status-catch-up.yml` uses (runbook `ops/moov-status-catch-up.md`,
owner request 2026-11-07: "Dedicated limited role for status catch up"). It can invoke the
production API Lambda `checksops-production-prep-api`. Nothing else.

| File | What it is |
|---|---|
| `trust-policy.json` | GitHub OIDC trust: this repository, the `production` environment, `refs/heads/main`, and only this workflow file |
| `permissions-policy.json` | inline permissions: one allow, two explicit denies |

## Trust

The same conditions as the production SPA fallback role
(`ops/deployment-guard/production-spa-fallback/README.md`), with the workflow file pinned to this
tool. STS accepted that shape in the SPA fallback inspect runs `42281266136` and `42281453509`
(2026-11-06, green):

- `aud` = `sts.amazonaws.com`, `sub` = `repo:michaelcarletta-cmd/ChecksOps:environment:production`;
- `repository_id` = `1231339992` and `repository_owner_id` = `248244651`;
- `environment` = `production`, `ref` = `refs/heads/main`;
- `job_workflow_ref` = `michaelcarletta-cmd/ChecksOps/.github/workflows/production-moov-status-catch-up.yml@refs/heads/main`.

A run of any other workflow, branch, fork or environment cannot assume it. On top of that the
`production` environment's own rules apply to every run, plan included: the owner is the only
required reviewer, `main` only, no administrator bypass
(`ops/deployment-guard/github-oidc-trust/README.md`).

It uses the existing `production` environment rather than a new one (for example
`production-moov-catch-up`), as every other dedicated production role does: the protection rules
above are already set and recorded there, while a new environment would start with none until the
owner configures them. The `job_workflow_ref` condition is what keeps every other workflow out.

## Permissions

- Allow `lambda:InvokeFunction` on
  `arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api` only (unqualified:
  no version or alias).
- Deny every other action (`NotAction: lambda:InvokeFunction`), and deny `lambda:InvokeFunction` on
  any other resource (`NotResource`), so a later broader policy on the role cannot widen it.
- No CloudWatch Logs: the catch-up answers in the invoke response, and the workflow prints that.
  No `lambda:Update*`, `lambda:Get*`, no IAM, KMS, S3, Secrets Manager, RDS or SSM.
  `sts:GetCallerIdentity` (the workflow's identity check) needs no allow and is not affected by a
  deny.

The workflow narrows the session again with an inline session policy that allows only the same
invoke.

What the invoke can do is decided by the Lambda code, not by IAM: `isMoovStatusCatchUpInvocation`
accepts only the catch-up event, the plan is read-only, and the apply needs the reviewed plan's
`manifest_sha256` and transfer ids plus the owner's phrase. Note that `lambda:InvokeFunction` on the
API function can also send it any other event its handler accepts (for example the other
`/scheduled/*` jobs, which check their own shared secret). That is why the trust is pinned to one
workflow on `main` behind the owner's per-run approval.

## Create it (owner, once)

In account `806168576068`, as an administrator, from a checkout of `main` that includes this
directory:

```bash
aws iam create-role --role-name ChecksOpsGitHubProductionMoovStatusCatchUp \
  --description "ChecksOps production-moov-status-catch-up.yml: invoke checksops-production-prep-api only" \
  --assume-role-policy-document file://ops/deployment-guard/production-moov-status-catch-up/trust-policy.json \
  --max-session-duration 3600
aws iam put-role-policy --role-name ChecksOpsGitHubProductionMoovStatusCatchUp \
  --policy-name ChecksOpsProductionMoovStatusCatchUp \
  --policy-document file://ops/deployment-guard/production-moov-status-catch-up/permissions-policy.json
```

Check what was created (read-only):

```bash
aws iam get-role --role-name ChecksOpsGitHubProductionMoovStatusCatchUp \
  --query 'Role.[Arn,AssumeRolePolicyDocument]'
aws iam list-attached-role-policies --role-name ChecksOpsGitHubProductionMoovStatusCatchUp   # expect none
aws iam list-role-policies --role-name ChecksOpsGitHubProductionMoovStatusCatchUp            # expect ChecksOpsProductionMoovStatusCatchUp only
aws iam get-role-policy --role-name ChecksOpsGitHubProductionMoovStatusCatchUp \
  --policy-name ChecksOpsProductionMoovStatusCatchUp
```

In the console instead: IAM, Roles, Create role, Custom trust policy (paste `trust-policy.json`),
no managed policy, name `ChecksOpsGitHubProductionMoovStatusCatchUp`, maximum session 1 hour; then
the role, Add permissions, Create inline policy, JSON (paste `permissions-policy.json`), name
`ChecksOpsProductionMoovStatusCatchUp`.

Then in GitHub, Settings, Environments, `production`, Environment variables, add the **variable**
(not a secret; the ARN is not sensitive and the other production roles use variables):

`CHECKSOPS_PRODUCTION_MOOV_STATUS_CATCH_UP_ROLE_ARN` =
`arn:aws:iam::806168576068:role/ChecksOpsGitHubProductionMoovStatusCatchUp`

No other secret or variable is needed: the workflow reads no secret.

The Lambda's resource policy does not need a change: an IAM principal of the same account is
authorized by its identity policy alone.

Check: a `phase: plan` run reaches "Verify AWS identity" with
`assumed-role/ChecksOpsGitHubProductionMoovStatusCatchUp/checksops-production-moov-status-catch-up-<run id>`.
If STS refuses the web identity, compare the trust conditions with the run's token claims; do not
widen them without a reviewed PR.

## Remove it (owner, when the catch-up is no longer needed)

```bash
aws iam delete-role-policy --role-name ChecksOpsGitHubProductionMoovStatusCatchUp \
  --policy-name ChecksOpsProductionMoovStatusCatchUp
aws iam delete-role --role-name ChecksOpsGitHubProductionMoovStatusCatchUp
```

and delete the GitHub variable.
