# Node.js runtimes: plan (Lambda and the SQL runner), November 2026

Owner, 2026-11-03: "3 and 4" (item 3: the SQL runner's Node 18, and the Lambdas' runtimes).

This plan changes nothing. Each change below needs its own reviewed PR and run, on the owner's
words.

## Why

- **Lambda `nodejs20.x`:** deprecated on 2026-04-30, so it gets no more security patches. Lambda
  blocks creating functions on it from 2027-07-29 and updating them from 2027-08-31 (AWS Lambda
  runtimes page, read 2026-11-03).
- **The SQL runner `i-0c35557c4e5385406`:** runs Node `v18.20.8` (`nodejs-18.20.8-1.amzn2023.0.2`).
  Node 18 reached end of life on 2025-04-30. The 2026-11-02 OS patch did not change it.

## What is live (read-only, 2026-11-03)

There are 86 functions: 77 on `nodejs20.x`, 8 on `nodejs22.x` and 1 on `nodejs24.x`.

| Group | Functions | What to do |
|---|---|---|
| A. Live, on Node 20 | `checksops-production-origin-verify` (the production API Gateway authorizer, about 936k invocations in 30 days, one per production API request); `checksops-staging-guarded-sql-executor` (the guarded staging SQL path, 222) | Upgrade to `nodejs22.x` |
| B. Main app, already on Node 22 | `checksops-production-prep-api`, `checksops-staging-api` | Nothing now |
| C. Old one-shots and inspectors | 5 on Node 20 invoked 1–7 times, all on or before 2026-10-04; 70 on Node 20 with 0 invocations in 30 days, all in the VPC; 6 on Node 22 and `Checksops` (Node 24, created 2026-09-01) with 0 invocations | Retire after the owner's review, not upgrade |

Group C are leftovers from finished workstreams (suffixes `2d41`, `ad99`, `a2a4`, `6136`, `83c9`,
`b5e0` and others): SQL applies, inspectors, fixtures and rehearsals. Each keeps a code package, an
execution role and, for those in the VPC, a network path to a database. Retiring them removes that
standing access. Upgrading them would only keep it alive.

## Steps

Each step is a separate PR, and runs only on the owner's words for that step.

### 1. Staging guarded SQL executor → `nodejs22.x` (code PR, then the guarded deploy)

`scripts/deployment-guard/sql-executor-ensure.mjs` creates the executor with `--runtime nodejs20.x`,
and its `update-function-configuration` call does not set the runtime.
1. **Code PR:** set `nodejs22.x` on create, and on update through the existing RevisionId-checked
   configuration call. Update `ops/deployment-guard/sql53-live-executor-inventory.json` and the
   tests.
2. **Deploy:** `guarded-staging-sql-executor.yml`, mode `inspect`, then `deploy`.
3. **Verify:** a `read-live` run returns the same report as before.
4. **Rollback:** the same deploy with `nodejs20.x`.

### 2. Production origin-verify authorizer → `nodejs22.x` (plan PR first)

This function authorizes every production API request, so a failure is a full API outage. No
guarded workflow changes its runtime today; `aws/origin-verify/apply-gate3a.mjs` covers only its
code. The plan PR:
1. runs its handler and tests under Node 22 locally;
2. adds a staging copy or a canary alias, if the gate scripts support one;
3. defines the production change as one `update-function-configuration --runtime nodejs22.x` with
   `--revision-id`, plus an immediate rollback to `nodejs20.x`;
4. defines the check: production API smoke checks and the authorizer's CloudWatch errors over the
   following minutes.

It runs in an announced window, on its own phrase.

### 3. Retire group C (owner review, then deletion by the owner)

1. A docs PR lists each function with its last invocation, role, VPC access and originating PR or
   workstream. For rollback, it records each one's code SHA-256 and configuration.
2. The owner marks each one: retire or keep.
3. The owner deletes the ones marked retire in CloudShell, or Claude does it under a temporary
   scoped grant the owner adds and removes. Their now-unused execution roles are listed for a
   follow-up.
4. Nothing in groups A or B is touched.

### 4. SQL runner → Node 22

