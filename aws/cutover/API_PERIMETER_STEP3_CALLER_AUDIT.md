# Step 3 raw execute-api caller audit

**Result: FAIL** — AWS-managed caller inventory is incomplete.

Inspected **2026-09-08T16:14Z–16:20Z** as
`ChecksOpsCursorCloudStaging/checksops-t0-run`. Read-only. No callers were
modified. Staging was **not** broadened.

Do **not** start Gate 3A–3C until an operator finishes the denied lists below
and this audit is re-scored **PASS**.

Hostname under review:
`kiqojucc02.execute-api.us-east-1.amazonaws.com`

---

## Verdict

| Scope | Result |
|---|---|
| Repo / runtime config | No production **runtime** dependency except CloudFront origin (required) |
| Lambda env / invoke policies / event sources | No extra callers |
| Secrets Manager **names** | No origin-verify secret; no hostname in names |
| Live SPA bundle | No hostname |
| EventBridge rules / targets / API Destinations / connections | **NOT LISTABLE** (AccessDenied) |
| EventBridge Scheduler | **NOT LISTABLE** (AccessDenied) |
| CloudWatch Synthetics canaries | **NOT LISTABLE** (AccessDenied) |
| CloudWatch alarms | **NOT LISTABLE** (AccessDenied) |
| SSM parameters, Step Functions, ECS, Route53 health checks, SNS, SQS | **NOT LISTABLE** (AccessDenied) |

Overall: **FAIL**. Cannot prove that no production AWS-managed service
currently depends on the raw execute-api hostname.

---

## Actual runtime dependencies found

| Dependency | Kind | Action before require-mode |
|---|---|---|
| CloudFront `E1B0ZWWO5559U5` origin `ProductionPrepHttpApi` | **Required** runtime. Domain is the execute-api hostname. Custom headers **0**. | Keep execute-api **enabled**. Gate 3B injects the origin header. |
| HTTP API `kiqojucc02` → Lambda `checksops-production-prep-api` | Required. Resource policy SourceArn `...:kiqojucc02/*` only. | Authorizer attaches here later. |
| Browser SPA | **None.** Live bundle `/assets/index-reP2FWHf.js` (885373 bytes) has **no** `kiqojucc02` and **no** `execute-api.us-east-1.amazonaws.com`. Same-origin `/prep`. | None. |
| Production scheduled jobs | **None found.** Prep Lambda has no `AWS_SCHEDULED_JOB_SECRET`. Event source mappings **[]**. No Lambda URLs. | Operator must still list EventBridge/Scheduler. |
| Staging HTTP API `psr19uhop4` | Separate API. Integrations point at `checksops-staging-api` only. | Do not treat as production caller. |
| Provider webhooks | Production URLs remain on Supabase. AWS dry-run. | Future AWS webhook URLs must use `https://checksops.com/prep`. |

Five Lambdas exist. **No** function environment value contained
`kiqojucc02` or `execute-api.us-east-1.amazonaws.com` (values were scanned
for those substrings only; secret values were not printed).

Secret **names** only: RDS staging creds, `checksops/staging/providers`,
`checksops/staging/storage-migration-token`,
`checksops/staging/master-uat-password`. No
`checksops/production/cloudfront-origin-verify`.

No REST APIs. No `/aws/synthetics` or `/aws/lambda/cwsyn` log groups. No
`/aws/events` or `/aws/scheduler` log groups. That is supporting evidence,
not proof.

---

## Documentation / test / operator references (not runtime)

These mention `kiqojucc02` or the raw hostname and are **not** AWS-managed
callers:

- `aws/cutover/API_BEHIND_CLOUDFRONT_STEP3_DESIGN.md` and this audit
- Step 3 IAM templates (`kiqojucc02` API ARN only)
- `.env.production.aws.example` (commented example; **not** shipped Vite)
- `aws/production/LIVE_RESOURCES.md`, `README.md`, `waf-api.yaml`
- `aws/cutover/MONITORING.md`, `CUTOVER_READINESS_MATRIX.md`
- `aws/tests/cutover-readiness.test.mjs`

Operator curls of raw `/prep/health` and `/prep/ops/readiness` will fail
after Gate 3D require-mode. Switch those docs to CloudFront **before** 3D.
Do not change them in this package.

Staging scripts default to `psr19uhop4` `/staging`, not `kiqojucc02`.

---

## Denied from staging (must be finished by an operator)

| API | Error |
|---|---|
| `events:ListRules` / `ListEventBuses` / `ListApiDestinations` / `ListConnections` | AccessDenied |
| `scheduler:ListSchedules` | AccessDenied |
| `synthetics:DescribeCanaries` | AccessDenied |
| `cloudwatch:DescribeAlarms` | AccessDenied |
| `ssm:DescribeParameters` | AccessDenied |
| `states:ListStateMachines` | AccessDenied |
| `ecs:ListClusters` | AccessDenied |
| `route53:ListHealthChecks` | AccessDenied |
| `pipes:ListPipes` | AccessDenied |

**Smallest operator action (no new role required):** in the AWS Console or a
privileged read-only CLI session, list the services above in `us-east-1` and
search results for `kiqojucc02` and
`execute-api.us-east-1.amazonaws.com`. Record **zero** production hits
(CloudFront origin is already known). Do **not** broaden
`ChecksOpsCursorCloudStaging`.

Optional Cursor OIDC read-only role template (do **not** create this turn):
`aws/production/cursor-api-perimeter-step3-audit-role.yaml`
(`DeployRole` default `false`). Name
`ChecksOpsCursorApiPerimeterStep3AuditTemp`. List/describe only. No writes.
No `GetSecretValue`. No `GetParameter`.

---

## Holds at audit time

`/prep/ops/readiness` `holds.ok=true`.
`/prep/financial/status` `productionExecution=false`.
Moov / CheckAlt / Plaid / Actum / QBO / provider execution / live reads /
financial permissions / sandbox **false**.
`financialActivationSqlApplied=false`.
`64_financial_activation_grants.sql` **NOT_APPLIED**.
Raw execute-api `/prep/health` still 200.
