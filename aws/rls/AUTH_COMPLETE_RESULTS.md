# Staging authorization completion results

Live oneshot `checksops-staging-auth-complete-c48b` returned `ok: true`, then the Lambda and its admin-secret IAM role were deleted.

**Global RLS remains off** on restored tables (only `_aws_rls_probe_items` and `_aws_rls_write_probe`). Production users were not invited. Moov/CheckAlt/Plaid/Resend were not called. Ninth UUID has no Cognito identity.

## 83-claim backfill

Verified live mapping still **83 assignable / 0 ambiguous**, matching `claims_ownership.json`, then updated `claims.org_id` to Freedom `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`.

| | Before | After |
| --- | ---: | ---: |
| Claims | 180 | 180 |
| `org_id` NULL | 180 | **97** |
| Freedom `org_id` | 0 | **83** |
| Other tenants | 0 | 0 |
| Rows updated | — | **83** |
| Unassigned claims touched | — | **0** |

Evidence unused: `created_by`, `uploaded_by`, folder names, admin roles.

## 97 unassigned claims

Still `org_id` NULL. Tenant staff/admin SELECT and UPDATE return 0. Master owner SELECT sees all 97 (and 7 predefined folders per claim). `aws_can_access_claim` requires non-null `org_id` unless `aws_is_cross_tenant_reader()`.

## Policy counts

| Kind | Count |
| --- | ---: |
| `aws_select_*` | **165** (unchanged) |
| `aws_write_*` | **127** (12 representative + 108 tenant-scoped + 7 platform-owner) |
| Dump leftover policies | **0** |
| Server-side API (no write policy) | **13** |
| Obsolete (no write policy) | **2** |

## 47 FK retargets

Orphan scan: **0** distinct missing UUIDs. Ninth UUID is in `identity_accounts` (`cognito_sub` still null). All 47 FKs now reference `identity_accounts(application_user_id)`, VALIDATE succeeded. One dump name exceeded Postgres’ 63-character identifier limit and was shortened; the truncated leftover was dropped and replaced. No stored UUID values were rewritten.

## Transactional tests

Rollback-only. `authorizationTests.pass: true`. `persistedFinancialWrites: false`. `rlsLeftEnabled: []`.

Same-tenant Freedom staff: 83 claims, check/deposit writes allowed. C1C admin: 0 Freedom claims, cross-tenant writes denied. Ninth / unauthenticated / Cognito sub: 0. Master: 180 claims including 97 NULL. UUID-guess deposit/check updates denied. Webhook and CheckAlt writes denied for staff and master. Branding: staff denied, master allowed. `checksops` remains SELECT-only, not `BYPASSRLS`, not table owner.

`GET /db-health`: `currentUser=checksops`, `currentDatabase=checksops`, `transactionReadOnly=on`.

## Is global staging RLS safe to enable?

**No.** Remaining work: invite the 8 known users (after clearing the probe mapping), decide the ninth UUID without fabricating email/Cognito, move browser CheckAlt/Moov/webhook writes fully onto API execution that does not use `checksops` table DML while RLS is off, and run a dedicated enablement window. Prepared policies and FKs are in place, but this phase explicitly **stops before ENABLE ROW LEVEL SECURITY** on restored tables.