Phrase: "start the production SQL runner for the Node upgrade". It covers one run and no SQL.
1. Start the runner and record `node --version` and `rpm -qa 'nodejs*'`.
2. Install Amazon Linux 2023's `nodejs22` packages and make Node 22 the default `node`. Check the
   package names and the switch on the runner before running them.
3. Run the one-shot tool's self-test and a read-only `--phase inspect` against production. That
   proves the tool still works and still reaches the database.
4. Record the result and stop the runner.
5. **Rollback:** switch the default back to Node 18, which stays installed.

## Step 2 in detail: production origin-verify authorizer (evidence 2026-11-03)

### What is live (read-only)

- **`checksops-production-origin-verify`:** `nodejs20.x`, handler `authorizer.handler`, x86_64, 256 MB,
  10 s timeout, not in the VPC.
- **Live code:** CodeSha256 `4ppMwMgI8pN/wCp10aTNEpw7EVLbcSxRks8nVgHrniQ=`, RevisionId
  `fdbc8b41-0466-44dd-a9e2-68b3efa9c9a3`, last modified 2026-09-09 02:07:14 UTC.
- **No canary is possible:** the function has no published versions or aliases. API Gateway
  authorizer `0dwrwx` on API `kiqojucc02` invokes `$LATEST`, so a runtime change applies to the next
  invocation. The repo's `aws/origin-verify/authorizer-config.json` sets a 0-second result cache, so
  every production API request runs it. The live API Gateway setting could not be read, because
  `claude-code` has no `apigateway:GET`.
- **`ORIGIN_VERIFY_REQUIRE=true`:** a wrong or missing header is denied. If the secret cannot be
  loaded, the handler fails closed, which would deny every request.

### The live package was tested on Node 22

- **Download:** with a temporary `lambda:GetFunction` grant on this one function, which the owner
  added and removed in CloudShell on 2026-11-03, the owner copied the live package to
  `s3://checksops-sql53-transfer-806168576068/review/origin-verify-live.zip` (2,504,685 bytes). Its
  SHA-256 equals the live CodeSha256.
- **Contents:** the package holds `authorizer.mjs`, `package.json` and `node_modules`, including
  `@aws-sdk/client-secrets-manager` 3.1127.0. `authorizer.mjs` is byte-identical to
  `aws/functions/origin-verify/authorizer.mjs` on main.
- **The harness:** `origin-verify-node22-harness.mjs` (next to this file) imports the live
  `authorizer.mjs` from the unpacked package. It points the bundled SDK at a local fake Secrets
  Manager through `AWS_ENDPOINT_URL_SECRETS_MANAGER`. The fake accepts only a SigV4-signed
  `GetSecretValue` for `checksops/production/cloudfront-origin-verify`.
- **What it runs:** five requests with `require` true and five with `require` false (current header,
  next header, mixed-case header name, wrong header, missing header), the 30-second secret cache, and
  the fail-closed path when the secrets endpoint returns 500.
- **Result:** on Node `v20.20.2` and Node `v22.23.4`, all 13 results are identical, and no log line
  contains a header value. The SDK prints its own warning on Node 20: SDK releases after the first
  week of January 2027 require Node 22 or later.

### Procedure

Go phrase: **"production authorizer: Node 22"**. The owner runs the change in CloudShell, because no
guarded workflow covers this function's configuration and Claude cannot change Lambda. Pick a
low-traffic window. The whole procedure takes about 5 minutes.

1. **P0 (Claude, read-only).** Confirm the function is still `nodejs20.x` with CodeSha256
   `4ppMwMgI…`, and record the current RevisionId. Read the authorizer's CloudWatch `Errors` and
   `Throttles` and the production API Lambda's invocations for the previous 30 minutes, as the
   baseline.
2. **P1 (owner).** Run the change, then wait for it to finish:
   ```bash
   aws lambda update-function-configuration --function-name checksops-production-origin-verify --runtime nodejs22.x --revision-id <RevisionId from P0>
   ```
   ```bash
   aws lambda wait function-updated --function-name checksops-production-origin-verify
   ```
3. **P2 (owner).** Check the site.
   `curl -sS -o /dev/null -w '%{http_code}\n' https://checksops.com/prep/health` must print `200`.
   Then sign in to checksops.com and open a check.
