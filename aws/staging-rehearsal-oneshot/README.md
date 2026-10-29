# Staging rehearsal one-shot role: remove the production admin grant

Role: `checksops-staging-rehearsal-oneshot` (Lambda `checksops-staging-rehearsal-oneshot`,
updated by `aws/db-copy/rehearsal/scripts/bridge-db-rehearsal.mjs` and
`aws/write-path/scripts/run-parity-schema-rehearsal.mjs`). Inline policy to remove:
`ChecksOpsP6PromoteTemp`. It was added by hand for the 2026-09 production promotion and is not
written by either script (they write only `oneshot-rehearsal-least-privilege`).

| File | What it is |
|---|---|
| `policies/inline-policies.live-2026-10-29.json` | every inline policy of the role, read 2026-10-29 with `iam:GetRolePolicy` (evidence and rollback) |
| `policies/inline-policies.json` | the target: the same without `ChecksOpsP6PromoteTemp` |

Test: `aws/tests/staging-rehearsal-oneshot-no-production-grant.test.mjs`.

## Why

`ChecksOpsP6PromoteTemp` grants `secretsmanager:GetSecretValue` on
`rds-db-credentials/checksops-production/checksops_admin/*` and `s3:GetObject` / `s3:ListBucket`
on the production files bucket's `Migration/` prefix. Code that runs as this staging Lambda can
therefore read the production database admin credentials. Its code is changed by the two
rehearsal scripts above, which `ops/deployment-guard/bypass-inventory.json` classifies as
`NON_SHARED/SAFE` with `lambda-update-function-code`, outside the deployment guard.

## Read-only inspect (2026-10-29, `user/claude-code`)

- `iam:SimulatePrincipalPolicy` as the role, before: `GetSecretValue` on the production
  `checksops_admin` secret `allowed`; `s3:GetObject` on production `Migration/*` `allowed`.
- CloudTrail `LookupEvents` (user name `checksops-staging-rehearsal-oneshot`, last 90 days): 24
  `GetSecretValue` on production secrets, the latest 2026-09-22 16:23 UTC, the day of the
  function's last code change (`LastModified` 2026-09-22T16:24:03Z); none since. 140 on staging
  secrets, the latest the same day.
- The staging access the rehearsals use stays granted by the remaining policies: the staging
  `checksops_admin` secret (`1788286368527-Kv5tBt`) and `GetObject` / `PutObject` / `ListBucket`
  on the staging bucket's `Migration/*`.

## Apply (only on the owner's approval of this run)

```bash
aws iam delete-role-policy \
  --role-name checksops-staging-rehearsal-oneshot \
  --policy-name ChecksOpsP6PromoteTemp
```

Before the apply, re-read the role's inline policies and stop if any differs from
`inline-policies.live-2026-10-29.json`.

## Verify after apply

1. `iam:ListRolePolicies` lists exactly the four policies in `inline-policies.json`, each equal to it.
2. `iam:SimulatePrincipalPolicy`: `GetSecretValue` on the production `checksops_admin` secret and
   `s3:GetObject` on production `Migration/*` are `implicitDeny`; the staging `checksops_admin`
   secret and staging `Migration/*` stay `allowed`.

## Rollback

```bash
aws iam put-role-policy \
  --role-name checksops-staging-rehearsal-oneshot \
  --policy-name ChecksOpsP6PromoteTemp \
  --policy-document "$(node -e "console.log(JSON.stringify(require('./aws/staging-rehearsal-oneshot/policies/inline-policies.live-2026-10-29.json').ChecksOpsP6PromoteTemp))")"
```
