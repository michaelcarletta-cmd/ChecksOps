# Production read-only inspect role: no production database password (finding 12)

Security audit 2026-10-29, finding 12: `ChecksOpsGitHubProductionReadOnlyInspect` can read the
production application database password. Owner decision of 2026-10-29: "Start with finding 12".

| File | What it is |
|---|---|
| `ChecksOpsProductionReadOnlyInspect.live-2026-10-29.json` | the live inline policy, read 2026-10-29 (evidence and rollback) |
| `ChecksOpsProductionReadOnlyInspect.json` | the target: the live document with `secretsmanager:GetSecretValue` removed |

Test: `aws/tests/production-readonly-inspect-role-db-secret.test.mjs`.

## Why

The role's inline policy `ChecksOpsProductionReadOnlyInspect` allows `secretsmanager:DescribeSecret`
and `secretsmanager:GetSecretValue` on the production app database secret
`rds-db-credentials/checksops-production/checksops/1790081257144-A2Z4bw` (username, password, host).
The role is assumed by GitHub Actions runs in the `production-readonly` environment
(trust: `repo:michaelcarletta-cmd/ChecksOps:environment:production-readonly`). The routine inspect
(`inspect-production-readonly.yml`) narrows its session so it cannot call `GetSecretValue`; the
permission exists only for the one-time secret host compare
(`inspect-production-secret-host-compare.yml`, `ops/production-secret-host-compare.md`), which ran
once (run 38067130648, 2026-10-10) and answered its question. Any other workflow that names the
`production-readonly` environment and assumes the role without that session policy could read the
production database password.

## Read-only inspect (2026-10-29, `user/claude-code`)

- `iam:GetRole` / `iam:GetRolePolicy`: one inline policy, seven statements, no attached policies,
  no boundary; the live document is the snapshot in this folder.
- Workflows assuming the role: `inspect-production-readonly.yml` (session policy without
  `GetSecretValue`; last run 39831133021, 2026-10-22) and `inspect-production-secret-host-compare.yml`
  (one run, 2026-10-10). No other workflow uses the `production-readonly` environment.
- `iam:SimulateCustomPolicy`: the live document allows `GetSecretValue` on the secret; the target
  gives `implicitDeny` for it and `allowed` for `DescribeSecret` on the secret,
  `lambda:GetFunction` / `GetFunctionConfiguration` on `checksops-production-prep-api`,
  `s3:GetObject` on the production SPA `index.html`, `apigateway:GET` on `kiqojucc02`,
  `cloudfront:GetDistribution` on `E1B0ZWWO5559U5`, `rds:DescribeDBInstances` and
  `ec2:DescribeSecurityGroups`.

## What changes

- The routine production read-only inspect: nothing (it never had `GetSecretValue` in its session).
- The secret host compare workflow: refused (AccessDenied) at `GetSecretValue`. Running it again
  needs the statement in `production-secret-host-compare-iam.json` re-granted on the owner's approval
  of that run, and withdrawn afterwards.
- The application: nothing (the production Lambda reads the secret with its own role).

## Apply (only on the owner's approval of this run)

1. Re-read the policy with `iam:GetRolePolicy`; stop if it differs from
   `ChecksOpsProductionReadOnlyInspect.live-2026-10-29.json`.
2. Put the target:

   ```bash
   aws iam put-role-policy --role-name ChecksOpsGitHubProductionReadOnlyInspect \
     --policy-name ChecksOpsProductionReadOnlyInspect \
     --policy-document file://ops/deployment-guard/production-readonly-inspect-role/ChecksOpsProductionReadOnlyInspect.json
   ```

## Verify after apply

1. `iam:GetRolePolicy` equals `ChecksOpsProductionReadOnlyInspect.json`.
2. `iam:SimulatePrincipalPolicy` as the role: `GetSecretValue` on the secret `implicitDeny`; the
   other actions above `allowed`.

## Rollback

```bash
aws iam put-role-policy --role-name ChecksOpsGitHubProductionReadOnlyInspect \
  --policy-name ChecksOpsProductionReadOnlyInspect \
  --policy-document file://ops/deployment-guard/production-readonly-inspect-role/ChecksOpsProductionReadOnlyInspect.live-2026-10-29.json
```

## Applied (2026-10-30)

Owner approval, verbatim: "Merge 1414 and apply finding 12".
Source: `origin/main` `864d9f6` (PR #1414); `ChecksOpsProductionReadOnlyInspect.json` sha256
`3e78d60720b2e66883805c7f8a898c3c7efb9c841e35a09d8dc0d7c2b9792238`. Identity:
`arn:aws:iam::806168576068:user/claude-code`.

1. Precondition: `iam:GetRolePolicy` before the apply equalled
   `ChecksOpsProductionReadOnlyInspect.live-2026-10-29.json`; the role had that one inline policy.
2. `iam:PutRolePolicy` `ChecksOpsProductionReadOnlyInspect` on
   `ChecksOpsGitHubProductionReadOnlyInspect` with `ChecksOpsProductionReadOnlyInspect.json`
   (HTTP 200, request `7164bfda-9bfa-41a5-9ead-d9612ab5593b`, about 2026-10-30T00:20Z).
3. Read-back: `iam:GetRolePolicy` equals `ChecksOpsProductionReadOnlyInspect.json`.
4. `iam:SimulatePrincipalPolicy` as the role after the apply (9 checks): `GetSecretValue` on the
   production app database secret `implicitDeny`; `DescribeSecret` on it, `lambda:GetFunction` and
   `GetFunctionConfiguration` on `checksops-production-prep-api`, `s3:GetObject` on the production SPA
   `index.html`, `apigateway:GET` on `kiqojucc02`, `cloudfront:GetDistribution` on `E1B0ZWWO5559U5`,
   `rds:DescribeDBInstances` and `ec2:DescribeSecurityGroups` `allowed`.

Not verified: no routine inspect has run since the apply; its session never asked for
`GetSecretValue`, so none of its reads change.