4. **P3 (Claude, read-only, for 15 minutes).** The function must show `nodejs22.x`,
   `LastUpdateStatus: Successful` and an unchanged CodeSha256. The authorizer's `Errors` must stay at
   0. Its log lines must keep showing `originHeaderValid: true`, which proves the secret still loads.
   Production API invocations must continue at the baseline rate.
5. **Rollback (owner).** Run the same command with `--runtime nodejs20.x` and the new RevisionId.
   Roll back on any `/prep/health` result other than `200`, on authorizer errors, or on a drop in
   API invocations. It takes effect within seconds.

**Cleanup (owner):** `aws s3 rm s3://checksops-sql53-transfer-806168576068/review/origin-verify-live.zip`.

## Inventory

Read 2026-11-03 12:17 UTC: `lambda:ListFunctions` and CloudWatch `AWS/Lambda Invocations`, summed over 30 days.

| Function | Runtime | Invocations, 30 days | Last modified | In VPC |
|---|---|---|---|---|
| `checksops-production-origin-verify` | nodejs20.x | 936,344 | 2026-09-09 | no |
| `checksops-production-prep-api` | nodejs22.x | 933,990 | 2026-11-02 | yes |
| `checksops-staging-api` | nodejs22.x | 289,596 | 2026-11-02 | yes |
| `checksops-staging-guarded-sql-executor` | nodejs20.x | 222 | 2026-11-02 | yes |
| `checksops-staging-macomp50-oneshot` | nodejs20.x | 7 | 2026-10-04 | yes |
| `checksops-staging-macomp48-oneshot` | nodejs20.x | 2 | 2026-10-03 | yes |
| `checksops-prod-macomp49-oneshot-ad99` | nodejs20.x | 1 | 2026-10-03 | yes |
| `checksops-staging-cbe-index-inspect` | nodejs20.x | 1 | 2026-10-03 | yes |
| `checksops-staging-v2-provider-inspect-2d41` | nodejs20.x | 1 | 2026-09-29 | yes |
| `Checksops` | nodejs24.x | 0 | 2026-09-01 | no |
| `checksops-cursor-moov-monitor-temp` | nodejs20.x | 0 | 2026-09-15 | yes |
| `checksops-endorsement-transition-inspect-e3dd` | nodejs20.x | 0 | 2026-09-23 | yes |
| `checksops-m79-sql77-b844` | nodejs20.x | 0 | 2026-09-22 | yes |
| `checksops-ocr-azure-validation-504e` | nodejs22.x | 0 | 2026-09-18 | no |
| `checksops-prod-claim-ledger-sql-apply-a2a4` | nodejs20.x | 0 | 2026-10-02 | yes |
| `checksops-prod-claim-ledger-sql-inspect-a2a4` | nodejs20.x | 0 | 2026-10-02 | yes |
| `checksops-prod-macomp47-oneshot-ad99` | nodejs20.x | 0 | 2026-10-03 | yes |
| `checksops-prod-macomp48-oneshot-ad99` | nodejs20.x | 0 | 2026-10-03 | yes |
| `checksops-prod-moov-billing-inspect-ro-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-prod-moov-billing-sql-43-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-prod-mops-accept-inspect-ad99` | nodejs20.x | 0 | 2026-10-03 | yes |
| `checksops-prod-mops-accept-seed-ad99` | nodejs20.x | 0 | 2026-10-03 | yes |
| `checksops-prod-mops-sql-transition-ad99` | nodejs20.x | 0 | 2026-10-03 | yes |
| `checksops-prod-mops-sql39-inspect-ad99` | nodejs20.x | 0 | 2026-10-03 | yes |
| `checksops-prod-mortgage-ops-audit-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-prod-mortgage-ops-preview-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-prod-mortgage-ops-sql-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-prod-pr601-sql-inspect-a2a4` | nodejs20.x | 0 | 2026-10-02 | yes |
| `checksops-prod-sig-check-file-probe-ad99` | nodejs20.x | 0 | 2026-09-28 | yes |
| `checksops-prod-signature-inspect-ad99` | nodejs20.x | 0 | 2026-09-27 | yes |
| `checksops-prod-signature-sql-apply-ad99` | nodejs20.x | 0 | 2026-09-27 | yes |
| `checksops-prod-signature-verify-ad99` | nodejs20.x | 0 | 2026-09-27 | yes |
| `checksops-prod-sql44-apply-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-prod-sql44-inspect-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-prod-sql47-apply-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-prod-sql47-inspect-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-prod-sql70-grant-a2a4` | nodejs20.x | 0 | 2026-10-02 | yes |
| `checksops-prod-sql70-priv-inspect-a2a4` | nodejs20.x | 0 | 2026-10-02 | yes |
| `checksops-prod-ui-sig-fixture-ad99` | nodejs20.x | 0 | 2026-09-28 | yes |
| `checksops-prod-v2-live-collect-2d41` | nodejs22.x | 0 | 2026-09-29 | yes |
| `checksops-prod-v3-identity-inspect-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-prod-v3d-inspect-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-prod-v3e-inspect-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-prod-wallet-fund-recover-2d41` | nodejs20.x | 0 | 2026-09-30 | yes |
| `checksops-production-legacy-tenant-preflight` | nodejs22.x | 0 | 2026-09-24 | yes |
| `checksops-production-loss-draft-inspect-b5e0` | nodejs20.x | 0 | 2026-09-23 | yes |
| `checksops-production-loss-draft-view-apply-b5e0` | nodejs20.x | 0 | 2026-09-23 | yes |
| `checksops-production-loss-draft-view-verify-b5e0` | nodejs20.x | 0 | 2026-09-23 | yes |
| `checksops-production-tenant-onboard-59ff` | nodejs22.x | 0 | 2026-09-24 | yes |
| `checksops-production-workflow-grants-83c9` | nodejs20.x | 0 | 2026-09-24 | yes |
| `checksops-sql65-status-read-inspect-6136` | nodejs20.x | 0 | 2026-09-23 | yes |
| `checksops-staging-billing-verification-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-staging-c1c-share-inspect-46ac` | nodejs20.x | 0 | 2026-09-16 | yes |
| `checksops-staging-checkalt-config-diagnose-6136` | nodejs20.x | 0 | 2026-09-17 | yes |
| `checksops-staging-checkalt-ui-access-validate-6136` | nodejs20.x | 0 | 2026-09-17 | yes |
| `checksops-staging-external-recording-grants-83c9` | nodejs20.x | 0 | 2026-09-23 | yes |
| `checksops-staging-identity-inspect-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-staging-identity-preflight-6136` | nodejs20.x | 0 | 2026-09-21 | yes |
| `checksops-staging-loss-draft-inspect-b5e0` | nodejs20.x | 0 | 2026-09-23 | yes |
| `checksops-staging-loss-draft-view-apply-b5e0` | nodejs20.x | 0 | 2026-09-23 | yes |
| `checksops-staging-mde2e-identity-oneshot` | nodejs20.x | 0 | 2026-09-27 | yes |
| `checksops-staging-moov-billing-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-staging-moov-billing-dest-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-staging-moov-billing-inspect-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-staging-moov-billing-inspect-2d41-moov` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-staging-moov-billing-tenant-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-staging-mops-gate4-oneshot` | nodejs20.x | 0 | 2026-10-03 | yes |
| `checksops-staging-mortgage-desk-e2e-harness` | nodejs22.x | 0 | 2026-09-27 | yes |
| `checksops-staging-mortgage-ops-billing-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-staging-org-membership-diagnose-6136` | nodejs20.x | 0 | 2026-09-17 | yes |
| `checksops-staging-owner-relink-6136` | nodejs20.x | 0 | 2026-09-17 | yes |
| `checksops-staging-partner-integrity-3bce` | nodejs20.x | 0 | 2026-09-16 | yes |
| `checksops-staging-pending-sync-diagnose-6136` | nodejs20.x | 0 | 2026-09-17 | yes |
| `checksops-staging-pr129-sql70-3a4a` | nodejs20.x | 0 | 2026-09-05 | yes |
| `checksops-staging-pr235-sql69` | nodejs20.x | 0 | 2026-09-11 | yes |
| `checksops-staging-rehearsal-oneshot` | nodejs20.x | 0 | 2026-09-22 | yes |
| `checksops-staging-sig-check-file-ad99` | nodejs20.x | 0 | 2026-09-28 | yes |
| `checksops-staging-sql35-apply-6136` | nodejs20.x | 0 | 2026-09-17 | yes |
| `checksops-staging-sql38-apply-6136` | nodejs20.x | 0 | 2026-09-24 | yes |
| `checksops-staging-sql44-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-staging-sql44-seed-2d41` | nodejs20.x | 0 | 2026-09-25 | yes |
| `checksops-staging-synthetic-cleanup-83c9` | nodejs20.x | 0 | 2026-09-24 | yes |
| `checksops-staging-tenant-logo-fixture` | nodejs20.x | 0 | 2026-09-28 | yes |
| `checksops-staging-tenant-onboard-59ff` | nodejs20.x | 0 | 2026-09-24 | yes |
| `checksops-staging-v2-provider-collect-2d41` | nodejs20.x | 0 | 2026-09-29 | yes |
| `checksops-textract-parser-test-504e` | nodejs22.x | 0 | 2026-09-18 | no |

## Applied: step 4, SQL runner (2026-11-03)

Owner's phrase, verbatim: "start the production SQL runner for the Node upgrade". No SQL was run.

**Timeline (UTC):**
- **Start:** `StartInstances` at 12:20:26; `running` at 12:20:42.
- **Stop:** requested at 12:21:57; `stopped` at 12:22:29, reason "User initiated".
- Before starting, the runner was stopped, with no pending SSM commands.

**Before:** SSM command `fe8dd212-aebb-4899-a744-083b86409be9`.
- The default `node` was `v18.20.8` (`/usr/bin/node-18`, alternatives `auto`).
- `nodejs20` 20.20.2 was also installed, but not as the default.
- `nodejs22` 22.23.4 and `nodejs24` 24.22.1 were available from the `amazonlinux` repository.
- The root disk had 2.0 GB free.
- **Baseline:** the most recently staged main tarball, `source-a58f492c…`, staged 2026-11-02 17:22. Its sha256 `7cb66c8f…` matched its sidecar. Extracted into a fresh directory, `node --test aws/tests/production-sql-one-shot.test.mjs` passed 54 of 54 on Node 18.

**Change:** SSM command `6a997c0a-c3c0-4468-86c4-f1209dffbf6a`.
- `dnf install -y nodejs22` installed `nodejs22`, `nodejs22-libs`, `nodejs22-docs`, `nodejs22-full-i18n` and `nodejs22-npm` 22.23.4 (217 MB installed).
- `alternatives --set node /usr/bin/node-22`.

**After:**
- The default `node` is `v22.23.4` (`/usr/bin/node-22`, alternatives `manual`). `node-18` is still installed for rollback.
- **Tests:** the same one-shot suite passed 54 of 54 on Node 22.
- **Dependencies:** `pg` 8.23.0 loads.
- **Identity:** `assumed-role/ChecksOpsSql53TemporaryRunner/i-0c35557c4e5385406`.
- **Network:** the Secrets Manager endpoint is reachable on 443.
- **Database:** SSM command `d28a0230-15f7-4548-a31a-d8a4872b1d41`. The production endpoint `checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com` resolves to `172.31.75.86`, the primary's ENI in 1f, and is reachable on 5432. The first check in the change command used a hostname Claude had mistyped, and reported "NOT reachable". The re-check used the endpoint read from `describe-db-instances`.
- **Disk:** 1.8 GB free after the work directory was removed.

**Not run:** a real `--phase inspect`. No pin is executable, so the one-shot would refuse at step 1. The next production SQL run will be the first real use of the tool on Node 22.

**Unrelated command:** Inspector's automatic `AmazonInspector2-ConfigureInspectorSsmPlugin` (`a0438d29…`, 12:20:59) failed with `InvalidPlatform` on start, as it did before (see the hardening runbook, item 7). It changed nothing.

**Rollback:** `alternatives --set node /usr/bin/node-18`, in a runner session started on the owner's words.

**Still on the runner:** `nodejs` 18 and `nodejs20`, both end of life, kept installed but not the default. Removing them is a later step, once Node 22 has handled a real run.
