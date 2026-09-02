# Staging write-authorization live results

Run: temporary in-VPC Lambda `checksops-staging-write-plan-c48b` (deleted after this run). Connected as `checksops_admin` for DDL/probes only. **Global RLS remains off** on restored tables. Claims `org_id` was **not** backfilled. Users were **not** invited. Moov/CheckAlt were **not** called.

`ok: true`

## Claims ownership (live)

Matches dump analysis. Backfill not applied.

| Group | Count |
| --- | ---: |
| Total restored claims | 180 |
| `org_id` NULL | 180 |
| Deterministically assignable (Freedom only) | **83** |
| Ambiguous | **0** |
| No evidence | **97** |

Intake+ledger distribution: 81 Freedom claims. The other 2 assignable claims come from remaining tenant-keyed signals (`freedom_claim_id` / exact claim-number match / deposits / payments).

## Ninth UUID (live)

`dd24eea5-5d12-47d1-999e-d5930c278b7d`

- `identity_accounts`: pending, no Cognito sub, no email
- `user_roles`: admin + staff
- `role_version_tracker`: version 2 at 2026-08-26 16:37:57Z
- C1C W9 vetting upload pending (2 051 233 bytes, `application/pdf`)
- no profile, no `tenant_users`, no referrers, 0 audit rows, 0 check/claim file authorship
- `auth.users`: 0 restored rows

Not deleted, merged, invited, or given Cognito.

## Application role

| Check | Result |
| --- | --- |
| `GET /db-health` | `currentUser=checksops`, `currentDatabase=checksops`, `transactionReadOnly=on` |
| API `DATABASE_SECRET_ARN` | application `checksops` secret only |
| API IAM Policy4 | that secret only (no `checksops_admin` secret) |
| `checksops` superuser / `BYPASSRLS` | false / false |
| table owner `check_intake_items` | `checksops_admin` |
| `checksops` DML on restored intake | SELECT only |
| ALTER RLS / CREATE POLICY as `checksops` | denied (`must be owner`) |
| `checksops` member of `checksops_admin` | false (member of `authenticated` only) |

## Write policies prepared

12 `aws_write_*` policies. **165** `aws_select_*` policies unchanged. RLS enabled only on `_aws_rls_probe_items` and `_aws_rls_write_probe`.

## Transactional write tests (all rolled back)

`writeAuthorization.pass: true`. `persistedFinancialWrites: false`. `calledExternalProviders: false`. `rlsLeftEnabled: []`.

| Case | Result |
| --- | --- |
| Freedom staff insert probe | allow (n=1) |
| Freedom staff insert C1C probe | RLS deny |
| C1C admin insert C1C probe | allow |
| C1C admin insert Freedom probe | RLS deny |
| Ninth UUID insert | RLS deny |
| Unauthenticated insert | RLS deny |
| Cognito sub as `request.app_user_id` | RLS deny |
| Master owner insert C1C | allow |
| Staff delete own Freedom probe | allow |
| C1C admin delete Freedom seed | 0 rows |
| Staff update Freedom check | allow |
| C1C admin update Freedom check | 0 rows |
| Unauthenticated update Freedom check | 0 rows |
| Staff rekey Freedom check → C1C | RLS deny |
| C1C admin UUID-guess Freedom deposit | 0 rows |
| Staff update Freedom deposit | allow |
| Staff update C1C provider account | 0 rows |
| C1C admin update C1C provider | allow |
| Staff INSERT `payment_webhook_events` | RLS deny (no write policy) |
| C1C admin INSERT `payment_idempotency_keys` | RLS deny (no write policy) |
| Staff synthetic Freedom check INSERT | allow, rolled back |
| C1C admin synthetic Freedom check INSERT | RLS deny |

## Remaining blockers before global staging RLS

1. Review and optionally backfill the 83 Freedom `claims.org_id` values; leave the 97 unassigned NULL.
2. Prepare tenant-scoped write policies for the remaining **108** write tables (same helper pattern).
3. Move browser/edge open writes (CheckAlt, Moov, webhooks, branding, deposit automation, leads, signature completion) to server-side API authorization.
4. Do not GRANT INSERT/UPDATE/DELETE to `checksops` on restored tables until RLS is on (or keep API `default_transaction_read_only`).
5. Attach the 47 foreign keys only after orphan review.
6. Invite the 8 known users only after clearing the isolated probe mapping; do not invent email/Cognito for the ninth UUID.
7. Confirm `is_platform_owner()` once `checksopsadmin@gmail.com` exists as a mapped application user (currently false).

**STOP:** global RLS is still off. Production Lovable/Supabase, `main`, DNS, Moov, CheckAlt, and real payments were not touched.
