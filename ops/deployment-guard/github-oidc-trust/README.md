# GitHub OIDC deploy roles: who can assume them (finding 11, closed)

Security audit 2026-10-29, finding 11: the production deploy role trusts any GitHub Actions run in
the `production` environment. Closed 2026-10-30 by the GitHub environment settings below; no AWS
change.

| File | What it is |
|---|---|
| `github-oidc-roles.live-2026-10-30.json` | trust policy, inline actions, attached policies and boundary of the three GitHub OIDC roles, read 2026-10-30 |

Test: `aws/tests/github-oidc-trust-finding11.test.mjs`.

## Read-only inspect (2026-10-30, `user/claude-code`)

- Each role trusts `token.actions.githubusercontent.com` with `aud` `sts.amazonaws.com` and `sub`
  `repo:michaelcarletta-cmd/ChecksOps:environment:<env>` only (production, production-readonly,
  staging): no branch or workflow condition.
- None can change IAM or schedules: no `iam:*`, `scheduler:*` or `*` action, no attached policy, no
  boundary. The audit's "CreateRole / PutRolePolicy" route does not exist. The production overlay
  role can update `checksops-production-prep-api` code and configuration and PATCH API Gateway; the
  read-only inspect role has no `secretsmanager:GetSecretValue` (finding 12).
- The guarded workflows refuse any ref other than `refs/heads/main`
  (`guarded-production-lambda-overlay.yml`, `guarded-staging-lambda-overlay.yml`,
  `inspect-production-readonly.yml`).

## GitHub `production` environment (owner, 2026-10-30)

This session cannot read environment settings (the GitHub API path is refused by the proxy); the
owner read them in Settings → Environments → production:

- Required reviewers: only the owner ("Required reviewers is only me").
- Deployment branches: selected branches, `main` only ("It's set to selected only main").
- "Allow administrators to bypass configured protection rules": was checked; the owner unchecked
  it ("It's unchecked now").

## Why this closes it

A run can assume the production deploy role only from `main` and only after the owner approves
that run, and no administrator can skip either rule. The role cannot escalate (no IAM). Pinning
the AWS trust to `main` and the workflow file as well would need a customized OIDC subject claim
and adds little on top of the per-run approval; not done.

## Keep it closed

- Keep the owner as the only required reviewer, branches at `main`, and the bypass unchecked.
- Any new workflow that names `environment: production` gets the same approval; review such a PR
  as a deploy-permission change.
